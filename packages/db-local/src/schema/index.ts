import { sql } from 'drizzle-orm';
import { type AnySQLiteColumn, check, index, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import {
  sqliteBigint,
  sqliteBoolean,
  sqliteHlc,
  sqliteInt,
  sqliteMoney,
  sqliteQuantity,
  sqliteUnixMs,
  sqliteUuidV7,
} from '../columns.js';
import { SqliteSchemaRegistry } from '../registry.js';

/**
 * Local SQLite schema metadata registry.
 * T0.5 added operational `LOCAL` tables `local_device_state` and `local_outbox`.
 * T0.6 adds synced `ATTR` `users` and `LOCAL` hub auth tables (`local_hub_config`,
 * `local_pin_credentials`, `local_device_auth_state`, `local_sessions`).
 * Business synced tables (catalog, stock, sales) remain out of scope until F1.
 */
export const localSchemaRegistry = new SqliteSchemaRegistry();

/**
 * Persists this terminal/hub device's monotonic counters across commits, crashes, and restarts:
 * - `last_device_seq`: gapless monotonic counter (source of truth in DB, updated atomically on outbox writes)
 * - `last_hlc`: canonical 58-char HLC timestamp to restore `HlcClock({ initial })`
 * - `last_uuid_ms`: Unix ms watermark to restore `MonotonicUuidV7Generator({ initialLastMs })`
 */
export const localDeviceState = localSchemaRegistry.defineTable(
  {
    name: 'local_device_state',
    tableClass: 'LOCAL',
    tenantScope: 'organization',
  },
  (common) => ({
    ...common,
    deviceId: sqliteUuidV7('device_id').notNull(),
    lastDeviceSeq: sqliteBigint('last_device_seq').notNull(),
    lastReceiptSeq: sqliteBigint('last_receipt_seq')
      .notNull()
      .default(sql`0`),
    lastReturnSeq: sqliteBigint('last_return_seq')
      .notNull()
      .default(sql`0`),
    lastHlc: sqliteHlc('last_hlc').notNull(),
    lastUuidMs: sqliteUnixMs('last_uuid_ms').notNull(),
  }),
  (self) => [
    uniqueIndex('uidx_local_device_state_device_id').on(self.deviceId),
    check('chk_local_device_state_seq_nonneg', sql`${self.lastDeviceSeq} >= 0`),
    check('chk_local_device_state_receipt_nonneg', sql`${self.lastReceiptSeq} >= 0`),
    check('chk_local_device_state_return_nonneg', sql`${self.lastReturnSeq} >= 0`),
  ],
);

/**
 * Local transactional outbox queue (`GEMINI.md` Section 4 envelope + minimal push status for F2).
 * Decision (`T0.5` Adjustment #5): `id` primary key IS `eventId` (no redundant `event_id` column),
 * matching `SqliteSchemaRegistry`'s universal `id` primary key requirement cleanly.
 */
export const localOutbox = localSchemaRegistry.defineTable(
  {
    name: 'local_outbox',
    tableClass: 'LOCAL',
    tenantScope: 'organization',
  },
  (common) => ({
    ...common,
    storeId: sqliteUuidV7('store_id'),
    deviceId: sqliteUuidV7('device_id').notNull(),
    deviceSeq: sqliteBigint('device_seq').notNull(),
    hlc: sqliteHlc('hlc').notNull(),
    type: text('type').notNull(),
    entity: text('entity').notNull(),
    entityId: sqliteUuidV7('entity_id').notNull(),
    entityClass: text('class').notNull(),
    schemaVersion: sqliteInt('schema_version').notNull(),
    payload: text('payload').notNull(),
    status: text('status').notNull().default('pending'),
    attempts: sqliteInt('attempts').notNull().default(0),
    lastError: text('last_error'),
    pushedAtMs: sqliteUnixMs('pushed_at_ms'),
  }),
  (self) => [
    uniqueIndex('uidx_local_outbox_device_seq').on(self.deviceId, self.deviceSeq),
    index('idx_local_outbox_status_seq').on(self.status, self.deviceSeq),
    check('chk_local_outbox_device_seq_pos', sql`${self.deviceSeq} >= 1`),
    check('chk_local_outbox_class', sql`${self.entityClass} IN ('FACT', 'ATTR', 'MONOTONE')`),
    check('chk_local_outbox_schema_ver', sql`${self.schemaVersion} >= 1`),
    check('chk_local_outbox_status', sql`${self.status} IN ('pending', 'acked', 'rejected')`),
    check('chk_local_outbox_attempts', sql`${self.attempts} >= 0`),
  ],
);

/**
 * Synced user & role directory (`ATTR`).
 * Secrets (PIN hashes, lockout counters, session tokens) NEVER live here and are NEVER outboxed.
 * Username uniqueness applies strictly to non-tombstoned rows (`WHERE deleted_at_ms IS NULL`)
 * so a deleted user's username may be safely reused later.
 */
export const users = localSchemaRegistry.defineTable(
  {
    name: 'users',
    tableClass: 'ATTR',
    tenantScope: 'organization',
  },
  (common) => ({
    ...common,
    username: text('username').notNull(),
    fullName: text('full_name').notNull(),
    role: text('role').notNull(),
    isActive: sqliteBoolean('is_active').notNull(),
  }),
  (self) => [
    uniqueIndex('uidx_users_org_username')
      .on(self.organizationId, self.username)
      .where(sql`${self.deletedAtMs} IS NULL`),
    index('idx_users_org_active_role').on(self.organizationId, self.deletedAtMs, self.isActive),
    check('chk_users_role', sql`${self.role} IN ('owner', 'manager', 'cashier')`),
    check('chk_users_is_active', sql`${self.isActive} IN (0, 1)`),
    check('chk_users_username_nonempty', sql`length(trim(${self.username})) >= 2`),
    check('chk_users_full_name_nonempty', sql`length(trim(${self.fullName})) >= 1`),
  ],
);

/**
 * Singleton first-run setup configuration (`LOCAL`).
 * Enforces at database level (`singleton_guard = 1` UNIQUE) that initial setup completes at most once.
 */
export const localHubConfig = localSchemaRegistry.defineTable(
  {
    name: 'local_hub_config',
    tableClass: 'LOCAL',
    tenantScope: 'organization',
  },
  (common) => ({
    ...common,
    storeId: sqliteUuidV7('store_id').notNull(),
    deviceId: sqliteUuidV7('device_id').notNull(),
    singletonGuard: sqliteInt('singleton_guard').notNull(),
    setupCompletedAtMs: sqliteUnixMs('setup_completed_at_ms').notNull(),
    negativeStockPolicy: text('negative_stock_policy').notNull().default('warn'),
    cashierDiscountPercentUnlimited: sqliteBoolean('cashier_discount_percent_unlimited')
      .notNull()
      .default(false),
    cashierMaxDiscountPercentBp: sqliteInt('cashier_max_discount_percent_bp').notNull().default(0),
    cashierDiscountAmountUnlimited: sqliteBoolean('cashier_discount_amount_unlimited')
      .notNull()
      .default(false),
    cashierMaxDiscountAmount: sqliteMoney('cashier_max_discount_amount')
      .notNull()
      .default(sql`0`),
    quickSaleDefaultMxik: text('quick_sale_default_mxik'),
    quickSaleDefaultVatRateBp: sqliteInt('quick_sale_default_vat_rate_bp'),
    storeTimezone: text('store_timezone').notNull().default('Asia/Tashkent'),
    defaultCustomerDueDays: sqliteInt('default_customer_due_days').default(14),
  }),
  (self) => [
    uniqueIndex('uidx_local_hub_config_singleton').on(self.singletonGuard),
    check('chk_local_hub_config_singleton', sql`${self.singletonGuard} = 1`),
    check('chk_local_hub_config_neg_policy', sql`${self.negativeStockPolicy} IN ('warn', 'block')`),
    check('chk_local_hub_config_pct_unlim', sql`${self.cashierDiscountPercentUnlimited} IN (0, 1)`),
    check(
      'chk_local_hub_config_max_pct',
      sql`${self.cashierMaxDiscountPercentBp} >= 0 AND ${self.cashierMaxDiscountPercentBp} <= 10000`,
    ),
    check('chk_local_hub_config_amt_unlim', sql`${self.cashierDiscountAmountUnlimited} IN (0, 1)`),
    check('chk_local_hub_config_max_amt', sql`${self.cashierMaxDiscountAmount} >= 0`),
    check(
      'chk_local_hub_config_qs_vat',
      sql`${self.quickSaleDefaultVatRateBp} IS NULL OR (${self.quickSaleDefaultVatRateBp} >= 0 AND ${self.quickSaleDefaultVatRateBp} <= 10000)`,
    ),
    check('chk_local_hub_config_timezone_nonempty', sql`length(trim(${self.storeTimezone})) >= 1`),
    check(
      'chk_local_hub_config_cust_due_days',
      sql`${self.defaultCustomerDueDays} IS NULL OR (${self.defaultCustomerDueDays} >= 1 AND ${self.defaultCustomerDueDays} <= 3650)`,
    ),
  ],
);

/**
 * Device-local Argon2id PIN credentials and persistent per-user brute-force lockout state (`LOCAL`).
 * Strictly excluded from outbox/sync (`GEMINI.md` 3.4).
 */
export const localPinCredentials = localSchemaRegistry.defineTable(
  {
    name: 'local_pin_credentials',
    tableClass: 'LOCAL',
    tenantScope: 'organization',
  },
  (common) => ({
    ...common,
    userId: sqliteUuidV7('user_id')
      .notNull()
      .references(() => users.id),
    pinHash: text('pin_hash').notNull(),
    pinUpdatedAtMs: sqliteUnixMs('pin_updated_at_ms').notNull(),
    failedAttempts: sqliteInt('failed_attempts').notNull().default(0),
    lockedUntilMs: sqliteUnixMs('locked_until_ms'),
    lastFailedAtMs: sqliteUnixMs('last_failed_at_ms'),
  }),
  (self) => [
    uniqueIndex('uidx_local_pin_credentials_user_id').on(self.userId),
    check('chk_local_pin_credentials_failed_nonneg', sql`${self.failedAttempts} >= 0`),
    check('chk_local_pin_credentials_hash_nonempty', sql`length(${self.pinHash}) >= 1`),
  ],
);

/**
 * Device-wide progressive PIN throttling state (`LOCAL`, `T0.6` T1).
 * Tracks consecutive/windowed failures across all usernames so user-rotation sprays hit exponential
 * backoff (2s, 4s, ..., capped at 60s) without ever hard-locking the entire POS terminal.
 */
export const localDeviceAuthState = localSchemaRegistry.defineTable(
  {
    name: 'local_device_auth_state',
    tableClass: 'LOCAL',
    tenantScope: 'organization',
  },
  (common) => ({
    ...common,
    deviceId: sqliteUuidV7('device_id').notNull(),
    windowStartedAtMs: sqliteUnixMs('window_started_at_ms').notNull(),
    failedAttempts: sqliteInt('failed_attempts').notNull().default(0),
    nextAllowedAtMs: sqliteUnixMs('next_allowed_at_ms'),
    lastFailedAtMs: sqliteUnixMs('last_failed_at_ms'),
  }),
  (self) => [
    uniqueIndex('uidx_local_device_auth_state_device_id').on(self.deviceId),
    check('chk_local_device_auth_state_failed_nonneg', sql`${self.failedAttempts} >= 0`),
  ],
);

/**
 * Local bearer sessions (`LOCAL`). Stores only 64-char SHA-256 hex digest of 32 random bytes.
 */
export const localSessions = localSchemaRegistry.defineTable(
  {
    name: 'local_sessions',
    tableClass: 'LOCAL',
    tenantScope: 'organization',
  },
  (common) => ({
    ...common,
    userId: sqliteUuidV7('user_id')
      .notNull()
      .references(() => users.id),
    deviceId: sqliteUuidV7('device_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAtMs: sqliteUnixMs('expires_at_ms').notNull(),
    revokedAtMs: sqliteUnixMs('revoked_at_ms'),
    lastSeenAtMs: sqliteUnixMs('last_seen_at_ms').notNull(),
  }),
  (self) => [
    uniqueIndex('uidx_local_sessions_token_hash').on(self.tokenHash),
    index('idx_local_sessions_user_revoked').on(self.userId, self.revokedAtMs),
    check('chk_local_sessions_token_hash_len', sql`length(${self.tokenHash}) = 64`),
  ],
);

/**
 * Organization-wide product category hierarchy (`ATTR`, T1.1).
 */
export const categories = localSchemaRegistry.defineTable(
  {
    name: 'categories',
    tableClass: 'ATTR',
    tenantScope: 'organization',
  },
  (common) => ({
    ...common,
    name: text('name').notNull(),
    nameSearch: text('name_search').notNull(),
    parentId: sqliteUuidV7('parent_id').references((): AnySQLiteColumn => categories.id),
    sortOrder: sqliteInt('sort_order').notNull().default(0),
  }),
  (self) => [
    uniqueIndex('uidx_categories_org_root_name')
      .on(self.organizationId, self.nameSearch)
      .where(sql`${self.parentId} IS NULL AND ${self.deletedAtMs} IS NULL`),
    uniqueIndex('uidx_categories_org_child_name')
      .on(self.organizationId, self.parentId, self.nameSearch)
      .where(sql`${self.parentId} IS NOT NULL AND ${self.deletedAtMs} IS NULL`),
    index('idx_categories_org_parent')
      .on(self.organizationId, self.parentId)
      .where(sql`${self.deletedAtMs} IS NULL`),
    check('chk_categories_name_nonempty', sql`length(trim(${self.name})) >= 1`),
    check(
      'chk_categories_not_self_parent',
      sql`${self.parentId} IS NULL OR ${self.parentId} <> ${self.id}`,
    ),
  ],
);

/**
 * Organization-scoped product catalog (`ATTR`, T1.1).
 * Carries fiscal fields (`mxik`, `package_code`, `vat_rate_bp`) upfront for F3 compliance.
 * Indexed by normalized `name_search` / `sku_search` plus `products_fts` FTS5 triggers.
 */
export const products = localSchemaRegistry.defineTable(
  {
    name: 'products',
    tableClass: 'ATTR',
    tenantScope: 'organization',
  },
  (common) => ({
    ...common,
    categoryId: sqliteUuidV7('category_id').references(() => categories.id),
    sku: text('sku'),
    skuSearch: text('sku_search'),
    name: text('name').notNull(),
    nameSearch: text('name_search').notNull(),
    unit: text('unit').notNull(),
    unlimited: sqliteBoolean('unlimited').notNull().default(false),
    minStock: sqliteQuantity('min_stock'),
    hasVariants: sqliteBoolean('has_variants').notNull().default(false),
    trackBatches: sqliteBoolean('track_batches').notNull().default(false),
    salePrice: sqliteMoney('sale_price').notNull(),
    mxik: text('mxik'),
    packageCode: text('package_code'),
    vatRateBp: sqliteInt('vat_rate_bp').notNull().default(0),
  }),
  (self) => [
    uniqueIndex('uidx_products_org_sku')
      .on(self.organizationId, self.sku)
      .where(sql`${self.sku} IS NOT NULL AND ${self.deletedAtMs} IS NULL`),
    index('idx_products_org_name_search')
      .on(self.organizationId, self.nameSearch, self.id)
      .where(sql`${self.deletedAtMs} IS NULL`),
    index('idx_products_org_sku_search')
      .on(self.organizationId, self.skuSearch, self.id)
      .where(sql`${self.skuSearch} IS NOT NULL AND ${self.deletedAtMs} IS NULL`),
    index('idx_products_org_category')
      .on(self.organizationId, self.categoryId)
      .where(sql`${self.deletedAtMs} IS NULL`),
    index('idx_products_active_join')
      .on(self.id, self.organizationId, self.categoryId)
      .where(sql`${self.deletedAtMs} IS NULL`),
    check('chk_products_name_nonempty', sql`length(trim(${self.name})) >= 1`),
    check(
      'chk_products_unit',
      sql`${self.unit} IN ('dona', 'kg', 'g', 'litr', 'metr', 'm2', 'qadoq')`,
    ),
    check('chk_products_unlimited', sql`${self.unlimited} IN (0, 1)`),
    check('chk_products_has_variants', sql`${self.hasVariants} IN (0, 1)`),
    check('chk_products_track_batches', sql`${self.trackBatches} IN (0, 1)`),
    check('chk_products_min_stock_nonneg', sql`${self.minStock} IS NULL OR ${self.minStock} >= 0`),
    check(
      'chk_products_min_stock_unit_int',
      sql`${self.minStock} IS NULL OR ${self.unit} NOT IN ('dona', 'qadoq') OR (${self.minStock} % 1000) = 0`,
    ),
    check('chk_products_sale_price_nonneg', sql`${self.salePrice} >= 0`),
    check('chk_products_vat_rate_bp', sql`${self.vatRateBp} >= 0 AND ${self.vatRateBp} <= 10000`),
  ],
);

/**
 * Product variants (`ATTR`, T1.1) with canonical sorted JSON attributes and optional price override.
 */
export const productVariants = localSchemaRegistry.defineTable(
  {
    name: 'product_variants',
    tableClass: 'ATTR',
    tenantScope: 'organization',
  },
  (common) => ({
    ...common,
    productId: sqliteUuidV7('product_id')
      .notNull()
      .references(() => products.id),
    name: text('name').notNull(),
    nameSearch: text('name_search').notNull(),
    sku: text('sku'),
    skuSearch: text('sku_search'),
    attributesJson: text('attributes_json').notNull(),
    salePrice: sqliteMoney('sale_price'),
  }),
  (self) => [
    index('idx_product_variants_org_product')
      .on(self.organizationId, self.productId)
      .where(sql`${self.deletedAtMs} IS NULL`),
    uniqueIndex('uidx_product_variants_org_sku')
      .on(self.organizationId, self.sku)
      .where(sql`${self.sku} IS NOT NULL AND ${self.deletedAtMs} IS NULL`),
    check('chk_product_variants_name_nonempty', sql`length(trim(${self.name})) >= 1`),
    check('chk_product_variants_attrs_json', sql`json_valid(${self.attributesJson}) = 1`),
    check(
      'chk_product_variants_sale_price_nonneg',
      sql`${self.salePrice} IS NULL OR ${self.salePrice} >= 0`,
    ),
  ],
);

/**
 * Product & variant barcode mappings (`ATTR`, T1.1).
 * Partial unique index guarantees one active barcode maps to a single product/variant within an org.
 * 12-digit UPC-A codes are stored in canonical 13-digit EAN-13 form (`'0' + upca`).
 */
export const productBarcodes = localSchemaRegistry.defineTable(
  {
    name: 'product_barcodes',
    tableClass: 'ATTR',
    tenantScope: 'organization',
  },
  (common) => ({
    ...common,
    productId: sqliteUuidV7('product_id')
      .notNull()
      .references(() => products.id),
    variantId: sqliteUuidV7('variant_id').references(() => productVariants.id),
    barcode: text('barcode').notNull(),
    format: text('format').notNull(),
  }),
  (self) => [
    uniqueIndex('uidx_product_barcodes_org_barcode')
      .on(self.organizationId, self.barcode)
      .where(sql`${self.deletedAtMs} IS NULL`),
    index('idx_product_barcodes_org_product')
      .on(self.organizationId, self.productId)
      .where(sql`${self.deletedAtMs} IS NULL`),
    index('idx_product_barcodes_org_variant')
      .on(self.organizationId, self.variantId)
      .where(sql`${self.variantId} IS NOT NULL AND ${self.deletedAtMs} IS NULL`),
    check('chk_product_barcodes_barcode_nonempty', sql`length(trim(${self.barcode})) >= 1`),
    check(
      'chk_product_barcodes_format',
      sql`${self.format} IN ('ean13', 'ean8', 'upca', 'internal', 'other')`,
    ),
  ],
);

/**
 * Append-only sale price change audit trail (`FACT`, T1.1).
 */
export const priceChanges = localSchemaRegistry.defineTable(
  {
    name: 'price_changes',
    tableClass: 'FACT',
    tenantScope: 'organization',
  },
  (common) => ({
    ...common,
    productId: sqliteUuidV7('product_id')
      .notNull()
      .references(() => products.id),
    variantId: sqliteUuidV7('variant_id').references(() => productVariants.id),
    oldPrice: sqliteMoney('old_price'),
    newPrice: sqliteMoney('new_price').notNull(),
    changedByUserId: sqliteUuidV7('changed_by_user_id')
      .notNull()
      .references(() => users.id),
    reason: text('reason'),
  }),
  (self) => [
    index('idx_price_changes_org_product_time').on(
      self.organizationId,
      self.productId,
      self.createdAtMs,
    ),
    check(
      'chk_price_changes_old_price_nonneg',
      sql`${self.oldPrice} IS NULL OR ${self.oldPrice} >= 0`,
    ),
    check('chk_price_changes_new_price_nonneg', sql`${self.newPrice} >= 0`),
  ],
);

/**
 * Store-scoped inbound inventory lots/batches (`FACT`, T1.2).
 * Single-writer architectural rule (`GEMINI.md` Section 4): stock batches and stock moves are
 * created strictly on the owning store's hub; server-side enforcement will be added in F2.
 */
export const batches = localSchemaRegistry.defineTable(
  {
    name: 'batches',
    tableClass: 'FACT',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    productId: sqliteUuidV7('product_id')
      .notNull()
      .references(() => products.id),
    variantId: sqliteUuidV7('variant_id').references(() => productVariants.id),
    batchNumber: text('batch_number'),
    expiryDateMs: sqliteUnixMs('expiry_date_ms'),
    initialQty: sqliteQuantity('initial_qty').notNull(),
    initialCostValue: sqliteMoney('initial_cost_value').notNull(),
    supplierId: sqliteUuidV7('supplier_id'),
  }),
  (self) => [
    index('idx_batches_store_prod_fifo').on(
      self.organizationId,
      self.storeId,
      self.productId,
      self.variantId,
      self.hlc,
      self.id,
    ),
    check('chk_batches_initial_qty_pos', sql`${self.initialQty} > 0`),
    check('chk_batches_initial_cost_nonneg', sql`${self.initialCostValue} >= 0`),
  ],
);

/**
 * Append-only store inventory movement ledger (`FACT`, T1.2).
 * Single-writer architectural rule (`GEMINI.md` Section 4): stock_moves are created strictly at
 * that store's hub (`reason` in initial/purchase/sale/return/inventory/adjustment/damaged/broken/personal/lost).
 */
export const stockMoves = localSchemaRegistry.defineTable(
  {
    name: 'stock_moves',
    tableClass: 'FACT',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    productId: sqliteUuidV7('product_id')
      .notNull()
      .references(() => products.id),
    variantId: sqliteUuidV7('variant_id').references(() => productVariants.id),
    batchId: sqliteUuidV7('batch_id').references(() => batches.id),
    qtyDelta: sqliteQuantity('qty_delta').notNull(),
    costValueDelta: sqliteMoney('cost_value_delta').notNull(),
    reason: text('reason').notNull(),
    sourceType: text('source_type').notNull(),
    sourceId: sqliteUuidV7('source_id').notNull(),
    createdByUserId: sqliteUuidV7('created_by_user_id')
      .notNull()
      .references(() => users.id),
    note: text('note'),
  }),
  (self) => [
    index('idx_stock_moves_store_prod_hlc').on(
      self.organizationId,
      self.storeId,
      self.productId,
      self.variantId,
      self.hlc,
      self.id,
    ),
    index('idx_stock_moves_store_batch').on(
      self.organizationId,
      self.storeId,
      self.batchId,
      self.hlc,
      self.id,
    ),
    index('idx_stock_moves_store_source').on(
      self.organizationId,
      self.storeId,
      self.sourceType,
      self.sourceId,
    ),
    check('chk_stock_moves_qty_nonzero', sql`${self.qtyDelta} <> 0`),
    check(
      'chk_stock_moves_sign_match',
      sql`(${self.qtyDelta} > 0 AND ${self.costValueDelta} >= 0) OR (${self.qtyDelta} < 0 AND ${self.costValueDelta} <= 0)`,
    ),
    check(
      'chk_stock_moves_reason',
      sql`${self.reason} IN ('initial', 'purchase', 'sale', 'return', 'inventory', 'adjustment', 'damaged', 'broken', 'personal', 'lost')`,
    ),
    check(
      'chk_stock_moves_source_type',
      sql`${self.sourceType} IN ('stock_entry', 'inventory_count', 'sale', 'return', 'purchase', 'adjustment')`,
    ),
  ],
);

