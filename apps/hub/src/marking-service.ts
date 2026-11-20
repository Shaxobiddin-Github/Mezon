import {
  type LocalSqliteConnection,
  type SqliteCartStore,
  type SqliteCatalogStore,
  findActiveMarkSync,
  insertCartMarkSync,
  isMarkedMxik,
  listCartMarksSync,
  readMarkingPrefixesSync,
} from '@mezon/db-local';
import {
  DomainError,
  type UnixMs,
  type UuidV7,
  gtinToEan13,
  looksLikeMarkingCode,
  parseMarkingCode,
  quantityFromMilli,
  quantityToMilli,
} from '@mezon/domain';
import { type MarkingDriver, MarkingUnavailableError } from '@mezon/drivers';

export interface MarkingContext {
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7;
}

/**
 * T3.7 marking codes at the cash register:
 * - a scanned DataMatrix is parsed (GS1), its product found by GTIN → EAN-13 in the catalog;
 * - goods whose MXIK is in the configured list need one code per unit; a code may be in one open
 *   cart only and never sold twice (local UNIQUE + the operator's `already_sold`);
 * - the operator check runs OUTSIDE any SQLite write transaction; when the operator is
 *   unreachable the code is kept as `unchecked` (offline is the fallback mode, §3.3);
 * - the cart line quantity follows the codes; `completeSale` enforces codes = units.
 * An EAN barcode is not a marking code: the ordinary scan path is not touched.
 */
export class HubMarkingService {
  constructor(
    private readonly o: {
      readonly connection: LocalSqliteConnection;
      readonly cartStore: SqliteCartStore;
      readonly catalogStore: SqliteCatalogStore;
      readonly driver: MarkingDriver;
      readonly getContext: () => MarkingContext | null;
      readonly nowMs: () => UnixMs;
      readonly nextId: () => UuidV7;
    },
  ) {}

  private ctx(): MarkingContext {
    const c = this.o.getContext();
    if (c === null) throw new DomainError('AUTH_UNAUTHORIZED', 'Hub setup has not been completed');
    return c;
  }

  listMarks(cartId: UuidV7) {
    return listCartMarksSync(this.o.connection.sqlite, cartId);
  }

  async scan(cartId: UuidV7, raw: string) {
    const ctx = this.ctx();
    if (!looksLikeMarkingCode(raw)) {
      throw new DomainError('MARKING_CODE_INVALID', 'Not a marking code (use the barcode scan)');
    }
    const parsed = parseMarkingCode(raw);
    const hit =
      (await this.o.catalogStore.scanBarcode(gtinToEan13(parsed.gtin) ?? parsed.gtin)) ??
      (await this.o.catalogStore.scanBarcode(parsed.gtin));
    if (hit === null) {
      throw new DomainError('PRODUCT_NOT_FOUND', 'No product has this GTIN as a barcode');
    }
    const product = hit.product;
    const sqlite = this.o.connection.sqlite;
    if (!isMarkedMxik(product.mxik, readMarkingPrefixesSync(sqlite))) {
      throw new DomainError('MARKING_NOT_REQUIRED', 'This product does not need a marking code');
    }
    const cart = await this.o.cartStore.getCart(cartId); // open cart of this store or an error
    const taken = findActiveMarkSync(sqlite, ctx.organizationId, parsed.key);
    if (taken === 'cart') {
      throw new DomainError('MARKING_CODE_DUPLICATE', 'This marking code is already in a cart');
    }
    if (taken === 'sale') {
      throw new DomainError('MARKING_CODE_ALREADY_SOLD', 'This marking code was already sold');
    }

    let checkStatus: 'ok' | 'unchecked' = 'ok';
    try {
      const r = await this.o.driver.check({
        gtin: parsed.gtin,
        serial: parsed.serial,
        code: parsed.normalized,
        mxik: product.mxik,
      });
      if (r.status === 'mismatch') {
        throw new DomainError(
          'MARKING_CODE_MISMATCH',
          'The code belongs to another product (MXIK)',
        );
      }
      if (r.status === 'already_sold') {
        throw new DomainError(
          'MARKING_CODE_ALREADY_SOLD',
          'The operator reports this code as sold',
        );
      }
      if (r.status === 'unknown_code') {
        throw new DomainError('MARKING_CODE_INVALID', 'The operator does not know this code');
      }
    } catch (err) {
      if (!(err instanceof MarkingUnavailableError)) throw err;
      checkStatus = 'unchecked';
    }

    const existing = cart.lines.find(
      (l) => l.lineKind === 'catalog' && l.productId === product.id && l.variantId === null,
    );
    const insertMark = (cartLineId: UuidV7) =>
      insertCartMarkSync(sqlite, {
        id: this.o.nextId(),
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        cartId,
        cartLineId,
        productId: product.id,
        codeKey: parsed.key,
        gtin: parsed.gtin,
        serial: parsed.serial,
        code: parsed.normalized,
        checkStatus,
        nowMs: this.o.nowMs(),
      });
    if (existing) {
      insertMark(existing.id);
      try {
        await this.o.cartStore.updateLine(cartId, existing.id, {
          qty: quantityFromMilli(quantityToMilli(existing.qty) + 1000n),
        });
      } catch (err) {
        sqlite
          .prepare('DELETE FROM local_cart_marks WHERE code_key = ? AND cart_id = ?')
          .run(parsed.key, cartId);
        throw err;
      }
    } else {
      const added = await this.o.cartStore.addLine(cartId, {
        kind: 'catalog',
        productId: product.id,
        variantId: null,
        qty: quantityFromMilli(1000n),
      });
      const line = added.lines.find((l) => l.productId === product.id && l.variantId === null)!;
      try {
        insertMark(line.id);
      } catch (err) {
        await this.o.cartStore.removeLine(cartId, line.id);
        throw err;
      }
    }
    return { cart: await this.o.cartStore.getCart(cartId), checkStatus, codeKey: parsed.key };
  }

  /** Removes one code; the line loses one unit (or disappears with its last code). */
  async removeMark(cartId: UuidV7, markId: UuidV7) {
    const sqlite = this.o.connection.sqlite;
    const row = sqlite
      .prepare('SELECT cart_line_id AS l FROM local_cart_marks WHERE id = ? AND cart_id = ?')
      .get(markId, cartId) as { l: UuidV7 } | undefined;
    if (!row) throw new DomainError('VALIDATION_ERROR', 'Marking code not in this cart');
    const cart = await this.o.cartStore.getCart(cartId);
    const line = cart.lines.find((l) => l.id === row.l);
    sqlite.prepare('DELETE FROM local_cart_marks WHERE id = ?').run(markId);
    if (line) {
      const qty = quantityToMilli(line.qty);
      if (qty > 1000n) {
        await this.o.cartStore.updateLine(cartId, line.id, { qty: quantityFromMilli(qty - 1000n) });
      } else {
        await this.o.cartStore.removeLine(cartId, line.id);
      }
    }
    return { cart: await this.o.cartStore.getCart(cartId) };
  }
}
