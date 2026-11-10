import {
  type BarcodeFormat,
  DomainError,
  type Money,
  type ProductUnit,
  type Quantity,
  type UnixMs,
  type UuidV7,
  type VatRate,
  buildFtsPrefixQuery,
  canonicalizeVariantAttributes,
  moneyFromTiyin,
  normalizeCatalogDisplayName,
  normalizeCatalogSearchText,
  normalizeCatalogSku,
  normalizeFiscalCode,
  normalizePriceChangeReason,
  parseProductUnit,
  parseUuidV7,
  parseVariantAttributesJson,
  prepareBarcodeForStorage,
  buildScanBarcodeCandidates,
  quantityFromMilli,
  tokenizeCatalogSearchQuery,
  validateNonNegativeSalePrice,
  validateQuantityForUnit,
  vatRateFromBasisPoints,
} from '@mezon/domain';
import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { LocalSqliteConnection } from './connection.js';
import {
  categories,
  priceChanges,
  productBarcodes,
  productVariants,
  products,
} from './schema/index.js';
import {
  type SqliteUnitOfWork,
  type SqliteUnitOfWorkSession,
  runConnectionProjectionMaintenance,
} from './uow.js';
import { insertAttr, insertFact, tombstoneAttr, updateAttr } from './writers.js';

export interface CatalogRuntimeContext {
  readonly uow: SqliteUnitOfWork;
  readonly organizationId: UuidV7;
}

export interface CreateSqliteCatalogStoreOptions {
  readonly connection: LocalSqliteConnection;
  readonly getRuntimeContext: () => CatalogRuntimeContext | null;
}

export interface StoredCategoryRecord {
  readonly id: UuidV7;
  readonly organizationId: UuidV7;
  readonly name: string;
  readonly parentId: UuidV7 | null;
  readonly sortOrder: number;
  readonly createdAtMs: UnixMs;
  readonly updatedAtMs: UnixMs;
}

export interface StoredProductRecord {
  readonly id: UuidV7;
  readonly organizationId: UuidV7;
  readonly categoryId: UuidV7 | null;
  readonly sku: string | null;
  readonly name: string;
  readonly unit: ProductUnit;
  readonly unlimited: boolean;
  readonly minStock: Quantity | null;
  readonly hasVariants: boolean;
  readonly salePrice: Money;
  readonly mxik: string | null;
  readonly packageCode: string | null;
  readonly vatRateBp: number;
  readonly createdAtMs: UnixMs;
  readonly updatedAtMs: UnixMs;
}

export interface StoredProductVariantRecord {
  readonly id: UuidV7;
  readonly organizationId: UuidV7;
  readonly productId: UuidV7;
  readonly name: string;
  readonly sku: string | null;
  readonly attributes: Readonly<Record<string, string>>;
  readonly salePrice: Money | null;
  readonly effectiveSalePrice: Money;
  readonly createdAtMs: UnixMs;
  readonly updatedAtMs: UnixMs;
}

export interface StoredProductBarcodeRecord {
  readonly id: UuidV7;
  readonly organizationId: UuidV7;
  readonly productId: UuidV7;
  readonly variantId: UuidV7 | null;
  readonly barcode: string;
  readonly format: BarcodeFormat;
  readonly createdAtMs: UnixMs;
  readonly updatedAtMs: UnixMs;
}

export interface StoredPriceChangeRecord {
  readonly id: UuidV7;
  readonly organizationId: UuidV7;
  readonly productId: UuidV7;
  readonly variantId: UuidV7 | null;
  readonly oldPrice: Money | null;
  readonly newPrice: Money;
  readonly changedByUserId: UuidV7;
  readonly reason: string | null;
  readonly createdAtMs: UnixMs;
}

export interface StoredProductDetailRecord {
  readonly product: StoredProductRecord;
  readonly variants: readonly StoredProductVariantRecord[];
  readonly barcodes: readonly StoredProductBarcodeRecord[];
}

export interface StoredBarcodeScanResult {
  readonly product: StoredProductRecord;
  readonly variant: StoredProductVariantRecord | null;
  readonly barcode: StoredProductBarcodeRecord;
  readonly quantity: null;
}

export interface ListProductsFilter {
  readonly q?: string;
  readonly categoryId?: UuidV7;
  readonly limit?: number;
  readonly offset?: number;
}

export interface ListProductsPageResult {
  readonly products: readonly StoredProductRecord[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface RebuildCatalogSearchResult {
  readonly categoriesUpdated: number;
  readonly productsUpdated: number;
  readonly variantsUpdated: number;
  readonly ftsIndexedCount: number;
}

function toStoredCategory(row: typeof categories.$inferSelect): StoredCategoryRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    parentId: row.parentId,
    sortOrder: row.sortOrder,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

function toStoredProduct(row: typeof products.$inferSelect): StoredProductRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    categoryId: row.categoryId,
    sku: row.sku,
    name: row.name,
    unit: parseProductUnit(row.unit),
    unlimited: Boolean(row.unlimited),
    minStock: row.minStock,
    hasVariants: Boolean(row.hasVariants),
    salePrice: row.salePrice,
    mxik: row.mxik,
    packageCode: row.packageCode,
    vatRateBp: row.vatRateBp,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

function toStoredVariant(
  row: typeof productVariants.$inferSelect,
  parentSalePrice: Money,
): StoredProductVariantRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    productId: row.productId,
    name: row.name,
    sku: row.sku,
    attributes: parseVariantAttributesJson(row.attributesJson),
    salePrice: row.salePrice,
    effectiveSalePrice: row.salePrice ?? parentSalePrice,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

function toStoredBarcode(row: typeof productBarcodes.$inferSelect): StoredProductBarcodeRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    productId: row.productId,
    variantId: row.variantId,
    barcode: row.barcode,
    format: row.format as BarcodeFormat,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

function toStoredPriceChange(row: typeof priceChanges.$inferSelect): StoredPriceChangeRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    productId: row.productId,
    variantId: row.variantId,
    oldPrice: row.oldPrice,
    newPrice: row.newPrice,
    changedByUserId: row.changedByUserId,
    reason: row.reason,
    createdAtMs: row.createdAtMs,
  };
}

function isSqliteUniqueConstraintError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const code = (err as { readonly code?: unknown }).code;
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

function parseMoneyBigIntString(raw: string, label: string): Money {
  if (!/^\d+$/.test(raw)) {
    throw new DomainError('VALIDATION_ERROR', `${label} must be a non-negative integer string`);
  }
  return validateNonNegativeSalePrice(moneyFromTiyin(BigInt(raw)), label);
}