/**
 * Physical inventory count documents (`MONOTONE`, store-scoped, T1.2).
 * One-way transition from `'open'` to `'finalized'` or `'cancelled'`.
 */
export const inventoryCounts = localSchemaRegistry.defineTable(
  {
    name: 'inventory_counts',
    tableClass: 'MONOTONE',
    tenantScope: 'store',
    monotoneColumns: ['status', 'finalized_at_ms'],
  },
  (common) => ({
    ...common,
    status: text('status').notNull().default('open'),
    startedByUserId: sqliteUuidV7('started_by_user_id')
      .notNull()
      .references(() => users.id),
    finalizedByUserId: sqliteUuidV7('finalized_by_user_id').references(() => users.id),
    finalizedAtMs: sqliteUnixMs('finalized_at_ms'),
    note: text('note'),
  }),
  (self) => [
    index('idx_inventory_counts_store_status').on(
      self.organizationId,
      self.storeId,
      self.status,
      self.createdAtMs,
    ),
    check('chk_inventory_counts_status', sql`${self.status} IN ('open', 'finalized', 'cancelled')`),
    check(
      'chk_inventory_counts_finalized_consistency',
      sql`(${self.status} = 'open' AND ${self.finalizedAtMs} IS NULL) OR (${self.status} <> 'open' AND ${self.finalizedAtMs} IS NOT NULL)`,
    ),
  ],
);

