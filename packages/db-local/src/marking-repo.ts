import { DomainError, type UnixMs, type UuidV7, markedUnitsFromQtyMilli } from '@mezon/domain';
import type { LocalSqliteConnection } from './connection.js';

type SqliteLike = LocalSqliteConnection['sqlite'];

/** T3.7 [TASDIQLANSIN] MXIK prefixes whose goods need one marking code per unit. */
export function readMarkingPrefixesSync(sqlite: SqliteLike): readonly string[] {
  const row = sqlite
    .prepare('SELECT marking_mxik_prefixes_json AS j FROM local_hub_config LIMIT 1')
    .get() as { j: string } | undefined;
  if (!row) return [];
  try {
    const parsed: unknown = JSON.parse(row.j);
    return Array.isArray(parsed)
      ? parsed.filter((p): p is string => typeof p === 'string' && p.length > 0)
      : [];
  } catch {
    return [];
  }
}

export function isMarkedMxik(mxik: string | null, prefixes: readonly string[]): boolean {
  return mxik !== null && prefixes.some((p) => mxik.startsWith(p));
}

export interface CartMarkRow {
  readonly id: UuidV7;
  readonly cartLineId: UuidV7;
  readonly codeKey: string;
  readonly checkStatus: 'ok' | 'unchecked';
}

/** Where a code is currently "taken": an open cart or an unreleased sale. */
export function findActiveMarkSync(
  sqlite: SqliteLike,
  organizationId: UuidV7,
  codeKey: string,
): 'cart' | 'sale' | null {
  if (
    sqlite
      .prepare('SELECT 1 FROM local_cart_marks WHERE organization_id = ? AND code_key = ?')
      .get(organizationId, codeKey)
  ) {
    return 'cart';
  }
  if (
    sqlite
      .prepare(
        'SELECT 1 FROM local_sale_marks WHERE organization_id = ? AND code_key = ? AND released_at_ms IS NULL',
      )
      .get(organizationId, codeKey)
  ) {
    return 'sale';
  }
  return null;
}

export function insertCartMarkSync(
  sqlite: SqliteLike,
  m: {
    readonly id: UuidV7;
    readonly organizationId: UuidV7;
    readonly storeId: UuidV7;
    readonly cartId: UuidV7;
    readonly cartLineId: UuidV7;
    readonly productId: UuidV7;
    readonly codeKey: string;
    readonly gtin: string;
    readonly serial: string;
    readonly code: string;
    readonly checkStatus: 'ok' | 'unchecked';
    readonly nowMs: UnixMs;
  },
): void {
  // P2-K3: check and insert in ONE transaction. A code sold by another terminal while the operator
  // check was running is refused here, and the refusal leaves no row behind.
  sqlite.transaction(() => {
    if (findActiveMarkSync(sqlite, m.organizationId, m.codeKey) === 'sale') {
      throw new DomainError('MARKING_CODE_ALREADY_SOLD', 'This marking code was already sold');
    }
    insertCartMarkRowSync(sqlite, m);
  })();
}