function parseQuantityBigIntString(raw: string): Quantity {
  if (!/^\d+$/.test(raw)) {
    throw new DomainError(
      'INVALID_UNIT_QUANTITY',
      'Quantity must be a non-negative integer string',
    );
  }
  return quantityFromMilli(BigInt(raw));
}

function parseVatRateBp(raw: number | undefined): number {
  if (raw === undefined) {
    return 0;
  }
  if (!Number.isSafeInteger(raw)) {
    throw new DomainError('INVALID_VAT_RATE', 'VAT rate basis points must be a safe integer');
  }
  const vatRate: VatRate = vatRateFromBasisPoints(BigInt(raw));
  return Number(vatRate);
}

/**
 * Rebuilds derived catalog search projections (`name_search`, `sku_search`, and `products_fts`)
 * directly from authoritative `name`/`sku` columns inside an isolated transaction without emitting
 * outbox events (`T1.1` F4).
 */
export async function rebuildCatalogSearchIndex(
  connection: LocalSqliteConnection,
  organizationId?: UuidV7,
): Promise<RebuildCatalogSearchResult> {
  const validOrgId = organizationId !== undefined ? parseUuidV7(organizationId) : null;

  return runConnectionProjectionMaintenance(connection, (sqlite, db) => {
    let categoriesUpdated = 0;
    const catRows = validOrgId
      ? db.select().from(categories).where(eq(categories.organizationId, validOrgId)).all()
      : db.select().from(categories).all();

    const updCatStmt = sqlite.prepare('UPDATE "categories" SET "name_search" = ? WHERE "id" = ?');
    for (const row of catRows) {
      const nextSearch = normalizeCatalogSearchText(row.name);
      if (nextSearch !== row.nameSearch) {
        updCatStmt.run(nextSearch, row.id);
        categoriesUpdated += 1;
      }
    }

    let variantsUpdated = 0;
    const varRows = validOrgId
      ? db
          .select()
          .from(productVariants)
          .where(eq(productVariants.organizationId, validOrgId))
          .all()
      : db.select().from(productVariants).all();

    const updVarStmt = sqlite.prepare(
      'UPDATE "product_variants" SET "name_search" = ?, "sku_search" = ? WHERE "id" = ?',
    );
    for (const row of varRows) {
      const nextNameSearch = normalizeCatalogSearchText(row.name);
      const nextSkuSearch = row.sku !== null ? normalizeCatalogSearchText(row.sku) : null;
      if (nextNameSearch !== row.nameSearch || nextSkuSearch !== row.skuSearch) {
        updVarStmt.run(nextNameSearch, nextSkuSearch, row.id);
        variantsUpdated += 1;
      }
    }

    let productsUpdated = 0;
    const prodRows = validOrgId
      ? db.select().from(products).where(eq(products.organizationId, validOrgId)).all()
      : db.select().from(products).all();

    const updProdStmt = sqlite.prepare(
      'UPDATE "products" SET "name_search" = ?, "sku_search" = ? WHERE "id" = ?',
    );
    for (const row of prodRows) {
      const nextNameSearch = normalizeCatalogSearchText(row.name);
      const nextSkuSearch = row.sku !== null ? normalizeCatalogSearchText(row.sku) : null;
      if (nextNameSearch !== row.nameSearch || nextSkuSearch !== row.skuSearch) {
        updProdStmt.run(nextNameSearch, nextSkuSearch, row.id);
        productsUpdated += 1;
      }
    }

    // Clear and rebuild FTS5 virtual table strictly from active rows keyed by product_id UUID (F1 + F4)
    if (validOrgId !== null) {
      sqlite.prepare('DELETE FROM "products_fts" WHERE "organization_id" = ?').run(validOrgId);
      const info = sqlite
        .prepare(
          `INSERT INTO "products_fts" ("product_id", "organization_id", "name_search", "sku_search")
           SELECT "id", "organization_id", "name_search", COALESCE("sku_search", '')
           FROM "products"
           WHERE "organization_id" = ? AND "deleted_at_ms" IS NULL`,
        )
        .run(validOrgId);
      return {
        categoriesUpdated,
        productsUpdated,
        variantsUpdated,
        ftsIndexedCount: Number(info.changes),
      };
    }

    sqlite.prepare('DELETE FROM "products_fts"').run();
    const info = sqlite
      .prepare(
        `INSERT INTO "products_fts" ("product_id", "organization_id", "name_search", "sku_search")
         SELECT "id", "organization_id", "name_search", COALESCE("sku_search", '')
         FROM "products"
         WHERE "deleted_at_ms" IS NULL`,
      )
      .run();

    return {
      categoriesUpdated,
      productsUpdated,
      variantsUpdated,
      ftsIndexedCount: Number(info.changes),
    };
  });
}

export class SqliteCatalogStore {
  private readonly connection: LocalSqliteConnection;
  private readonly getRuntimeContext: () => CatalogRuntimeContext | null;

  constructor(options: CreateSqliteCatalogStoreOptions) {
    this.connection = options.connection;
    this.getRuntimeContext = options.getRuntimeContext;
  }

  private requireContext(): CatalogRuntimeContext {
    const ctx = this.getRuntimeContext();
    if (ctx === null) {
      throw new DomainError('AUTH_UNAUTHORIZED', 'Hub setup has not been completed');
    }
    return ctx;
  }

  async listCategories(): Promise<readonly StoredCategoryRecord[]> {
    const { uow, organizationId } = this.requireContext();
    return uow.runReadOnly(() => {
      const rows = this.connection.db
        .select()
        .from(categories)
        .where(and(eq(categories.organizationId, organizationId), isNull(categories.deletedAtMs)))
        .orderBy(asc(categories.sortOrder), asc(categories.nameSearch), asc(categories.id))
        .all();
      return Promise.resolve(rows.map(toStoredCategory));
    });
  }

  async createCategory(input: {
    readonly name: string;
    readonly parentId?: UuidV7 | null;
    readonly sortOrder?: number;
  }): Promise<StoredCategoryRecord> {
    const { uow, organizationId } = this.requireContext();
    const cleanName = normalizeCatalogDisplayName(input.name, 'Category name', 120);
    const nameSearch = normalizeCatalogSearchText(cleanName);
    const parentId = input.parentId ? parseUuidV7(input.parentId) : null;
    const sortOrder = input.sortOrder ?? 0;

    return uow.execute((session) => {
      if (parentId !== null) {
        this.requireActiveCategorySync(session, organizationId, parentId);
      }
      this.assertNoDuplicateCategorySiblingSync(session, organizationId, parentId, nameSearch);

      try {
        const res = insertAttr(session, categories, {
          organizationId,
          values: {
            name: cleanName,
            nameSearch,
            parentId,
            sortOrder,
          },
          eventType: 'category.created',
          schemaVersion: 1,
        });
        return Promise.resolve(toStoredCategory(res.row));
      } catch (err) {
        if (isSqliteUniqueConstraintError(err)) {
          throw new DomainError(
            'CATEGORY_ALREADY_EXISTS',
            `Category "${cleanName}" already exists under this parent`,
          );
        }
        throw err;
      }
    });
  }