/**
 * Lines within an inventory count (`MONOTONE`, store-scoped, T1.2, S1 + S3).
 * SQLite triggers forbid inserting/modifying lines once parent count leaves `'open'`.
 */
export const inventoryCountLines = localSchemaRegistry.defineTable(
  {
    name: 'inventory_count_lines',
    tableClass: 'MONOTONE',
    tenantScope: 'store',
    monotoneColumns: ['expected_qty_at_count', 'counted_qty', 'adjustment_qty'],
  },
  (common) => ({
    ...common,
    countId: sqliteUuidV7('count_id')
      .notNull()
      .references(() => inventoryCounts.id),
    productId: sqliteUuidV7('product_id')
      .notNull()
      .references(() => products.id),
    variantId: sqliteUuidV7('variant_id').references(() => productVariants.id),
    expectedQtyAtCount: sqliteQuantity('expected_qty_at_count'),
    countedQty: sqliteQuantity('counted_qty'),
    adjustmentQty: sqliteQuantity('adjustment_qty'),
  }),
  (self) => [
    uniqueIndex('uidx_inv_count_lines_prod')
      .on(self.countId, self.productId)
      .where(sql`${self.variantId} IS NULL`),
    uniqueIndex('uidx_inv_count_lines_var')
      .on(self.countId, self.productId, self.variantId)
      .where(sql`${self.variantId} IS NOT NULL`),
    check(
      'chk_inv_count_lines_counted_snapshot',
      sql`${self.countedQty} IS NULL OR (${self.countedQty} >= 0 AND ${self.expectedQtyAtCount} IS NOT NULL)`,
    ),
  ],
);