function insertCartMarkRowSync(
  sqlite: SqliteLike,
  m: Parameters<typeof insertCartMarkSync>[1],
): void {
  try {
    sqlite
      .prepare(
        `INSERT INTO local_cart_marks (id, organization_id, store_id, created_at_ms, updated_at_ms,
           cart_id, cart_line_id, product_id, code_key, gtin, serial, code, check_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.id,
        m.organizationId,
        m.storeId,
        m.nowMs,
        m.nowMs,
        m.cartId,
        m.cartLineId,
        m.productId,
        m.codeKey,
        m.gtin,
        m.serial,
        m.code,
        m.checkStatus,
      );
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) {
      throw new DomainError('MARKING_CODE_DUPLICATE', 'This marking code is already in a cart');
    }
    throw err;
  }
}

export function listCartMarksSync(sqlite: SqliteLike, cartId: UuidV7): readonly CartMarkRow[] {
  return (
    sqlite
      .prepare(
        'SELECT id, cart_line_id, code_key, check_status FROM local_cart_marks WHERE cart_id = ? ORDER BY created_at_ms, id',
      )
      .all(cartId) as {
      id: UuidV7;
      cart_line_id: UuidV7;
      code_key: string;
      check_status: 'ok' | 'unchecked';
    }[]
  ).map((r) => ({
    id: r.id,
    cartLineId: r.cart_line_id,
    codeKey: r.code_key,
    checkStatus: r.check_status,
  }));
}

/**
 * Inside `completeSale`'s transaction: a marked line must carry exactly one code per unit; the
 * codes move from the cart to the sale (sold) atomically with the receipt.
 */
export function consumeCartMarksForSaleLineInTxSync(
  sqlite: SqliteLike,
  p: {
    readonly organizationId: UuidV7;
    readonly storeId: UuidV7;
    readonly cartId: UuidV7 | null;
    readonly cartLineId: UuidV7;
    readonly saleId: UuidV7;
    readonly saleLineId: UuidV7;
    readonly productId: UuidV7;
    readonly qtyMilli: bigint;
    readonly nowMs: UnixMs;
    readonly nextId: () => UuidV7;
  },
): number {
  const units = markedUnitsFromQtyMilli(p.qtyMilli);
  const marks =
    p.cartId === null
      ? []
      : (sqlite
          .prepare(
            'SELECT * FROM local_cart_marks WHERE cart_id = ? AND cart_line_id = ? ORDER BY created_at_ms, id',
          )
          .all(p.cartId, p.cartLineId) as Record<string, unknown>[]);
  if (units === null || BigInt(marks.length) !== units) {
    throw new DomainError(
      'MARKING_CODES_INCOMPLETE',
      'A marked product needs exactly one marking code per unit',
      {
        details: {
          productId: p.productId,
          units: units === null ? null : units.toString(),
          codes: marks.length,
        },
      },
    );
  }
  const insert = sqlite.prepare(
    `INSERT INTO local_sale_marks (id, organization_id, store_id, created_at_ms, updated_at_ms,
       sale_id, sale_line_id, product_id, code_key, gtin, serial, code, check_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const m of marks) {
    insert.run(
      p.nextId(),
      p.organizationId,
      p.storeId,
      p.nowMs,
      p.nowMs,
      p.saleId,
      p.saleLineId,
      p.productId,
      m.code_key,
      m.gtin,
      m.serial,
      m.code,
      m.check_status,
    );
  }
  sqlite
    .prepare('DELETE FROM local_cart_marks WHERE cart_id = ? AND cart_line_id = ?')
    .run(p.cartId, p.cartLineId);
  return marks.length;
}

/** Void / return: the units are back, their codes may be sold again. Oldest codes first. */
export function releaseSaleMarksInTxSync(
  sqlite: SqliteLike,
  p: {
    readonly saleId: UuidV7;
    readonly saleLineId: UuidV7 | null;
    readonly limit: bigint | null;
    readonly reason: 'void' | 'return';
    readonly sourceId: UuidV7;
    readonly nowMs: UnixMs;
  },
): number {
  const rows = sqlite
    .prepare(
      `SELECT id FROM local_sale_marks
        WHERE sale_id = ? AND released_at_ms IS NULL ${p.saleLineId === null ? '' : 'AND sale_line_id = ?'}
        ORDER BY created_at_ms, id ${p.limit === null ? '' : 'LIMIT ?'}`,
    )
    .all(
      ...([p.saleId, p.saleLineId, p.limit === null ? undefined : Number(p.limit)].filter(
        (v) => v !== null && v !== undefined,
      ) as (string | number)[]),
    ) as { id: string }[];
  const upd = sqlite.prepare(
    `UPDATE local_sale_marks SET released_at_ms = ?, released_reason = ?, release_source_id = ?, updated_at_ms = ?
      WHERE id = ?`,
  );
  for (const r of rows) upd.run(p.nowMs, p.reason, p.sourceId, p.nowMs, r.id);
  return rows.length;
}