  async updateCategory(
    categoryId: UuidV7,
    patch: {
      readonly name?: string;
      readonly parentId?: UuidV7 | null;
      readonly sortOrder?: number;
    },
  ): Promise<StoredCategoryRecord> {
    const { uow, organizationId } = this.requireContext();
    const targetId = parseUuidV7(categoryId);

    return uow.execute((session) => {
      const existing = this.requireActiveCategorySync(session, organizationId, targetId);
      const nextName =
        patch.name !== undefined
          ? normalizeCatalogDisplayName(patch.name, 'Category name', 120)
          : existing.name;
      const nextNameSearch =
        patch.name !== undefined ? normalizeCatalogSearchText(nextName) : existing.nameSearch;
      const nextParentId =
        patch.parentId !== undefined
          ? patch.parentId !== null
            ? parseUuidV7(patch.parentId)
            : null
          : existing.parentId;
      const nextSortOrder = patch.sortOrder ?? existing.sortOrder;

      if (nextParentId !== null) {
        this.assertNoCategoryCycleSync(session, organizationId, targetId, nextParentId);
      }
      this.assertNoDuplicateCategorySiblingSync(
        session,
        organizationId,
        nextParentId,
        nextNameSearch,
        targetId,
      );

      try {
        const res = updateAttr(session, categories, {
          id: targetId,
          organizationId,
          values: {
            name: nextName,
            nameSearch: nextNameSearch,
            parentId: nextParentId,
            sortOrder: nextSortOrder,
          },
          eventType: 'category.updated',
          schemaVersion: 1,
        });
        return Promise.resolve(toStoredCategory(res.row));
      } catch (err) {
        if (isSqliteUniqueConstraintError(err)) {
          throw new DomainError(
            'CATEGORY_ALREADY_EXISTS',
            `Category "${nextName}" already exists under this parent`,
          );
        }
        throw err;
      }
    });
  }

  async deleteCategory(categoryId: UuidV7): Promise<void> {
    const { uow, organizationId } = this.requireContext();
    const targetId = parseUuidV7(categoryId);

    await uow.execute((session) => {
      this.requireActiveCategorySync(session, organizationId, targetId);

      const childCat = session.db
        .select({ id: categories.id })
        .from(categories)
        .where(
          and(
            eq(categories.organizationId, organizationId),
            eq(categories.parentId, targetId),
            isNull(categories.deletedAtMs),
          ),
        )
        .limit(1)
        .all()[0];
      if (childCat) {
        throw new DomainError(
          'CATEGORY_IN_USE',
          'Cannot delete category while it still contains child categories',
        );
      }

      const childProduct = session.db
        .select({ id: products.id })
        .from(products)
        .where(
          and(
            eq(products.organizationId, organizationId),
            eq(products.categoryId, targetId),
            isNull(products.deletedAtMs),
          ),
        )
        .limit(1)
        .all()[0];
      if (childProduct) {
        throw new DomainError(
          'CATEGORY_IN_USE',
          'Cannot delete category while active products belong to it',
        );
      }

      tombstoneAttr(session, categories, {
        id: targetId,
        organizationId,
        eventType: 'category.deleted',
        schemaVersion: 1,
      });
      return Promise.resolve();
    });
  }

  async listProducts(filter: ListProductsFilter = {}): Promise<ListProductsPageResult> {
    const { uow, organizationId } = this.requireContext();
    const limit = filter.limit ?? 50;
    const offset = filter.offset ?? 0;
    const categoryId = filter.categoryId ? parseUuidV7(filter.categoryId) : undefined;
    const rawQuery = filter.q?.trim() ?? '';

    return uow.runReadOnly(() => {
      if (rawQuery.length === 0) {
        const conds = [eq(products.organizationId, organizationId), isNull(products.deletedAtMs)];
        if (categoryId !== undefined) {
          conds.push(eq(products.categoryId, categoryId));
        }

        const totalRow = this.connection.db
          .select({ count: sql<number>`count(*)` })
          .from(products)
          .where(and(...conds))
          .all()[0];
        const total = Number(totalRow?.count ?? 0);

        const rows = this.connection.db
          .select()
          .from(products)
          .where(and(...conds))
          .orderBy(asc(products.nameSearch), asc(products.id))
          .limit(limit)
          .offset(offset)
          .all();

        return Promise.resolve({
          products: rows.map(toStoredProduct),
          total,
          limit,
          offset,
        });
      }

      const tokens = tokenizeCatalogSearchQuery(rawQuery);
      if (tokens.length === 0) {
        // F2: symbol-only / punctuation-only queries return empty without error
        return Promise.resolve({
          products: [],
          total: 0,
          limit,
          offset,
        });
      }

      // 1-character single-token query hits covering B-tree prefix range on idx_products_org_name_search / sku
      const singleToken = tokens.length === 1 ? tokens[0] : undefined;
      if (singleToken !== undefined && singleToken.length === 1) {
        const ch = singleToken;
        const nextCh = String.fromCharCode(ch.charCodeAt(0) + 1);
        const prefixCond = or(
          and(gte(products.nameSearch, ch), lt(products.nameSearch, nextCh)),
          and(gte(products.skuSearch, ch), lt(products.skuSearch, nextCh)),
        );
        const conds = [
          eq(products.organizationId, organizationId),
          isNull(products.deletedAtMs),
          prefixCond,
        ];
        if (categoryId !== undefined) {
          conds.push(eq(products.categoryId, categoryId));
        }

        const totalRow = this.connection.db
          .select({ count: sql<number>`count(*)` })
          .from(products)
          .where(and(...conds))
          .all()[0];
        const total = Number(totalRow?.count ?? 0);

        const rows = this.connection.db
          .select()
          .from(products)
          .where(and(...conds))
          .orderBy(asc(products.nameSearch), asc(products.id))
          .limit(limit)
          .offset(offset)
          .all();

        return Promise.resolve({
          products: rows.map(toStoredProduct),
          total,
          limit,
          offset,
        });
      }

      // F1 + F2: FTS5 MATCH joined strictly on product_id UUID (never hidden rowid)
      const ftsExpr = buildFtsPrefixQuery(rawQuery);
      if (ftsExpr === null) {
        return Promise.resolve({ products: [], total: 0, limit, offset });
      }

      const sqlite = this.connection.sqlite;
      const categoryClause = categoryId !== undefined ? ' AND p."category_id" = ?' : '';
      const baseParams: unknown[] =
        categoryId !== undefined
          ? [ftsExpr, organizationId, categoryId]
          : [ftsExpr, organizationId];

      const hitsStmt = sqlite.prepare(
        `SELECT f."product_id" AS product_id
         FROM "products_fts" f
         INNER JOIN "products" p ON p."id" = f."product_id"
         WHERE f."products_fts" MATCH ?
           AND p."organization_id" = ?
           AND p."deleted_at_ms" IS NULL${categoryClause}
         ORDER BY f.rank ASC
         LIMIT ? OFFSET ?`,
      );
      const hitRows = hitsStmt.all(...baseParams, limit, offset) as ReadonlyArray<{
        readonly product_id: string;
      }>;

      let total: number;
      if (offset === 0 && hitRows.length < limit) {
        total = hitRows.length;
      } else {
        const countStmt = sqlite
          .prepare(
            `SELECT COUNT(*) AS total
             FROM "products_fts" f
             INNER JOIN "products" p ON p."id" = f."product_id"
             WHERE f."products_fts" MATCH ?
               AND p."organization_id" = ?
               AND p."deleted_at_ms" IS NULL${categoryClause}`,
          )
          .safeIntegers(false);
        const countRow = countStmt.get(...baseParams) as { readonly total: number } | undefined;
        total = countRow?.total ?? 0;
      }

      const hitIds = hitRows.map((h) => parseUuidV7(h.product_id));
      if (hitIds.length === 0) {
        return Promise.resolve({ products: [], total, limit, offset });
      }

      const hydrated = this.connection.db
        .select()
        .from(products)
        .where(
          and(
            eq(products.organizationId, organizationId),
            isNull(products.deletedAtMs),
            inArray(products.id, hitIds),
          ),
        )
        .all();
      const byId = new Map<UuidV7, StoredProductRecord>();
      for (const row of hydrated) {
        byId.set(row.id, toStoredProduct(row));
      }
      const ordered: StoredProductRecord[] = [];
      for (const id of hitIds) {
        const item = byId.get(id);
        if (item) {
          ordered.push(item);
        }
      }

      return Promise.resolve({
        products: ordered,
        total,
        limit,
        offset,
      });
    });
  }