/**
 * Non-synced local stock balance cache (`LOCAL`, T1.2).
 * Deliberately carries zero value/qty sign CHECKs (`S2`) so `rebuildStockProjections()` never fails.
 */
export const localStockBalances = localSchemaRegistry.defineTable(
  {
    name: 'local_stock_balances',
    tableClass: 'LOCAL',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    productId: sqliteUuidV7('product_id')
      .notNull()
      .references(() => products.id),
    variantId: sqliteUuidV7('variant_id').references(() => productVariants.id),
    qtyOnHand: sqliteQuantity('qty_on_hand').notNull(),
    totalValue: sqliteMoney('total_value').notNull(),
    deficitQty: sqliteQuantity('deficit_qty').notNull(),
    provisionalDeficitValue: sqliteMoney('provisional_deficit_value').notNull(),
    costVarianceValue: sqliteMoney('cost_variance_value').notNull(),
    lastUnitCost: sqliteMoney('last_unit_cost'),
  }),
  (self) => [
    uniqueIndex('uidx_local_stock_balances_prod')
      .on(self.organizationId, self.storeId, self.productId)
      .where(sql`${self.variantId} IS NULL`),
    uniqueIndex('uidx_local_stock_balances_var')
      .on(self.organizationId, self.storeId, self.productId, self.variantId)
      .where(sql`${self.variantId} IS NOT NULL`),
  ],
);

/**
 * Non-synced local FIFO batch balance cache (`LOCAL`, T1.2).
 * Deliberately carries zero non-negative CHECKs (`S2`) so rebuild always succeeds cleanly.
 */
export const localBatchBalances = localSchemaRegistry.defineTable(
  {
    name: 'local_batch_balances',
    tableClass: 'LOCAL',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    batchId: sqliteUuidV7('batch_id')
      .notNull()
      .references(() => batches.id),
    productId: sqliteUuidV7('product_id')
      .notNull()
      .references(() => products.id),
    variantId: sqliteUuidV7('variant_id').references(() => productVariants.id),
    hlc: sqliteHlc('hlc').notNull(),
    remainingQty: sqliteQuantity('remaining_qty').notNull(),
    remainingValue: sqliteMoney('remaining_value').notNull(),
  }),
  (self) => [
    uniqueIndex('uidx_local_batch_balances_batch').on(self.batchId),
    index('idx_local_batch_balances_fifo').on(
      self.organizationId,
      self.storeId,
      self.productId,
      self.variantId,
      self.hlc,
      self.batchId,
    ),
  ],
);

/**
 * Owner-visible stock anomalies detected live or during rebuild (`S2` / `S4`, `LOCAL`).
 */
export const localStockConflicts = localSchemaRegistry.defineTable(
  {
    name: 'local_stock_conflicts',
    tableClass: 'LOCAL',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    productId: sqliteUuidV7('product_id')
      .notNull()
      .references(() => products.id),
    variantId: sqliteUuidV7('variant_id').references(() => productVariants.id),
    batchId: sqliteUuidV7('batch_id'),
    moveId: sqliteUuidV7('move_id'),
    conflictQty: sqliteQuantity('conflict_qty').notNull(),
    reason: text('reason').notNull(),
    detail: text('detail'),
    resolvedAtMs: sqliteUnixMs('resolved_at_ms'),
  }),
  (self) => [
    index('idx_local_stock_conflicts_store_open').on(
      self.organizationId,
      self.storeId,
      self.resolvedAtMs,
      self.createdAtMs,
    ),
    check(
      'chk_local_stock_conflicts_reason',
      sql`${self.reason} IN ('BATCH_OVERCONSUMED', 'UNKNOWN_COST_SURPLUS', 'ORPHAN_BATCH_REFERENCE')`,
    ),
  ],
);

/**
 * Store / organization pricing promotions (`ATTR`, T1.3): percent, fixed amount per unit, or N+M (`buy_x_get_y`).
 * Validity window `[starts_at_ms, ends_at_ms)` uses half-open UTC ms boundaries; future daily/weekday
 * time-of-day rules interpret UTC+5 (`Asia/Tashkent`).
 */
export const promotions = localSchemaRegistry.defineTable(
  {
    name: 'promotions',
    tableClass: 'ATTR',
    tenantScope: 'organization',
  },
  (common) => ({
    ...common,
    targetStoreId: sqliteUuidV7('target_store_id'),
    name: text('name').notNull(),
    type: text('type').notNull(),
    scope: text('scope').notNull(),
    targetProductId: sqliteUuidV7('target_product_id').references(() => products.id),
    targetCategoryId: sqliteUuidV7('target_category_id').references(() => categories.id),
    discountPercentBp: sqliteInt('discount_percent_bp'),
    discountAmount: sqliteMoney('discount_amount'),
    buyQty: sqliteInt('buy_qty'),
    freeQty: sqliteInt('free_qty'),
    startsAtMs: sqliteUnixMs('starts_at_ms').notNull(),
    endsAtMs: sqliteUnixMs('ends_at_ms'),
    isActive: sqliteBoolean('is_active').notNull().default(true),
  }),
  (self) => [
    index('idx_promotions_org_active').on(
      self.organizationId,
      self.deletedAtMs,
      self.isActive,
      self.startsAtMs,
      self.endsAtMs,
    ),
    check('chk_promotions_name_nonempty', sql`length(trim(${self.name})) >= 1`),
    check('chk_promotions_type', sql`${self.type} IN ('percent', 'fixed_amount', 'buy_x_get_y')`),
    check('chk_promotions_scope', sql`${self.scope} IN ('product', 'category', 'all')`),
    check('chk_promotions_is_active', sql`${self.isActive} IN (0, 1)`),
    check(
      'chk_promotions_window',
      sql`${self.endsAtMs} IS NULL OR ${self.endsAtMs} > ${self.startsAtMs}`,
    ),
    check(
      'chk_promotions_scope_targets',
      sql`(${self.scope} = 'product' AND ${self.targetProductId} IS NOT NULL AND ${self.targetCategoryId} IS NULL) OR (${self.scope} = 'category' AND ${self.targetCategoryId} IS NOT NULL AND ${self.targetProductId} IS NULL) OR (${self.scope} = 'all' AND ${self.targetProductId} IS NULL AND ${self.targetCategoryId} IS NULL)`,
    ),
    check(
      'chk_promotions_type_fields',
      sql`(${self.type} = 'percent' AND ${self.discountPercentBp} BETWEEN 1 AND 10000 AND ${self.discountAmount} IS NULL AND ${self.buyQty} IS NULL AND ${self.freeQty} IS NULL) OR (${self.type} = 'fixed_amount' AND ${self.discountAmount} > 0 AND ${self.discountPercentBp} IS NULL AND ${self.buyQty} IS NULL AND ${self.freeQty} IS NULL) OR (${self.type} = 'buy_x_get_y' AND ${self.buyQty} >= 1 AND ${self.freeQty} >= 1 AND ${self.discountPercentBp} IS NULL AND ${self.discountAmount} IS NULL)`,
    ),
  ],
);

/**
 * Persistent terminal/hub carts (`LOCAL`, T1.3) for active sales & parked receipts.
 * Excluded from outbox/sync; never alters stock ledger until `T1.4 completeSale`.
 */