  async getProductDetail(productId: UuidV7): Promise<StoredProductDetailRecord> {
    const { uow, organizationId } = this.requireContext();
    const targetId = parseUuidV7(productId);

    return uow.runReadOnly(() => {
      const prodRow = this.connection.db
        .select()
        .from(products)
        .where(
          and(
            eq(products.id, targetId),
            eq(products.organizationId, organizationId),
            isNull(products.deletedAtMs),
          ),
        )
        .limit(1)
        .all()[0];
      if (!prodRow) {
        throw new DomainError('PRODUCT_NOT_FOUND', `Product "${targetId}" was not found`);
      }

      const product = toStoredProduct(prodRow);
      const variantRows = this.connection.db
        .select()
        .from(productVariants)
        .where(
          and(
            eq(productVariants.organizationId, organizationId),
            eq(productVariants.productId, targetId),
            isNull(productVariants.deletedAtMs),
          ),
        )
        .orderBy(asc(productVariants.nameSearch), asc(productVariants.id))
        .all();

      const barcodeRows = this.connection.db
        .select()
        .from(productBarcodes)
        .where(
          and(
            eq(productBarcodes.organizationId, organizationId),
            eq(productBarcodes.productId, targetId),
            isNull(productBarcodes.deletedAtMs),
          ),
        )
        .orderBy(asc(productBarcodes.createdAtMs), asc(productBarcodes.id))
        .all();

      return Promise.resolve({
        product,
        variants: variantRows.map((v) => toStoredVariant(v, product.salePrice)),
        barcodes: barcodeRows.map(toStoredBarcode),
      });
    });
  }

  async createProduct(input: {
    readonly categoryId?: UuidV7 | null;
    readonly sku?: string | null;
    readonly name: string;
    readonly unit: ProductUnit;
    readonly unlimited?: boolean;
    readonly minStock?: string | null;
    readonly hasVariants?: boolean;
    readonly salePrice: string;
    readonly mxik?: string | null;
    readonly packageCode?: string | null;
    readonly vatRateBp?: number;
    readonly barcodes?: ReadonlyArray<{
      readonly barcode: string;
      readonly format?: BarcodeFormat;
    }>;
    readonly priceChangeReason?: string | null;
    readonly actorUserId: UuidV7;
  }): Promise<StoredProductDetailRecord> {
    const { uow, organizationId } = this.requireContext();
    const actorUserId = parseUuidV7(input.actorUserId);
    const categoryId = input.categoryId ? parseUuidV7(input.categoryId) : null;
    const sku = normalizeCatalogSku(input.sku);
    const skuSearch = sku !== null ? normalizeCatalogSearchText(sku) : null;
    const cleanName = normalizeCatalogDisplayName(input.name, 'Product name', 200);
    const nameSearch = normalizeCatalogSearchText(cleanName);
    const unit = parseProductUnit(input.unit);
    const unlimited = Boolean(input.unlimited ?? false);
    const hasVariants = Boolean(input.hasVariants ?? false);
    const salePrice = parseMoneyBigIntString(input.salePrice, 'Sale price');
    const minStock =
      input.minStock !== undefined && input.minStock !== null
        ? validateQuantityForUnit(unit, parseQuantityBigIntString(input.minStock), {
            allowZero: true,
          })
        : null;
    const mxik = normalizeFiscalCode(input.mxik, 'MXIK');
    const packageCode = normalizeFiscalCode(input.packageCode, 'Package code');
    const vatRateBp = parseVatRateBp(input.vatRateBp);
    const reason = normalizePriceChangeReason(input.priceChangeReason);

    const preparedBarcodes = (input.barcodes ?? []).map((b) =>
      prepareBarcodeForStorage(b.barcode, b.format),
    );
    const seenBatchBarcodes = new Set<string>();
    for (const b of preparedBarcodes) {
      if (seenBatchBarcodes.has(b.barcode)) {
        throw new DomainError(
          'BARCODE_ALREADY_EXISTS',
          `Duplicate barcode "${b.barcode}" in request`,
        );
      }
      seenBatchBarcodes.add(b.barcode);
    }

    return uow.execute((session) => {
      if (categoryId !== null) {
        this.requireActiveCategorySync(session, organizationId, categoryId);
      }
      if (sku !== null) {
        this.assertUniqueProductSkuSync(session, organizationId, sku);
      }
      for (const b of preparedBarcodes) {
        this.assertUniqueBarcodeSync(session, organizationId, b.barcode);
      }

      const prodRes = insertAttr(session, products, {
        organizationId,
        values: {
          categoryId,
          sku,
          skuSearch,
          name: cleanName,
          nameSearch,
          unit,
          unlimited,
          minStock,
          hasVariants,
          salePrice,
          mxik,
          packageCode,
          vatRateBp,
        },
        eventType: 'product.created',
        schemaVersion: 1,
      });

      const createdBarcodes: StoredProductBarcodeRecord[] = [];
      for (const b of preparedBarcodes) {
        const bcRes = insertAttr(session, productBarcodes, {
          organizationId,
          values: {
            productId: prodRes.entityId,
            variantId: null,
            barcode: b.barcode,
            format: b.format,
          },
          eventType: 'product_barcode.created',
          schemaVersion: 1,
        });
        createdBarcodes.push(toStoredBarcode(bcRes.row));
      }

      insertFact(session, priceChanges, {
        organizationId,
        values: {
          productId: prodRes.entityId,
          variantId: null,
          oldPrice: null,
          newPrice: salePrice,
          changedByUserId: actorUserId,
          reason: reason ?? 'initial_price',
        },
        eventType: 'price_change.recorded',
        schemaVersion: 1,
      });

      return Promise.resolve({
        product: toStoredProduct(prodRes.row),
        variants: [],
        barcodes: createdBarcodes,
      });
    });
  }

  async updateProduct(
    productId: UuidV7,
    patch: {
      readonly categoryId?: UuidV7 | null;
      readonly sku?: string | null;
      readonly name?: string;
      readonly unit?: ProductUnit;
      readonly unlimited?: boolean;
      readonly minStock?: string | null;
      readonly hasVariants?: boolean;
      readonly salePrice?: string;
      readonly mxik?: string | null;
      readonly packageCode?: string | null;
      readonly vatRateBp?: number;
      readonly priceChangeReason?: string | null;
      readonly actorUserId: UuidV7;
    },
  ): Promise<StoredProductRecord> {
    const { uow, organizationId } = this.requireContext();
    const targetId = parseUuidV7(productId);
    const actorUserId = parseUuidV7(patch.actorUserId);
    const reason = normalizePriceChangeReason(patch.priceChangeReason);

    return uow.execute((session) => {
      const existing = this.requireActiveProductSync(session, organizationId, targetId);

      const nextCategoryId =
        patch.categoryId !== undefined
          ? patch.categoryId !== null
            ? parseUuidV7(patch.categoryId)
            : null
          : existing.categoryId;
      if (nextCategoryId !== null) {
        this.requireActiveCategorySync(session, organizationId, nextCategoryId);
      }

      const nextSku = patch.sku !== undefined ? normalizeCatalogSku(patch.sku) : existing.sku;
      const nextSkuSearch =
        patch.sku !== undefined
          ? nextSku !== null
            ? normalizeCatalogSearchText(nextSku)
            : null
          : existing.skuSearch;

      if (nextSku !== null && nextSku !== existing.sku) {
        this.assertUniqueProductSkuSync(session, organizationId, nextSku, targetId);
      }

      const nextName =
        patch.name !== undefined
          ? normalizeCatalogDisplayName(patch.name, 'Product name', 200)
          : existing.name;
      const nextNameSearch =
        patch.name !== undefined ? normalizeCatalogSearchText(nextName) : existing.nameSearch;

      const nextUnit =
        patch.unit !== undefined ? parseProductUnit(patch.unit) : parseProductUnit(existing.unit);
      const nextUnlimited = patch.unlimited ?? Boolean(existing.unlimited);
      const nextHasVariants = patch.hasVariants ?? Boolean(existing.hasVariants);

      const rawNextMinStock =
        patch.minStock !== undefined
          ? patch.minStock !== null
            ? parseQuantityBigIntString(patch.minStock)
            : null
          : existing.minStock;
      const nextMinStock =
        rawNextMinStock !== null
          ? validateQuantityForUnit(nextUnit, rawNextMinStock, { allowZero: true })
          : null;

      const nextSalePrice =
        patch.salePrice !== undefined
          ? parseMoneyBigIntString(patch.salePrice, 'Sale price')
          : existing.salePrice;

      const nextMxik =
        patch.mxik !== undefined ? normalizeFiscalCode(patch.mxik, 'MXIK') : existing.mxik;
      const nextPackageCode =
        patch.packageCode !== undefined
          ? normalizeFiscalCode(patch.packageCode, 'Package code')
          : existing.packageCode;
      const nextVatRateBp =
        patch.vatRateBp !== undefined ? parseVatRateBp(patch.vatRateBp) : existing.vatRateBp;

      const res = updateAttr(session, products, {
        id: targetId,
        organizationId,
        values: {
          categoryId: nextCategoryId,
          sku: nextSku,
          skuSearch: nextSkuSearch,
          name: nextName,
          nameSearch: nextNameSearch,
          unit: nextUnit,
          unlimited: nextUnlimited,
          minStock: nextMinStock,
          hasVariants: nextHasVariants,
          salePrice: nextSalePrice,
          mxik: nextMxik,
          packageCode: nextPackageCode,
          vatRateBp: nextVatRateBp,
        },
        eventType: 'product.updated',
        schemaVersion: 1,
      });

      if (nextSalePrice !== existing.salePrice) {
        insertFact(session, priceChanges, {
          organizationId,
          values: {
            productId: targetId,
            variantId: null,
            oldPrice: existing.salePrice,
            newPrice: nextSalePrice,
            changedByUserId: actorUserId,
            reason,
          },
          eventType: 'price_change.recorded',
          schemaVersion: 1,
        });
      }

      return Promise.resolve(toStoredProduct(res.row));
    });
  }