export const localCarts = localSchemaRegistry.defineTable(
  {
    name: 'local_carts',
    tableClass: 'LOCAL',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    cashierUserId: sqliteUuidV7('cashier_user_id')
      .notNull()
      .references(() => users.id),
    status: text('status').notNull(),
    parkLabel: text('park_label'),
    parkedAtMs: sqliteUnixMs('parked_at_ms'),
    manualDiscountMode: text('manual_discount_mode').notNull().default('none'),
    manualDiscountValue: sqliteBigint('manual_discount_value')
      .notNull()
      .default(sql`0`),
    manualDiscountReason: text('manual_discount_reason'),
    overrideApprovedByUserId: sqliteUuidV7('override_approved_by_user_id').references(
      () => users.id,
    ),
    overrideApprovedAmount: sqliteMoney('override_approved_amount'),
    overrideApprovedAtMs: sqliteUnixMs('override_approved_at_ms'),
    completedSaleId: sqliteUuidV7('completed_sale_id'),
    completedAtMs: sqliteUnixMs('completed_at_ms'),
    completionWarningsJson: text('completion_warnings_json'),
  }),
  (self) => [
    index('idx_local_carts_store_status').on(
      self.organizationId,
      self.storeId,
      self.status,
      self.updatedAtMs,
    ),
    check('chk_local_carts_status', sql`${self.status} IN ('open', 'parked', 'completed')`),
    check(
      'chk_local_carts_park_meta',
      sql`(${self.status} IN ('open', 'completed') AND ${self.parkedAtMs} IS NULL) OR (${self.status} = 'parked' AND ${self.parkedAtMs} IS NOT NULL)`,
    ),
    check(
      'chk_local_carts_completed_meta',
      sql`(${self.status} <> 'completed' AND ${self.completedSaleId} IS NULL AND ${self.completedAtMs} IS NULL) OR (${self.status} = 'completed' AND ${self.completedSaleId} IS NOT NULL AND ${self.completedAtMs} IS NOT NULL)`,
    ),
    check(
      'chk_local_carts_disc_mode',
      sql`${self.manualDiscountMode} IN ('none', 'percent', 'amount')`,
    ),
    check(
      'chk_local_carts_disc_val',
      sql`(${self.manualDiscountMode} = 'none' AND ${self.manualDiscountValue} = 0) OR (${self.manualDiscountMode} = 'percent' AND ${self.manualDiscountValue} BETWEEN 1 AND 10000) OR (${self.manualDiscountMode} = 'amount' AND ${self.manualDiscountValue} > 0)`,
    ),
    check(
      'chk_local_carts_override_pair',
      sql`(${self.overrideApprovedByUserId} IS NULL AND ${self.overrideApprovedAmount} IS NULL AND ${self.overrideApprovedAtMs} IS NULL) OR (${self.overrideApprovedByUserId} IS NOT NULL AND ${self.overrideApprovedAmount} >= 0 AND ${self.overrideApprovedAtMs} IS NOT NULL)`,
    ),
  ],
);

/**
 * Cart line snapshots (`LOCAL`, T1.3) supporting both merged catalog lines and free-text quick-sale lines.
 */
export const localCartLines = localSchemaRegistry.defineTable(
  {
    name: 'local_cart_lines',
    tableClass: 'LOCAL',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    cartId: sqliteUuidV7('cart_id')
      .notNull()
      .references(() => localCarts.id, { onDelete: 'cascade' }),
    sortOrder: sqliteInt('sort_order').notNull(),
    lineKind: text('line_kind').notNull(),
    productId: sqliteUuidV7('product_id').references(() => products.id),
    variantId: sqliteUuidV7('variant_id').references(() => productVariants.id),
    categoryIdSnapshot: sqliteUuidV7('category_id_snapshot'),
    itemName: text('item_name').notNull(),
    unit: text('unit').notNull(),
    qty: sqliteQuantity('qty').notNull(),
    unitPriceSnapshot: sqliteMoney('unit_price_snapshot').notNull(),
    mxikSnapshot: text('mxik_snapshot'),
    packageCodeSnapshot: text('package_code_snapshot'),
    vatRateBpSnapshot: sqliteInt('vat_rate_bp_snapshot').notNull().default(0),
  }),
  (self) => [
    index('idx_local_cart_lines_cart_sort').on(self.cartId, self.sortOrder, self.id),
    check('chk_local_cart_lines_sort_nonneg', sql`${self.sortOrder} >= 0`),
    check('chk_local_cart_lines_kind', sql`${self.lineKind} IN ('catalog', 'quick_sale')`),
    check(
      'chk_local_cart_lines_kind_product',
      sql`(${self.lineKind} = 'catalog' AND ${self.productId} IS NOT NULL) OR (${self.lineKind} = 'quick_sale' AND ${self.productId} IS NULL AND ${self.variantId} IS NULL)`,
    ),
    check('chk_local_cart_lines_name_nonempty', sql`length(trim(${self.itemName})) >= 1`),
    check(
      'chk_local_cart_lines_unit',
      sql`${self.unit} IN ('dona', 'kg', 'g', 'litr', 'metr', 'm2', 'qadoq')`,
    ),
    check('chk_local_cart_lines_qty_pos', sql`${self.qty} > 0`),
    check(
      'chk_local_cart_lines_unit_int',
      sql`${self.unit} NOT IN ('dona', 'qadoq') OR (${self.qty} % 1000) = 0`,
    ),
    check('chk_local_cart_lines_price_nonneg', sql`${self.unitPriceSnapshot} >= 0`),
    check(
      'chk_local_cart_lines_vat_bp',
      sql`${self.vatRateBpSnapshot} >= 0 AND ${self.vatRateBpSnapshot} <= 10000`,
    ),
  ],
);

/**
 * Completed sales receipts (`MONOTONE`, T1.4).
 * Immutable once created except one-way irreversible voiding (`voided_at_ms`, T1.6).
 * Fiscal state lives separately in F3 `fiscal_docs` so mutable fiscal retries never weaken MONOTONE guarantees.
 */
export const sales = localSchemaRegistry.defineTable(
  {
    name: 'sales',
    tableClass: 'MONOTONE',
    tenantScope: 'store',
    monotoneColumns: ['voided_at_ms'],
  },
  (common) => ({
    ...common,
    receiptNo: sqliteBigint('receipt_no').notNull(),
    receiptCode: text('receipt_code').notNull(),
    sourceCartId: sqliteUuidV7('source_cart_id'),
    cashierUserId: sqliteUuidV7('cashier_user_id')
      .notNull()
      .references(() => users.id),
    completedByUserId: sqliteUuidV7('completed_by_user_id')
      .notNull()
      .references(() => users.id),
    customerId: sqliteUuidV7('customer_id'),
    shiftId: sqliteUuidV7('shift_id'),
    clientRequestId: sqliteUuidV7('client_request_id').notNull(),
    requestHash: text('request_hash').notNull(),
    subtotalGross: sqliteMoney('subtotal_gross').notNull(),
    totalPromoDiscount: sqliteMoney('total_promo_discount').notNull(),
    subtotalAfterPromo: sqliteMoney('subtotal_after_promo').notNull(),
    manualDiscountMode: text('manual_discount_mode').notNull(),
    manualDiscountValue: sqliteBigint('manual_discount_value').notNull(),
    manualDiscountReason: text('manual_discount_reason'),
    orderDiscountAmount: sqliteMoney('order_discount_amount').notNull(),
    totalFinal: sqliteMoney('total_final').notNull(),
    totalNetExVat: sqliteMoney('total_net_ex_vat').notNull(),
    totalVat: sqliteMoney('total_vat').notNull(),
    totalPaid: sqliteMoney('total_paid').notNull(),
    debtAmount: sqliteMoney('debt_amount')
      .notNull()
      .default(sql`0`),
    changeAmount: sqliteMoney('change_amount').notNull(),
    overrideApprovedByUserId: sqliteUuidV7('override_approved_by_user_id').references(
      () => users.id,
    ),
    overrideApprovedAmount: sqliteMoney('override_approved_amount'),
    overrideApprovedAtMs: sqliteUnixMs('override_approved_at_ms'),
    voidedAtMs: sqliteUnixMs('voided_at_ms'),
    voidedByUserId: sqliteUuidV7('voided_by_user_id').references(() => users.id),
    voidReason: text('void_reason'),
    voidClientRequestId: sqliteUuidV7('void_client_request_id'),
    voidRequestHash: text('void_request_hash'),
  }),
  (self) => [
    uniqueIndex('uidx_sales_org_device_receipt_no').on(
      self.organizationId,
      self.deviceId,
      self.receiptNo,
    ),
    uniqueIndex('uidx_sales_org_client_request').on(self.organizationId, self.clientRequestId),
    uniqueIndex('uidx_sales_org_void_client_req')
      .on(self.organizationId, self.voidClientRequestId)
      .where(sql`${self.voidClientRequestId} IS NOT NULL`),
    index('idx_sales_store_created').on(self.organizationId, self.storeId, self.createdAtMs),
    index('idx_sales_store_cart').on(self.organizationId, self.storeId, self.sourceCartId),
    check('chk_sales_receipt_no_pos', sql`${self.receiptNo} >= 1`),
    check('chk_sales_receipt_code_nonempty', sql`length(trim(${self.receiptCode})) >= 1`),
    check('chk_sales_request_hash_nonempty', sql`length(trim(${self.requestHash})) >= 6`),
    check('chk_sales_disc_mode', sql`${self.manualDiscountMode} IN ('none', 'percent', 'amount')`),
    check(
      'chk_sales_disc_val',
      sql`(${self.manualDiscountMode} = 'none' AND ${self.manualDiscountValue} = 0) OR (${self.manualDiscountMode} = 'percent' AND ${self.manualDiscountValue} BETWEEN 1 AND 10000) OR (${self.manualDiscountMode} = 'amount' AND ${self.manualDiscountValue} > 0)`,
    ),
    check(
      'chk_sales_money_nonneg',
      sql`${self.subtotalGross} >= 0 AND ${self.totalPromoDiscount} >= 0 AND ${self.subtotalAfterPromo} >= 0 AND ${self.orderDiscountAmount} >= 0 AND ${self.totalFinal} >= 0 AND ${self.totalNetExVat} >= 0 AND ${self.totalVat} >= 0 AND ${self.totalPaid} >= 0 AND ${self.debtAmount} >= 0 AND ${self.changeAmount} >= 0`,
    ),
    check(
      'chk_sales_totals_balance',
      sql`${self.totalPaid} + ${self.debtAmount} = ${self.totalFinal} AND ${self.totalNetExVat} + ${self.totalVat} = ${self.totalFinal}`,
    ),
    check(
      'chk_sales_override_pair',
      sql`(${self.overrideApprovedByUserId} IS NULL AND ${self.overrideApprovedAmount} IS NULL AND ${self.overrideApprovedAtMs} IS NULL) OR (${self.overrideApprovedByUserId} IS NOT NULL AND ${self.overrideApprovedAmount} >= 0 AND ${self.overrideApprovedAtMs} IS NOT NULL)`,
    ),
    check(
      'chk_sales_void_pair',
      sql`(${self.voidedAtMs} IS NULL AND ${self.voidedByUserId} IS NULL AND ${self.voidReason} IS NULL AND ${self.voidClientRequestId} IS NULL AND ${self.voidRequestHash} IS NULL) OR (${self.voidedAtMs} IS NOT NULL AND ${self.voidedByUserId} IS NOT NULL AND ${self.voidReason} IS NOT NULL AND length(trim(${self.voidReason})) >= 1 AND ${self.voidClientRequestId} IS NOT NULL AND ${self.voidRequestHash} IS NOT NULL AND length(trim(${self.voidRequestHash})) >= 6)`,
    ),
  ],
);

/**
 * Immutable completed sale line snapshots (`FACT`, T1.4).
 * Carries full point-of-sale snapshot (`itemName`, `unitPrice`, `mxik`, `packageCode`, `vatRateBp`,
 * discounts, and FIFO/average stock `costValue` excluded from cashier API responses).
 */
export const saleLines = localSchemaRegistry.defineTable(
  {
    name: 'sale_lines',
    tableClass: 'FACT',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    saleId: sqliteUuidV7('sale_id')
      .notNull()
      .references(() => sales.id),
    sortOrder: sqliteInt('sort_order').notNull(),
    lineKind: text('line_kind').notNull(),
    productId: sqliteUuidV7('product_id').references(() => products.id),
    variantId: sqliteUuidV7('variant_id').references(() => productVariants.id),
    categoryIdSnapshot: sqliteUuidV7('category_id_snapshot'),
    itemName: text('item_name').notNull(),
    unit: text('unit').notNull(),
    qty: sqliteQuantity('qty').notNull(),
    unitPriceSnapshot: sqliteMoney('unit_price_snapshot').notNull(),
    appliedPromotionId: sqliteUuidV7('applied_promotion_id'),
    appliedPromotionName: text('applied_promotion_name'),
    freeUnits: sqliteBigint('free_units')
      .notNull()
      .default(sql`0`),
    grossTotal: sqliteMoney('gross_total').notNull(),
    promoDiscount: sqliteMoney('promo_discount').notNull(),
    subtotalAfterPromo: sqliteMoney('subtotal_after_promo').notNull(),
    allocatedOrderDiscount: sqliteMoney('allocated_order_discount').notNull(),
    finalTotal: sqliteMoney('final_total').notNull(),
    vatRateBpSnapshot: sqliteInt('vat_rate_bp_snapshot').notNull(),
    netExVat: sqliteMoney('net_ex_vat').notNull(),
    vatTotal: sqliteMoney('vat_total').notNull(),
    mxikSnapshot: text('mxik_snapshot'),
    packageCodeSnapshot: text('package_code_snapshot'),
    costValue: sqliteMoney('cost_value')
      .notNull()
      .default(sql`0`),
  }),
  (self) => [
    uniqueIndex('uidx_sale_lines_sale_sort').on(self.saleId, self.sortOrder),
    index('idx_sale_lines_store_sale').on(self.organizationId, self.storeId, self.saleId),
    check('chk_sale_lines_sort_nonneg', sql`${self.sortOrder} >= 0`),
    check('chk_sale_lines_kind', sql`${self.lineKind} IN ('catalog', 'quick_sale')`),
    check(
      'chk_sale_lines_kind_product',
      sql`(${self.lineKind} = 'catalog' AND ${self.productId} IS NOT NULL) OR (${self.lineKind} = 'quick_sale' AND ${self.productId} IS NULL AND ${self.variantId} IS NULL)`,
    ),
    check('chk_sale_lines_name_nonempty', sql`length(trim(${self.itemName})) >= 1`),
    check(
      'chk_sale_lines_unit',
      sql`${self.unit} IN ('dona', 'kg', 'g', 'litr', 'metr', 'm2', 'qadoq')`,
    ),
    check('chk_sale_lines_qty_pos', sql`${self.qty} > 0`),
    check(
      'chk_sale_lines_unit_int',
      sql`${self.unit} NOT IN ('dona', 'qadoq') OR (${self.qty} % 1000) = 0`,
    ),
    check(
      'chk_sale_lines_money_nonneg',
      sql`${self.unitPriceSnapshot} >= 0 AND ${self.freeUnits} >= 0 AND ${self.grossTotal} >= 0 AND ${self.promoDiscount} >= 0 AND ${self.subtotalAfterPromo} >= 0 AND ${self.allocatedOrderDiscount} >= 0 AND ${self.finalTotal} >= 0 AND ${self.netExVat} >= 0 AND ${self.vatTotal} >= 0 AND ${self.costValue} >= 0`,
    ),
    check(
      'chk_sale_lines_vat_bp',
      sql`${self.vatRateBpSnapshot} >= 0 AND ${self.vatRateBpSnapshot} <= 10000`,
    ),
    check(
      'chk_sale_lines_arithmetic',
      sql`${self.subtotalAfterPromo} = ${self.grossTotal} - ${self.promoDiscount} AND ${self.finalTotal} = ${self.subtotalAfterPromo} - ${self.allocatedOrderDiscount} AND ${self.netExVat} + ${self.vatTotal} = ${self.finalTotal}`,
    ),
  ],
);

/**
 * Immutable sale payment rows (`FACT`, T1.4 cash + T1.5/F3 extensible methods & provider refs).
 */
export const payments = localSchemaRegistry.defineTable(
  {
    name: 'payments',
    tableClass: 'FACT',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    saleId: sqliteUuidV7('sale_id')
      .notNull()
      .references(() => sales.id),
    method: text('method').notNull(),
    amount: sqliteMoney('amount').notNull(),
    tenderedAmount: sqliteMoney('tendered_amount'),
    changeAmount: sqliteMoney('change_amount')
      .notNull()
      .default(sql`0`),
    providerRef: text('provider_ref'),
    providerMetaJson: text('provider_meta_json'),
  }),
  (self) => [
    index('idx_payments_sale').on(self.saleId),
    index('idx_payments_store_created').on(self.organizationId, self.storeId, self.createdAtMs),
    check(
      'chk_payments_method',
      sql`${self.method} IN ('cash', 'card', 'uzqr', 'payme', 'click', 'uzum', 'social_card', 'other')`,
    ),
    check('chk_payments_nonneg', sql`${self.amount} > 0 AND ${self.changeAmount} >= 0`),
    check(
      'chk_payments_cash_balance',
      sql`(${self.method} = 'cash' AND ${self.tenderedAmount} IS NOT NULL AND ${self.tenderedAmount} > 0 AND ${self.tenderedAmount} >= ${self.amount} AND ${self.tenderedAmount} - ${self.changeAmount} = ${self.amount}) OR (${self.method} <> 'cash' AND ${self.tenderedAmount} IS NULL AND ${self.changeAmount} = 0)`,
    ),
  ],
);

/**
 * Append-only cash drawer movement ledger (`FACT`, T1.5+):
 * - Cash drawer balance = `SUM(amount_delta)` over `cash_moves` (`device_id` per terminal, `store_id` per store).
 * - `shift_id` stays nullable until T1.9 makes active shifts mandatory.
 */
export const cashMoves = localSchemaRegistry.defineTable(
  {
    name: 'cash_moves',
    tableClass: 'FACT',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    shiftId: sqliteUuidV7('shift_id'),
    type: text('type').notNull(),
    amountDelta: sqliteMoney('amount_delta').notNull(),
    sourceType: text('source_type').notNull(),
    sourceId: sqliteUuidV7('source_id').notNull(),
    paymentId: sqliteUuidV7('payment_id').references(() => payments.id),
    reason: text('reason'),
    createdByUserId: sqliteUuidV7('created_by_user_id')
      .notNull()
      .references(() => users.id),
  }),
  (self) => [
    index('idx_cash_moves_store_created').on(self.organizationId, self.storeId, self.createdAtMs),
    index('idx_cash_moves_terminal').on(
      self.organizationId,
      self.storeId,
      self.deviceId,
      self.createdAtMs,
    ),
    index('idx_cash_moves_shift_created').on(
      self.organizationId,
      self.storeId,
      self.shiftId,
      self.createdAtMs,
    ),
    index('idx_cash_moves_source').on(self.sourceType, self.sourceId),
    check(
      'chk_cash_moves_type',
      sql`${self.type} IN ('sale_cash_in', 'debt_payment_in', 'cash_in', 'sale_change_out', 'refund_cash_out', 'cash_out', 'encashment')`,
    ),
    check(
      'chk_cash_moves_amount_sign',
      sql`(${self.type} IN ('sale_cash_in', 'debt_payment_in', 'cash_in') AND ${self.amountDelta} > 0) OR (${self.type} IN ('sale_change_out', 'refund_cash_out', 'cash_out', 'encashment') AND ${self.amountDelta} < 0)`,
    ),
    check('chk_cash_moves_source_type', sql`length(trim(${self.sourceType})) >= 1`),
  ],
);