  async deleteProduct(productId: UuidV7): Promise<void> {
    const { uow, organizationId } = this.requireContext();
    const targetId = parseUuidV7(productId);

    await uow.execute((session) => {
      this.requireActiveProductSync(session, organizationId, targetId);

      const activeBarcodes = session.db
        .select({ id: productBarcodes.id })
        .from(productBarcodes)
        .where(
          and(
            eq(productBarcodes.organizationId, organizationId),
            eq(productBarcodes.productId, targetId),
            isNull(productBarcodes.deletedAtMs),
          ),
        )
        .all();

      for (const bc of activeBarcodes) {
        tombstoneAttr(session, productBarcodes, {
          id: bc.id,
          organizationId,
          eventType: 'product_barcode.deleted',
          schemaVersion: 1,
        });
      }

      const activeVariants = session.db
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(
          and(
            eq(productVariants.organizationId, organizationId),
            eq(productVariants.productId, targetId),
            isNull(productVariants.deletedAtMs),
          ),
        )
        .all();

      for (const variant of activeVariants) {
        tombstoneAttr(session, productVariants, {
          id: variant.id,
          organizationId,
          eventType: 'product_variant.deleted',
          schemaVersion: 1,
        });
      }

      tombstoneAttr(session, products, {
        id: targetId,
        organizationId,
        eventType: 'product.deleted',
        schemaVersion: 1,
      });

      return Promise.resolve();
    });
  }

  async createVariant(
    productId: UuidV7,
    input: {
      readonly name: string;
      readonly sku?: string | null;
      readonly attributes?: Readonly<Record<string, string>>;
      readonly salePrice?: string | null;
      readonly reason?: string | null;
      readonly actorUserId: UuidV7;
    },
  ): Promise<StoredProductVariantRecord> {
    const { uow, organizationId } = this.requireContext();
    const parentId = parseUuidV7(productId);
    const actorUserId = parseUuidV7(input.actorUserId);
    const cleanName = normalizeCatalogDisplayName(input.name, 'Variant name', 120);
    const nameSearch = normalizeCatalogSearchText(cleanName);
    const sku = normalizeCatalogSku(input.sku);
    const skuSearch = sku !== null ? normalizeCatalogSearchText(sku) : null;
    const { json: attributesJson } = canonicalizeVariantAttributes(input.attributes ?? {});
    const salePrice =
      input.salePrice !== undefined && input.salePrice !== null
        ? parseMoneyBigIntString(input.salePrice, 'Variant sale price')
        : null;
    const reason = normalizePriceChangeReason(input.reason);

    return uow.execute((session) => {
      const parent = this.requireActiveProductSync(session, organizationId, parentId);
      if (sku !== null) {
        this.assertUniqueVariantSkuSync(session, organizationId, sku);
      }

      const res = insertAttr(session, productVariants, {
        organizationId,
        values: {
          productId: parentId,
          name: cleanName,
          nameSearch,
          sku,
          skuSearch,
          attributesJson,
          salePrice,
        },
        eventType: 'product_variant.created',
        schemaVersion: 1,
      });

      if (!parent.hasVariants) {
        updateAttr(session, products, {
          id: parentId,
          organizationId,
          values: { hasVariants: true },
          eventType: 'product.updated',
          schemaVersion: 1,
        });
      }

      if (salePrice !== null) {
        insertFact(session, priceChanges, {
          organizationId,
          values: {
            productId: parentId,
            variantId: res.entityId,
            oldPrice: null,
            newPrice: salePrice,
            changedByUserId: actorUserId,
            reason: reason ?? 'initial_variant_price',
          },
          eventType: 'price_change.recorded',
          schemaVersion: 1,
        });
      }

      return Promise.resolve(toStoredVariant(res.row, parent.salePrice));
    });
  }

  async updateVariant(
    productId: UuidV7,
    variantId: UuidV7,
    patch: {
      readonly name?: string;
      readonly sku?: string | null;
      readonly attributes?: Readonly<Record<string, string>>;
      readonly salePrice?: string | null;
      readonly reason?: string | null;
      readonly actorUserId: UuidV7;
    },
  ): Promise<StoredProductVariantRecord> {
    const { uow, organizationId } = this.requireContext();
    const parentId = parseUuidV7(productId);
    const targetId = parseUuidV7(variantId);
    const actorUserId = parseUuidV7(patch.actorUserId);
    const reason = normalizePriceChangeReason(patch.reason);

    return uow.execute((session) => {
      const parent = this.requireActiveProductSync(session, organizationId, parentId);
      const existing = this.requireActiveVariantSync(session, organizationId, parentId, targetId);

      const nextName =
        patch.name !== undefined
          ? normalizeCatalogDisplayName(patch.name, 'Variant name', 120)
          : existing.name;
      const nextNameSearch =
        patch.name !== undefined ? normalizeCatalogSearchText(nextName) : existing.nameSearch;

      const nextSku = patch.sku !== undefined ? normalizeCatalogSku(patch.sku) : existing.sku;
      const nextSkuSearch =
        patch.sku !== undefined
          ? nextSku !== null
            ? normalizeCatalogSearchText(nextSku)
            : null
          : existing.skuSearch;

      if (nextSku !== null && nextSku !== existing.sku) {
        this.assertUniqueVariantSkuSync(session, organizationId, nextSku, targetId);
      }

      const nextAttributesJson =
        patch.attributes !== undefined
          ? canonicalizeVariantAttributes(patch.attributes).json
          : existing.attributesJson;

      const nextSalePrice =
        patch.salePrice !== undefined
          ? patch.salePrice !== null
            ? parseMoneyBigIntString(patch.salePrice, 'Variant sale price')
            : null
          : existing.salePrice;

      const res = updateAttr(session, productVariants, {
        id: targetId,
        organizationId,
        values: {
          name: nextName,
          nameSearch: nextNameSearch,
          sku: nextSku,
          skuSearch: nextSkuSearch,
          attributesJson: nextAttributesJson,
          salePrice: nextSalePrice,
        },
        eventType: 'product_variant.updated',
        schemaVersion: 1,
      });

      if (patch.salePrice !== undefined && nextSalePrice !== existing.salePrice) {
        insertFact(session, priceChanges, {
          organizationId,
          values: {
            productId: parentId,
            variantId: targetId,
            oldPrice: existing.salePrice,
            newPrice: nextSalePrice ?? parent.salePrice,
            changedByUserId: actorUserId,
            reason: nextSalePrice === null ? (reason ?? 'reset_to_parent_price') : reason,
          },
          eventType: 'price_change.recorded',
          schemaVersion: 1,
        });
      }

      return Promise.resolve(toStoredVariant(res.row, parent.salePrice));
    });
  }