/**
 * Immutable sale return documents (`FACT`, store-scoped, T1.6).
 */
export const returns = localSchemaRegistry.defineTable(
  {
    name: 'returns',
    tableClass: 'FACT',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    saleId: sqliteUuidV7('sale_id')
      .notNull()
      .references(() => sales.id),
    returnNo: sqliteBigint('return_no').notNull(),
    returnCode: text('return_code').notNull(),
    processedByUserId: sqliteUuidV7('processed_by_user_id')
      .notNull()
      .references(() => users.id),
    overrideApprovedByUserId: sqliteUuidV7('override_approved_by_user_id').references(
      () => users.id,
    ),
    overrideApprovedAtMs: sqliteUnixMs('override_approved_at_ms'),
    reason: text('reason').notNull(),
    clientRequestId: sqliteUuidV7('client_request_id').notNull(),
    requestHash: text('request_hash').notNull(),
    totalRefund: sqliteMoney('total_refund').notNull(),
    totalNetExVat: sqliteMoney('total_net_ex_vat').notNull(),
    totalVat: sqliteMoney('total_vat').notNull(),
    cashRefundAmount: sqliteMoney('cash_refund_amount').notNull(),
    nonCashRefundAmount: sqliteMoney('non_cash_refund_amount').notNull(),
    debtOffsetAmount: sqliteMoney('debt_offset_amount')
      .notNull()
      .default(sql`0`),
  }),
  (self) => [
    uniqueIndex('uidx_returns_org_device_return_no').on(
      self.organizationId,
      self.deviceId,
      self.returnNo,
    ),
    uniqueIndex('uidx_returns_org_client_request').on(self.organizationId, self.clientRequestId),
    index('idx_returns_store_sale').on(self.organizationId, self.storeId, self.saleId),
    index('idx_returns_store_created').on(self.organizationId, self.storeId, self.createdAtMs),
    check('chk_returns_return_no_pos', sql`${self.returnNo} >= 1`),
    check('chk_returns_code_nonempty', sql`length(trim(${self.returnCode})) >= 1`),
    check('chk_returns_reason_nonempty', sql`length(trim(${self.reason})) >= 1`),
    check('chk_returns_request_hash_nonempty', sql`length(trim(${self.requestHash})) >= 6`),
    check(
      'chk_returns_money_nonneg',
      sql`${self.totalRefund} >= 0 AND ${self.totalNetExVat} >= 0 AND ${self.totalVat} >= 0 AND ${self.cashRefundAmount} >= 0 AND ${self.nonCashRefundAmount} >= 0 AND ${self.debtOffsetAmount} >= 0`,
    ),
    check(
      'chk_returns_totals_balance',
      sql`${self.cashRefundAmount} + ${self.nonCashRefundAmount} + ${self.debtOffsetAmount} = ${self.totalRefund} AND ${self.totalNetExVat} + ${self.totalVat} = ${self.totalRefund}`,
    ),
    check(
      'chk_returns_override_pair',
      sql`(${self.overrideApprovedByUserId} IS NULL AND ${self.overrideApprovedAtMs} IS NULL) OR (${self.overrideApprovedByUserId} IS NOT NULL AND ${self.overrideApprovedAtMs} IS NOT NULL)`,
    ),
  ],
);

/**
 * Immutable returned line items referencing original `sale_lines` (`FACT`, store-scoped, T1.6).
 */
export const returnLines = localSchemaRegistry.defineTable(
  {
    name: 'return_lines',
    tableClass: 'FACT',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    returnId: sqliteUuidV7('return_id')
      .notNull()
      .references(() => returns.id),
    saleId: sqliteUuidV7('sale_id')
      .notNull()
      .references(() => sales.id),
    saleLineId: sqliteUuidV7('sale_line_id')
      .notNull()
      .references(() => saleLines.id),
    sortOrder: sqliteInt('sort_order').notNull(),
    lineKind: text('line_kind').notNull(),
    productId: sqliteUuidV7('product_id').references(() => products.id),
    variantId: sqliteUuidV7('variant_id').references(() => productVariants.id),
    itemName: text('item_name').notNull(),
    unit: text('unit').notNull(),
    qty: sqliteQuantity('qty').notNull(),
    unitPriceSnapshot: sqliteMoney('unit_price_snapshot').notNull(),
    vatRateBpSnapshot: sqliteInt('vat_rate_bp_snapshot').notNull(),
    mxikSnapshot: text('mxik_snapshot'),
    packageCodeSnapshot: text('package_code_snapshot'),
    refundAmount: sqliteMoney('refund_amount').notNull(),
    netExVat: sqliteMoney('net_ex_vat').notNull(),
    vatTotal: sqliteMoney('vat_total').notNull(),
    costValue: sqliteMoney('cost_value')
      .notNull()
      .default(sql`0`),
  }),
  (self) => [
    uniqueIndex('uidx_return_lines_return_sale_line').on(self.returnId, self.saleLineId),
    uniqueIndex('uidx_return_lines_return_sort').on(self.returnId, self.sortOrder),
    index('idx_return_lines_sale_line').on(self.saleLineId),
    index('idx_return_lines_store_sale').on(self.organizationId, self.storeId, self.saleId),
    check('chk_return_lines_sort_nonneg', sql`${self.sortOrder} >= 0`),
    check('chk_return_lines_kind', sql`${self.lineKind} IN ('catalog', 'quick_sale')`),
    check(
      'chk_return_lines_kind_product',
      sql`(${self.lineKind} = 'catalog' AND ${self.productId} IS NOT NULL) OR (${self.lineKind} = 'quick_sale' AND ${self.productId} IS NULL AND ${self.variantId} IS NULL)`,
    ),
    check('chk_return_lines_name_nonempty', sql`length(trim(${self.itemName})) >= 1`),
    check(
      'chk_return_lines_unit',
      sql`${self.unit} IN ('dona', 'kg', 'g', 'litr', 'metr', 'm2', 'qadoq')`,
    ),
    check('chk_return_lines_qty_pos', sql`${self.qty} > 0`),
    check(
      'chk_return_lines_unit_int',
      sql`${self.unit} NOT IN ('dona', 'qadoq') OR (${self.qty} % 1000) = 0`,
    ),
    check(
      'chk_return_lines_money_nonneg',
      sql`${self.unitPriceSnapshot} >= 0 AND ${self.refundAmount} >= 0 AND ${self.netExVat} >= 0 AND ${self.vatTotal} >= 0 AND ${self.costValue} >= 0`,
    ),
    check(
      'chk_return_lines_vat_bp',
      sql`${self.vatRateBpSnapshot} >= 0 AND ${self.vatRateBpSnapshot} <= 10000`,
    ),
    check(
      'chk_return_lines_arithmetic',
      sql`${self.netExVat} + ${self.vatTotal} = ${self.refundAmount}`,
    ),
  ],
);

/**
 * Immutable refund payment rows for a return document (`FACT`, store-scoped, T1.6).
 */
export const returnPayments = localSchemaRegistry.defineTable(
  {
    name: 'return_payments',
    tableClass: 'FACT',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    returnId: sqliteUuidV7('return_id')
      .notNull()
      .references(() => returns.id),
    saleId: sqliteUuidV7('sale_id')
      .notNull()
      .references(() => sales.id),
    method: text('method').notNull(),
    amount: sqliteMoney('amount').notNull(),
    providerRef: text('provider_ref'),
  }),
  (self) => [
    index('idx_return_payments_return').on(self.returnId),
    index('idx_return_payments_sale').on(self.saleId),
    check(
      'chk_return_payments_method',
      sql`${self.method} IN ('cash', 'card', 'uzqr', 'payme', 'click', 'uzum', 'social_card', 'other')`,
    ),
    check('chk_return_payments_pos', sql`${self.amount} > 0`),
    check(
      'chk_return_payments_cash_no_ref',
      sql`${self.method} <> 'cash' OR ${self.providerRef} IS NULL`,
    ),
  ],
);

/**
 * Organization-wide customer directory (`ATTR`, T1.7).
 *
 * Physical DELETE is forbidden; customers with non-zero ledger balance cannot be tombstoned
 * (`CUSTOMER_HAS_OPEN_DEBT`), while `is_active = 0` disables new credit sales cleanly.
 *
 * F2 SYNC CONFLICT NOTE (D5):
 * Credit limit (`credit_limit`), unique `opening_balance`, and `balance >= 0` overpayment prevention
 * are strictly enforced on the local hub. When multiple offline stores sync in F2, concurrent
 * offline writes can trip those constraints post-sync -> surfaced in `apps/admin` as owner-visible
 * conflicts (`CREDIT_LIMIT_EXCEEDED_SYNC`, `DUPLICATE_OPENING_BALANCE`, `OVERPAYMENT_CONFLICT`).
 */