  async deleteVariant(productId: UuidV7, variantId: UuidV7): Promise<void> {
    const { uow, organizationId } = this.requireContext();
    const parentId = parseUuidV7(productId);
    const targetId = parseUuidV7(variantId);

    await uow.execute((session) => {
      const parent = this.requireActiveProductSync(session, organizationId, parentId);
      this.requireActiveVariantSync(session, organizationId, parentId, targetId);

      const attachedBarcodes = session.db
        .select({ id: productBarcodes.id })
        .from(productBarcodes)
        .where(
          and(
            eq(productBarcodes.organizationId, organizationId),
            eq(productBarcodes.productId, parentId),
            eq(productBarcodes.variantId, targetId),
            isNull(productBarcodes.deletedAtMs),
          ),
        )
        .all();

      for (const bc of attachedBarcodes) {
        tombstoneAttr(session, productBarcodes, {
          id: bc.id,
          organizationId,
          eventType: 'product_barcode.deleted',
          schemaVersion: 1,
        });
      }

      tombstoneAttr(session, productVariants, {
        id: targetId,
        organizationId,
        eventType: 'product_variant.deleted',
        schemaVersion: 1,
      });

      const remaining = session.db
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(
          and(
            eq(productVariants.organizationId, organizationId),
            eq(productVariants.productId, parentId),
            isNull(productVariants.deletedAtMs),
          ),
        )
        .limit(1)
        .all();

      if (remaining.length === 0 && parent.hasVariants) {
        updateAttr(session, products, {
          id: parentId,
          organizationId,
          values: { hasVariants: false },
          eventType: 'product.updated',
          schemaVersion: 1,
        });
      }

      return Promise.resolve();
    });
  }

  async createBarcode(
    productId: UuidV7,
    input: {
      readonly barcode: string;
      readonly format?: BarcodeFormat;
      readonly variantId?: UuidV7 | null;
    },
  ): Promise<StoredProductBarcodeRecord> {
    const { uow, organizationId } = this.requireContext();
    const targetProductId = parseUuidV7(productId);
    const targetVariantId = input.variantId ? parseUuidV7(input.variantId) : null;
    const prepared = prepareBarcodeForStorage(input.barcode, input.format);

    return uow.execute((session) => {
      this.requireActiveProductSync(session, organizationId, targetProductId);
      if (targetVariantId !== null) {
        this.requireActiveVariantSync(session, organizationId, targetProductId, targetVariantId);
      }
      this.assertUniqueBarcodeSync(session, organizationId, prepared.barcode);

      try {
        const res = insertAttr(session, productBarcodes, {
          organizationId,
          values: {
            productId: targetProductId,
            variantId: targetVariantId,
            barcode: prepared.barcode,
            format: prepared.format,
          },
          eventType: 'product_barcode.created',
          schemaVersion: 1,
        });
        return Promise.resolve(toStoredBarcode(res.row));
      } catch (err) {
        if (isSqliteUniqueConstraintError(err)) {
          throw new DomainError(
            'BARCODE_ALREADY_EXISTS',
            `Barcode "${prepared.barcode}" is already assigned to another active item`,
          );
        }
        throw err;
      }
    });
  }

  async deleteBarcode(productId: UuidV7, barcodeId: UuidV7): Promise<void> {
    const { uow, organizationId } = this.requireContext();
    const targetProductId = parseUuidV7(productId);
    const targetBarcodeId = parseUuidV7(barcodeId);

    await uow.execute((session) => {
      const existing = session.db
        .select({ id: productBarcodes.id })
        .from(productBarcodes)
        .where(
          and(
            eq(productBarcodes.id, targetBarcodeId),
            eq(productBarcodes.organizationId, organizationId),
            eq(productBarcodes.productId, targetProductId),
            isNull(productBarcodes.deletedAtMs),
          ),
        )
        .limit(1)
        .all()[0];

      if (!existing) {
        throw new DomainError(
          'BARCODE_NOT_FOUND',
          `Barcode "${targetBarcodeId}" was not found for product "${targetProductId}"`,
        );
      }

      tombstoneAttr(session, productBarcodes, {
        id: targetBarcodeId,
        organizationId,
        eventType: 'product_barcode.deleted',
        schemaVersion: 1,
      });

      return Promise.resolve();
    });
  }

  async scanBarcode(rawCode: string): Promise<StoredBarcodeScanResult | null> {
    const { uow, organizationId } = this.requireContext();
    const candidates = buildScanBarcodeCandidates(rawCode);

    return uow.runReadOnly(() => {
      const singleCandidate = candidates.length === 1 ? candidates[0] : undefined;
      const barcodeMatches = this.connection.db
        .select()
        .from(productBarcodes)
        .where(
          and(
            eq(productBarcodes.organizationId, organizationId),
            isNull(productBarcodes.deletedAtMs),
            singleCandidate !== undefined
              ? eq(productBarcodes.barcode, singleCandidate)
              : inArray(productBarcodes.barcode, [...candidates]),
          ),
        )
        .all();

      const firstMatch = barcodeMatches[0];
      if (!firstMatch) {
        return Promise.resolve(null);
      }

      // Prefer canonical first candidate (`0` + upca) when multiple candidates were checked
      let chosen = firstMatch;
      for (const candidate of candidates) {
        const hit = barcodeMatches.find((row) => row.barcode === candidate);
        if (hit) {
          chosen = hit;
          break;
        }
      }

      const prodRow = this.connection.db
        .select()
        .from(products)
        .where(
          and(
            eq(products.id, chosen.productId),
            eq(products.organizationId, organizationId),
            isNull(products.deletedAtMs),
          ),
        )
        .limit(1)
        .all()[0];

      if (!prodRow) {
        return Promise.resolve(null);
      }

      const product = toStoredProduct(prodRow);
      let variant: StoredProductVariantRecord | null = null;
      if (chosen.variantId !== null) {
        const variantRow = this.connection.db
          .select()
          .from(productVariants)
          .where(
            and(
              eq(productVariants.id, chosen.variantId),
              eq(productVariants.organizationId, organizationId),
              eq(productVariants.productId, product.id),
              isNull(productVariants.deletedAtMs),
            ),
          )
          .limit(1)
          .all()[0];
        if (!variantRow) {
          return Promise.resolve(null);
        }
        variant = toStoredVariant(variantRow, product.salePrice);
      }

      return Promise.resolve({
        product,
        variant,
        barcode: toStoredBarcode(chosen),
        quantity: null,
      });
    });
  }

  async listPriceChanges(productId: UuidV7): Promise<readonly StoredPriceChangeRecord[]> {
    const { uow, organizationId } = this.requireContext();
    const targetId = parseUuidV7(productId);

    return uow.runReadOnly(() => {
      const prodRow = this.connection.db
        .select({ id: products.id })
        .from(products)
        .where(
          and(
            eq(products.id, targetId),
            eq(products.organizationId, organizationId),
            isNull(products.deletedAtMs),
          ),
        )
        .limit(1)
        .all()[0];
      if (!prodRow) {
        throw new DomainError('PRODUCT_NOT_FOUND', `Product "${targetId}" was not found`);
      }

      const rows = this.connection.db
        .select()
        .from(priceChanges)
        .where(
          and(
            eq(priceChanges.organizationId, organizationId),
            eq(priceChanges.productId, targetId),
          ),
        )
        .orderBy(desc(priceChanges.createdAtMs), desc(priceChanges.id))
        .all();

      return Promise.resolve(rows.map(toStoredPriceChange));
    });
  }

  async rebuildSearchIndex(): Promise<RebuildCatalogSearchResult> {
    const { organizationId } = this.requireContext();
    return rebuildCatalogSearchIndex(this.connection, organizationId);
  }

  // --- Internal transaction guards (must run inside active BEGIN IMMEDIATE session) ---

  private requireActiveCategorySync(
    session: SqliteUnitOfWorkSession,
    organizationId: UuidV7,
    categoryId: UuidV7,
  ): typeof categories.$inferSelect {
    const row = session.db
      .select()
      .from(categories)
      .where(
        and(
          eq(categories.id, categoryId),
          eq(categories.organizationId, organizationId),
          isNull(categories.deletedAtMs),
        ),
      )
      .limit(1)
      .all()[0];
    if (!row) {
      throw new DomainError('CATEGORY_NOT_FOUND', `Category "${categoryId}" was not found`);
    }
    return row;
  }

  private assertNoCategoryCycleSync(
    session: SqliteUnitOfWorkSession,
    organizationId: UuidV7,
    categoryId: UuidV7,
    candidateParentId: UuidV7,
  ): void {
    if (candidateParentId === categoryId) {
      throw new DomainError('CATEGORY_CYCLE', 'Category cannot be its own parent');
    }
    const visited = new Set<UuidV7>([categoryId]);
    let cursor: UuidV7 | null = candidateParentId;

    while (cursor !== null) {
      if (visited.has(cursor)) {
        throw new DomainError('CATEGORY_CYCLE', 'Category hierarchy must not form a cycle');
      }
      visited.add(cursor);
      const ancestor = this.requireActiveCategorySync(session, organizationId, cursor);
      cursor = ancestor.parentId;
    }
  }

  private assertNoDuplicateCategorySiblingSync(
    session: SqliteUnitOfWorkSession,
    organizationId: UuidV7,
    parentId: UuidV7 | null,
    nameSearch: string,
    excludeId?: UuidV7,
  ): void {
    const preds = [
      eq(categories.organizationId, organizationId),
      parentId === null ? isNull(categories.parentId) : eq(categories.parentId, parentId),
      eq(categories.nameSearch, nameSearch),
      isNull(categories.deletedAtMs),
    ];
    if (excludeId !== undefined) {
      preds.push(ne(categories.id, excludeId));
    }

    const dup = session.db
      .select({ id: categories.id })
      .from(categories)
      .where(and(...preds))
      .limit(1)
      .all()[0];
    if (dup) {
      throw new DomainError(
        'CATEGORY_ALREADY_EXISTS',
        'A category with this name already exists at the same level',
      );
    }
  }

  private requireActiveProductSync(
    session: SqliteUnitOfWorkSession,
    organizationId: UuidV7,
    productId: UuidV7,
  ): typeof products.$inferSelect {
    const row = session.db
      .select()
      .from(products)
      .where(
        and(
          eq(products.id, productId),
          eq(products.organizationId, organizationId),
          isNull(products.deletedAtMs),
        ),
      )
      .limit(1)
      .all()[0];
    if (!row) {
      throw new DomainError('PRODUCT_NOT_FOUND', `Product "${productId}" was not found`);
    }
    return row;
  }

  private requireActiveVariantSync(
    session: SqliteUnitOfWorkSession,
    organizationId: UuidV7,
    productId: UuidV7,
    variantId: UuidV7,
  ): typeof productVariants.$inferSelect {
    const row = session.db
      .select()
      .from(productVariants)
      .where(
        and(
          eq(productVariants.id, variantId),
          eq(productVariants.organizationId, organizationId),
          eq(productVariants.productId, productId),
          isNull(productVariants.deletedAtMs),
        ),
      )
      .limit(1)
      .all()[0];
    if (!row) {
      throw new DomainError(
        'VARIANT_NOT_FOUND',
        `Variant "${variantId}" was not found for product "${productId}"`,
      );
    }
    return row;
  }

  private assertUniqueProductSkuSync(
    session: SqliteUnitOfWorkSession,
    organizationId: UuidV7,
    sku: string,
    excludeId?: UuidV7,
  ): void {
    const preds = [
      eq(products.organizationId, organizationId),
      eq(products.sku, sku),
      isNull(products.deletedAtMs),
    ];
    if (excludeId !== undefined) {
      preds.push(ne(products.id, excludeId));
    }
    const dup = session.db
      .select({ id: products.id })
      .from(products)
      .where(and(...preds))
      .limit(1)
      .all()[0];
    if (dup) {
      throw new DomainError(
        'PRODUCT_SKU_ALREADY_EXISTS',
        `Product SKU "${sku}" already exists in this organization`,
      );
    }
  }

  private assertUniqueVariantSkuSync(
    session: SqliteUnitOfWorkSession,
    organizationId: UuidV7,
    sku: string,
    excludeId?: UuidV7,
  ): void {
    const preds = [
      eq(productVariants.organizationId, organizationId),
      eq(productVariants.sku, sku),
      isNull(productVariants.deletedAtMs),
    ];
    if (excludeId !== undefined) {
      preds.push(ne(productVariants.id, excludeId));
    }
    const dup = session.db
      .select({ id: productVariants.id })
      .from(productVariants)
      .where(and(...preds))
      .limit(1)
      .all()[0];
    if (dup) {
      throw new DomainError(
        'VARIANT_SKU_ALREADY_EXISTS',
        `Variant SKU "${sku}" already exists in this organization`,
      );
    }
  }

  private assertUniqueBarcodeSync(
    session: SqliteUnitOfWorkSession,
    organizationId: UuidV7,
    canonicalBarcode: string,
  ): void {
    const dup = session.db
      .select({ id: productBarcodes.id })
      .from(productBarcodes)
      .where(
        and(
          eq(productBarcodes.organizationId, organizationId),
          eq(productBarcodes.barcode, canonicalBarcode),
          isNull(productBarcodes.deletedAtMs),
        ),
      )
      .limit(1)
      .all()[0];
    if (dup) {
      throw new DomainError(
        'BARCODE_ALREADY_EXISTS',
        `Barcode "${canonicalBarcode}" is already registered to an active product`,
      );
    }
  }
}

export function createSqliteCatalogStore(
  options: CreateSqliteCatalogStoreOptions,
): SqliteCatalogStore {
  return new SqliteCatalogStore(options);
}