export const customers = localSchemaRegistry.defineTable(
  {
    name: 'customers',
    tableClass: 'ATTR',
    tenantScope: 'organization',
  },
  (common) => ({
    ...common,
    fullName: text('full_name').notNull(),
    nameSearch: text('name_search').notNull(),
    phoneNormalized: text('phone_normalized'),
    phoneDigits: text('phone_digits'),
    creditLimit: sqliteMoney('credit_limit'),
    defaultDueDays: sqliteInt('default_due_days'),
    note: text('note'),
    isActive: sqliteBoolean('is_active').notNull().default(true),
  }),
  (self) => [
    uniqueIndex('uidx_customers_org_phone_active')
      .on(self.organizationId, self.phoneNormalized)
      .where(sql`${self.deletedAtMs} IS NULL AND ${self.phoneNormalized} IS NOT NULL`),
    index('idx_customers_org_active_name').on(
      self.organizationId,
      self.deletedAtMs,
      self.isActive,
      self.nameSearch,
      self.id,
    ),
    index('idx_customers_org_phone_digits')
      .on(self.organizationId, self.phoneDigits)
      .where(sql`${self.deletedAtMs} IS NULL AND ${self.phoneDigits} IS NOT NULL`),
    check('chk_customers_name_nonempty', sql`length(trim(${self.fullName})) >= 1`),
    check(
      'chk_customers_phone_e164',
      sql`${self.phoneNormalized} IS NULL OR (${self.phoneNormalized} GLOB '+[1-9]*' AND length(${self.phoneNormalized}) BETWEEN 9 AND 16)`,
    ),
    check(
      'chk_customers_phone_pair',
      sql`(${self.phoneNormalized} IS NULL AND ${self.phoneDigits} IS NULL) OR (${self.phoneNormalized} IS NOT NULL AND ${self.phoneDigits} IS NOT NULL AND ${self.phoneNormalized} = ('+' || ${self.phoneDigits}))`,
    ),
    check(
      'chk_customers_credit_nonneg',
      sql`${self.creditLimit} IS NULL OR ${self.creditLimit} >= 0`,
    ),
    check(
      'chk_customers_due_days',
      sql`${self.defaultDueDays} IS NULL OR (${self.defaultDueDays} >= 1 AND ${self.defaultDueDays} <= 3650)`,
    ),
    check('chk_customers_is_active', sql`${self.isActive} IN (0, 1)`),
  ],
);

/**
 * Append-only customer debt ledger (`FACT`, store-scoped, T1.7).
 * Single source of truth for all customer debt balances, FIFO open obligations, and overdue metrics.
 *
 * Sign convention:
 * - `opening_balance` (`+`), `sale_debt` (`+`): increase customer debt
 * - `debt_payment` (`-`), `return_offset` (`-`): reduce customer debt
 * - `adjustment` (`+` or `-`): owner/manager manual correction with mandatory `reason`
 *
 * F2 SYNC CONFLICT NOTE (D5):
 * Local hub rejects duplicate `opening_balance`, excess `credit_limit` without override, and
 * negative `balance < 0` overpayments synchronously. Cross-store offline concurrency in F2 preserves
 * immutable `FACT` rows and surfaces conflicts to the owner panel (`apps/admin`).
 */
export const customerLedger = localSchemaRegistry.defineTable(
  {
    name: 'customer_ledger',
    tableClass: 'FACT',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    customerId: sqliteUuidV7('customer_id')
      .notNull()
      .references(() => customers.id),
    entryType: text('entry_type').notNull(),
    amountDelta: sqliteMoney('amount_delta').notNull(),
    sourceType: text('source_type').notNull(),
    sourceId: sqliteUuidV7('source_id').notNull(),
    saleId: sqliteUuidV7('sale_id').references(() => sales.id),
    paymentMethod: text('payment_method'),
    providerRef: text('provider_ref'),
    cashMoveId: sqliteUuidV7('cash_move_id').references(() => cashMoves.id),
    dueAtMs: sqliteUnixMs('due_at_ms'),
    reason: text('reason'),
    createdByUserId: sqliteUuidV7('created_by_user_id')
      .notNull()
      .references(() => users.id),
    overrideApprovedByUserId: sqliteUuidV7('override_approved_by_user_id').references(
      () => users.id,
    ),
    clientRequestId: sqliteUuidV7('client_request_id'),
    requestHash: text('request_hash'),
  }),
  (self) => [
    uniqueIndex('uidx_customer_ledger_opening_balance')
      .on(self.organizationId, self.customerId)
      .where(sql`${self.entryType} = 'opening_balance'`),
    uniqueIndex('uidx_customer_ledger_org_client_req')
      .on(self.organizationId, self.clientRequestId)
      .where(sql`${self.clientRequestId} IS NOT NULL`),
    index('idx_customer_ledger_cust_hlc').on(
      self.organizationId,
      self.customerId,
      self.hlc,
      self.id,
    ),
    index('idx_customer_ledger_cust_created').on(
      self.organizationId,
      self.customerId,
      self.createdAtMs,
      self.id,
    ),
    index('idx_customer_ledger_sale')
      .on(self.saleId)
      .where(sql`${self.saleId} IS NOT NULL`),
    check(
      'chk_customer_ledger_entry_type',
      sql`${self.entryType} IN ('opening_balance', 'sale_debt', 'debt_payment', 'return_offset', 'adjustment')`,
    ),
    check(
      'chk_customer_ledger_source_type',
      sql`${self.sourceType} IN ('opening_balance', 'sale', 'debt_payment', 'sale_void', 'return', 'adjustment')`,
    ),
    check(
      'chk_customer_ledger_delta_sign',
      sql`(${self.entryType} IN ('opening_balance', 'sale_debt') AND ${self.amountDelta} > 0) OR (${self.entryType} IN ('debt_payment', 'return_offset') AND ${self.amountDelta} < 0) OR (${self.entryType} = 'adjustment' AND ${self.amountDelta} <> 0)`,
    ),
    check(
      'chk_customer_ledger_payment_fields',
      sql`(${self.entryType} = 'debt_payment' AND ${self.paymentMethod} IN ('cash', 'card', 'uzqr', 'payme', 'click', 'uzum', 'social_card', 'other') AND ((${self.paymentMethod} = 'cash' AND ${self.cashMoveId} IS NOT NULL AND ${self.providerRef} IS NULL) OR (${self.paymentMethod} <> 'cash' AND ${self.cashMoveId} IS NULL))) OR (${self.entryType} <> 'debt_payment' AND ${self.paymentMethod} IS NULL AND ${self.providerRef} IS NULL AND ${self.cashMoveId} IS NULL)`,
    ),
    check(
      'chk_customer_ledger_sale_ref',
      sql`(${self.entryType} IN ('sale_debt', 'return_offset') AND ${self.saleId} IS NOT NULL) OR (${self.entryType} IN ('opening_balance', 'debt_payment', 'adjustment'))`,
    ),
    check(
      'chk_customer_ledger_reason_req',
      sql`${self.entryType} NOT IN ('opening_balance', 'adjustment') OR (${self.reason} IS NOT NULL AND length(trim(${self.reason})) >= 1)`,
    ),
    check(
      'chk_customer_ledger_req_pair',
      sql`(${self.clientRequestId} IS NULL AND ${self.requestHash} IS NULL) OR (${self.clientRequestId} IS NOT NULL AND ${self.requestHash} IS NOT NULL AND length(trim(${self.requestHash})) >= 6)`,
    ),
  ],
);

/**
 * Reconstructible derived customer balance projection (`LOCAL`, never synced, T1.7).
 * Stores fast-path lookup metrics (`balance`, `totalDebtAccrued`, `totalSettled`, `earliestOpenDueAtMs`)
 * rebuilt deterministically from `customer_ledger` via `rebuildCustomerBalances()`.
 */
export const localCustomerBalances = localSchemaRegistry.defineTable(
  {
    name: 'local_customer_balances',
    tableClass: 'LOCAL',
    tenantScope: 'organization',
  },
  (common) => ({
    ...common,
    customerId: sqliteUuidV7('customer_id')
      .notNull()
      .references(() => customers.id),
    balance: sqliteMoney('balance').notNull(),
    totalDebtAccrued: sqliteMoney('total_debt_accrued').notNull(),
    totalSettled: sqliteMoney('total_settled').notNull(),
    earliestOpenDueAtMs: sqliteUnixMs('earliest_open_due_at_ms'),
    lastActivityAtMs: sqliteUnixMs('last_activity_at_ms'),
  }),
  (self) => [
    uniqueIndex('uidx_local_customer_balances_cust').on(self.customerId),
    index('idx_local_customer_balances_org_due').on(
      self.organizationId,
      self.balance,
      self.earliestOpenDueAtMs,
      self.customerId,
    ),
    check('chk_local_customer_balances_nonneg', sql`${self.balance} >= 0`),
    check('chk_local_customer_balances_accrued_nonneg', sql`${self.totalDebtAccrued} >= 0`),
    check('chk_local_customer_balances_settled_nonneg', sql`${self.totalSettled} >= 0`),
  ],
);
