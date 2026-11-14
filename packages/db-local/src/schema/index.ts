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
    lastReceivingSeq: sqliteBigint('last_receiving_seq')
      .notNull()
      .default(sql`0`),
    lastSupplierReturnSeq: sqliteBigint('last_supplier_return_seq')
      .notNull()
      .default(sql`0`),
    lastShiftSeq: sqliteBigint('last_shift_seq')
      .notNull()
      .default(sql`0`),
    lastOrderSeq: sqliteBigint('last_order_seq')
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
    check('chk_local_device_state_receiving_nonneg', sql`${self.lastReceivingSeq} >= 0`),
    check('chk_local_device_state_sup_return_nonneg', sql`${self.lastSupplierReturnSeq} >= 0`),
    check('chk_local_device_state_shift_nonneg', sql`${self.lastShiftSeq} >= 0`),
    check('chk_local_device_state_order_nonneg', sql`${self.lastOrderSeq} >= 0`),
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
    defaultSupplierDueDays: sqliteInt('default_supplier_due_days').default(14),
    /**
     * Configurable cash discrepancy threshold above which closing/handoff/reclose requires
     * supervisor PIN override. Defaults to 10,000.00 UZS (`1_000_000` tiyin).
     */
    maxCashDiscrepancyWithoutOverride: sqliteMoney('max_cash_discrepancy_without_override')
      .notNull()
      .default(sql`1000000`),
    printerMode: text('printer_mode').notNull().default('disabled'),
    printerName: text('printer_name'),
    printerHost: text('printer_host'),
    printerPort: sqliteInt('printer_port').notNull().default(9100),
    printerTimeoutMs: sqliteInt('printer_timeout_ms').notNull().default(3000),
    printerPaperWidthMm: sqliteInt('printer_paper_width_mm').notNull().default(80),
    printerEncoding: text('printer_encoding').notNull().default('translit'),
    printerAutoPrintSale: sqliteBoolean('printer_auto_print_sale').notNull().default(true),
    printerCashDrawerAutoOpen: sqliteBoolean('printer_cash_drawer_auto_open')
      .notNull()
      .default(true),
    receiptHeaderTitle: text('receipt_header_title').notNull().default('GUZAR KASSA'),
    receiptFooterText: text('receipt_footer_text').notNull().default('Xaridingiz uchun rahmat!'),
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
    check(
      'chk_local_hub_config_sup_due_days',
      sql`${self.defaultSupplierDueDays} IS NULL OR (${self.defaultSupplierDueDays} >= 1 AND ${self.defaultSupplierDueDays} <= 3650)`,
    ),
    check(
      'chk_local_hub_config_max_cash_disc',
      sql`${self.maxCashDiscrepancyWithoutOverride} >= 0`,
    ),
    check(
      'chk_local_hub_config_printer_mode',
      sql`${self.printerMode} IN ('disabled', 'windows_raw', 'network_tcp')`,
    ),
    check(
      'chk_local_hub_config_printer_port',
      sql`${self.printerPort} >= 1 AND ${self.printerPort} <= 65535`,
    ),
    check(
      'chk_local_hub_config_printer_timeout',
      sql`${self.printerTimeoutMs} >= 200 AND ${self.printerTimeoutMs} <= 30000`,
    ),
    check('chk_local_hub_config_printer_width', sql`${self.printerPaperWidthMm} IN (58, 80)`),
    check(
      'chk_local_hub_config_printer_enc',
      sql`${self.printerEncoding} IN ('translit', 'cp866', 'cp1251')`,
    ),
    check('chk_local_hub_config_auto_print', sql`${self.printerAutoPrintSale} IN (0, 1)`),
    check('chk_local_hub_config_drawer_auto', sql`${self.printerCashDrawerAutoOpen} IN (0, 1)`),
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
      sql`${self.reason} IN ('initial', 'purchase', 'sale', 'return', 'supplier_return', 'inventory', 'adjustment', 'damaged', 'broken', 'personal', 'lost')`,
    ),
    check(
      'chk_stock_moves_source_type',
      sql`${self.sourceType} IN ('stock_entry', 'inventory_count', 'sale', 'return', 'purchase', 'supplier_return', 'adjustment')`,
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
    sourceOrderId: sqliteUuidV7('source_order_id'),
    cashierUserId: sqliteUuidV7('cashier_user_id')
      .notNull()
      .references(() => users.id),
    completedByUserId: sqliteUuidV7('completed_by_user_id')
      .notNull()
      .references(() => users.id),
    customerId: sqliteUuidV7('customer_id'),
    shiftId: sqliteUuidV7('shift_id'),
    shiftCashierSessionId: sqliteUuidV7('shift_cashier_session_id'),
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
    index('idx_sales_store_order').on(self.organizationId, self.storeId, self.sourceOrderId),
    index('idx_sales_shift_created').on(self.shiftId, self.createdAtMs),
    index('idx_sales_session').on(self.shiftCashierSessionId),
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
      sql`${self.method} IN ('cash', 'card', 'uzqr', 'payme', 'click', 'uzum', 'social_card', 'other', 'advance')`,
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
    shiftCashierSessionId: sqliteUuidV7('shift_cashier_session_id'),
    type: text('type').notNull(),
    amountDelta: sqliteMoney('amount_delta').notNull(),
    sourceType: text('source_type').notNull(),
    sourceId: sqliteUuidV7('source_id').notNull(),
    paymentId: sqliteUuidV7('payment_id').references(() => payments.id),
    expenseCategory: text('expense_category'),
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
    index('idx_cash_moves_session').on(self.shiftCashierSessionId),
    index('idx_cash_moves_source').on(self.sourceType, self.sourceId),
    check(
      'chk_cash_moves_type',
      sql`${self.type} IN ('sale_cash_in', 'debt_payment_in', 'cash_in', 'advance_cash_in', 'sale_change_out', 'refund_cash_out', 'supplier_payment_out', 'cash_out', 'encashment', 'advance_change_out', 'advance_refund_out')`,
    ),
    check(
      'chk_cash_moves_amount_sign',
      sql`(${self.type} IN ('sale_cash_in', 'debt_payment_in', 'cash_in', 'advance_cash_in') AND ${self.amountDelta} > 0) OR (${self.type} IN ('sale_change_out', 'refund_cash_out', 'supplier_payment_out', 'cash_out', 'encashment', 'advance_change_out', 'advance_refund_out') AND ${self.amountDelta} < 0)`,
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
    shiftId: sqliteUuidV7('shift_id'),
    shiftCashierSessionId: sqliteUuidV7('shift_cashier_session_id'),
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
    index('idx_returns_shift_created').on(self.shiftId, self.createdAtMs),
    index('idx_returns_session').on(self.shiftCashierSessionId),
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

/**
 * Organization-scoped vendor/supplier directory (`ATTR`, T1.8).
 * Supports Uzbekistan 9-digit STIR/TIN (`tin`) and normalized E.164/UZ phone numbers,
 * each protected by a partial UNIQUE index over active (`deleted_at_ms IS NULL`) rows.
 */
export const suppliers = localSchemaRegistry.defineTable(
  {
    name: 'suppliers',
    tableClass: 'ATTR',
    tenantScope: 'organization',
  },
  (common) => ({
    ...common,
    name: text('name').notNull(),
    nameSearch: text('name_search').notNull(),
    tin: text('tin'),
    phoneNormalized: text('phone_normalized'),
    phoneDigits: text('phone_digits'),
    contactPerson: text('contact_person'),
    note: text('note'),
    defaultDueDays: sqliteInt('default_due_days'),
    isActive: sqliteBoolean('is_active').notNull().default(true),
  }),
  (self) => [
    uniqueIndex('uidx_suppliers_org_tin_active')
      .on(self.organizationId, self.tin)
      .where(sql`${self.tin} IS NOT NULL AND ${self.deletedAtMs} IS NULL`),
    uniqueIndex('uidx_suppliers_org_phone_active')
      .on(self.organizationId, self.phoneNormalized)
      .where(sql`${self.phoneNormalized} IS NOT NULL AND ${self.deletedAtMs} IS NULL`),
    index('idx_suppliers_org_active_name')
      .on(self.organizationId, self.isActive, self.nameSearch)
      .where(sql`${self.deletedAtMs} IS NULL`),
    check('chk_suppliers_name_nonempty', sql`length(trim(${self.name})) >= 1`),
    check('chk_suppliers_tin_len', sql`${self.tin} IS NULL OR length(${self.tin}) = 9`),
    check('chk_suppliers_active', sql`${self.isActive} IN (0, 1)`),
    check(
      'chk_suppliers_due_days',
      sql`${self.defaultDueDays} IS NULL OR (${self.defaultDueDays} >= 1 AND ${self.defaultDueDays} <= 3650)`,
    ),
  ],
);

/**
 * Mutable hub-local receiving draft header (`LOCAL`, T1.8).
 * Draft edits stay out of sync outbox until posted atomically into immutable `goods_receivings`.
 */
export const localReceivingDrafts = localSchemaRegistry.defineTable(
  {
    name: 'local_receiving_drafts',
    tableClass: 'LOCAL',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    supplierId: sqliteUuidV7('supplier_id')
      .notNull()
      .references(() => suppliers.id),
    supplierInvoiceNo: text('supplier_invoice_no'),
    dueDays: sqliteInt('due_days'),
    note: text('note'),
    status: text('status').notNull().default('draft'),
    createdByUserId: sqliteUuidV7('created_by_user_id')
      .notNull()
      .references(() => users.id),
    postedAtMs: sqliteUnixMs('posted_at_ms'),
    cancelledAtMs: sqliteUnixMs('cancelled_at_ms'),
  }),
  (self) => [
    index('idx_local_rcv_drafts_store_status').on(
      self.organizationId,
      self.storeId,
      self.status,
      self.createdAtMs,
    ),
    check('chk_local_rcv_drafts_status', sql`${self.status} IN ('draft', 'posted', 'cancelled')`),
    check(
      'chk_local_rcv_drafts_due_days',
      sql`${self.dueDays} IS NULL OR (${self.dueDays} >= 1 AND ${self.dueDays} <= 3650)`,
    ),
  ],
);

/**
 * Lines inside a hub-local receiving draft (`LOCAL`, T1.8).
 */
export const localReceivingDraftLines = localSchemaRegistry.defineTable(
  {
    name: 'local_receiving_draft_lines',
    tableClass: 'LOCAL',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    draftId: sqliteUuidV7('draft_id')
      .notNull()
      .references(() => localReceivingDrafts.id),
    sortOrder: sqliteInt('sort_order').notNull(),
    productId: sqliteUuidV7('product_id')
      .notNull()
      .references(() => products.id),
    variantId: sqliteUuidV7('variant_id').references(() => productVariants.id),
    qty: sqliteQuantity('qty').notNull(),
    costUnknown: sqliteBoolean('cost_unknown').notNull(),
    totalCostValue: sqliteMoney('total_cost_value'),
    vatRateBp: sqliteInt('vat_rate_bp'),
    vatAmount: sqliteMoney('vat_amount'),
    batchNumber: text('batch_number'),
    expiryDateMs: sqliteUnixMs('expiry_date_ms'),
  }),
  (self) => [
    uniqueIndex('uidx_local_rcv_draft_lines_sort').on(self.draftId, self.sortOrder),
    index('idx_local_rcv_draft_lines_draft').on(self.draftId),
    check('chk_local_rcv_draft_lines_sort_nonneg', sql`${self.sortOrder} >= 0`),
    check('chk_local_rcv_draft_lines_qty_pos', sql`${self.qty} > 0`),
    check('chk_local_rcv_draft_lines_unknown_bool', sql`${self.costUnknown} IN (0, 1)`),
    check(
      'chk_local_rcv_draft_lines_cost_pair',
      sql`(${self.costUnknown} = 1 AND ${self.totalCostValue} IS NULL) OR (${self.costUnknown} = 0 AND ${self.totalCostValue} IS NOT NULL AND ${self.totalCostValue} >= 0)`,
    ),
    check(
      'chk_local_rcv_draft_lines_vat_bp',
      sql`${self.vatRateBp} IS NULL OR (${self.vatRateBp} >= 0 AND ${self.vatRateBp} <= 10000)`,
    ),
    check(
      'chk_local_rcv_draft_lines_vat_amt',
      sql`${self.vatAmount} IS NULL OR ${self.vatAmount} >= 0`,
    ),
  ],
);

/**
 * Immutable posted supplier goods receiving document (`FACT`, store-scoped, T1.8).
 * Subsequent cost confirmations and returns are recorded as separate FACT compensation docs.
 */
export const goodsReceivings = localSchemaRegistry.defineTable(
  {
    name: 'goods_receivings',
    tableClass: 'FACT',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    receivingNo: sqliteBigint('receiving_no').notNull(),
    receivingCode: text('receiving_code').notNull(),
    supplierId: sqliteUuidV7('supplier_id')
      .notNull()
      .references(() => suppliers.id),
    supplierInvoiceNo: text('supplier_invoice_no'),
    dueDays: sqliteInt('due_days'),
    dueAtMs: sqliteUnixMs('due_at_ms'),
    knownCostTotal: sqliteMoney('known_cost_total').notNull(),
    unknownCostLineCount: sqliteInt('unknown_cost_line_count').notNull(),
    note: text('note'),
    postedByUserId: sqliteUuidV7('posted_by_user_id')
      .notNull()
      .references(() => users.id),
    clientRequestId: sqliteUuidV7('client_request_id').notNull(),
    requestHash: text('request_hash').notNull(),
  }),
  (self) => [
    uniqueIndex('uidx_goods_receivings_org_dev_no').on(
      self.organizationId,
      self.deviceId,
      self.receivingNo,
    ),
    uniqueIndex('uidx_goods_receivings_org_client_req').on(
      self.organizationId,
      self.clientRequestId,
    ),
    index('idx_goods_receivings_store_sup').on(
      self.organizationId,
      self.storeId,
      self.supplierId,
      self.createdAtMs,
    ),
    check('chk_goods_receivings_no_pos', sql`${self.receivingNo} >= 1`),
    check('chk_goods_receivings_code_nonempty', sql`length(trim(${self.receivingCode})) >= 1`),
    check('chk_goods_receivings_known_nonneg', sql`${self.knownCostTotal} >= 0`),
    check('chk_goods_receivings_unk_cnt_nonneg', sql`${self.unknownCostLineCount} >= 0`),
    check('chk_goods_receivings_req_hash_nonempty', sql`length(trim(${self.requestHash})) >= 6`),
  ],
);

/**
 * Immutable lines inside a posted `goods_receivings` document (`FACT`, store-scoped, T1.8).
 */
export const goodsReceivingLines = localSchemaRegistry.defineTable(
  {
    name: 'goods_receiving_lines',
    tableClass: 'FACT',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    receivingId: sqliteUuidV7('receiving_id')
      .notNull()
      .references(() => goodsReceivings.id),
    sortOrder: sqliteInt('sort_order').notNull(),
    productId: sqliteUuidV7('product_id')
      .notNull()
      .references(() => products.id),
    variantId: sqliteUuidV7('variant_id').references(() => productVariants.id),
    qty: sqliteQuantity('qty').notNull(),
    costUnknown: sqliteBoolean('cost_unknown').notNull(),
    initialTotalCost: sqliteMoney('initial_total_cost').notNull(),
    vatRateBp: sqliteInt('vat_rate_bp'),
    vatAmount: sqliteMoney('vat_amount'),
    stockMoveId: sqliteUuidV7('stock_move_id')
      .notNull()
      .references(() => stockMoves.id),
    batchId: sqliteUuidV7('batch_id').references(() => batches.id),
    batchNumber: text('batch_number'),
    expiryDateMs: sqliteUnixMs('expiry_date_ms'),
  }),
  (self) => [
    uniqueIndex('uidx_goods_receiving_lines_sort').on(self.receivingId, self.sortOrder),
    uniqueIndex('uidx_goods_receiving_lines_move').on(self.stockMoveId),
    index('idx_goods_receiving_lines_rcv').on(self.receivingId),
    check('chk_goods_receiving_lines_sort_nonneg', sql`${self.sortOrder} >= 0`),
    check('chk_goods_receiving_lines_qty_pos', sql`${self.qty} > 0`),
    check('chk_goods_receiving_lines_unk_bool', sql`${self.costUnknown} IN (0, 1)`),
    check(
      'chk_goods_receiving_lines_cost_pair',
      sql`(${self.costUnknown} = 1 AND ${self.initialTotalCost} = 0) OR (${self.costUnknown} = 0 AND ${self.initialTotalCost} >= 0)`,
    ),
    check(
      'chk_goods_receiving_lines_vat_bp',
      sql`${self.vatRateBp} IS NULL OR (${self.vatRateBp} >= 0 AND ${self.vatRateBp} <= 10000)`,
    ),
    check(
      'chk_goods_receiving_lines_vat_amt',
      sql`${self.vatAmount} IS NULL OR ${self.vatAmount} >= 0`,
    ),
  ],
);

/**
 * Immutable compensation documents confirming the final cost of an initially `cost_unknown`
 * receiving line (`FACT`, store-scoped, T1.8).
 * Enforce at DB level (`uidx_receiving_cost_confirms_line`) that each line is confirmed at most once.
 */
export const receivingCostConfirmations = localSchemaRegistry.defineTable(
  {
    name: 'receiving_cost_confirmations',
    tableClass: 'FACT',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    receivingId: sqliteUuidV7('receiving_id')
      .notNull()
      .references(() => goodsReceivings.id),
    receivingLineId: sqliteUuidV7('receiving_line_id')
      .notNull()
      .references(() => goodsReceivingLines.id),
    supplierId: sqliteUuidV7('supplier_id')
      .notNull()
      .references(() => suppliers.id),
    productId: sqliteUuidV7('product_id')
      .notNull()
      .references(() => products.id),
    variantId: sqliteUuidV7('variant_id').references(() => productVariants.id),
    batchId: sqliteUuidV7('batch_id').references(() => batches.id),
    receivedQty: sqliteQuantity('received_qty').notNull(),
    confirmedTotalCost: sqliteMoney('confirmed_total_cost').notNull(),
    dueDays: sqliteInt('due_days'),
    dueAtMs: sqliteUnixMs('due_at_ms'),
    reason: text('reason').notNull(),
    confirmedByUserId: sqliteUuidV7('confirmed_by_user_id')
      .notNull()
      .references(() => users.id),
    clientRequestId: sqliteUuidV7('client_request_id').notNull(),
    requestHash: text('request_hash').notNull(),
  }),
  (self) => [
    uniqueIndex('uidx_receiving_cost_confirms_line').on(self.organizationId, self.receivingLineId),
    uniqueIndex('uidx_receiving_cost_confirms_client_req').on(
      self.organizationId,
      self.clientRequestId,
    ),
    index('idx_receiving_cost_confirms_prod').on(
      self.organizationId,
      self.storeId,
      self.productId,
      self.hlc,
    ),
    check('chk_receiving_cost_confirms_qty_pos', sql`${self.receivedQty} > 0`),
    check('chk_receiving_cost_confirms_cost_nonneg', sql`${self.confirmedTotalCost} >= 0`),
    check('chk_receiving_cost_confirms_reason_nonempty', sql`length(trim(${self.reason})) >= 1`),
    check(
      'chk_receiving_cost_confirms_req_hash_nonempty',
      sql`length(trim(${self.requestHash})) >= 6`,
    ),
  ],
);

/**
 * Immutable return-to-supplier documents against posted receivings (`FACT`, store-scoped, T1.8).
 */
export const supplierReturns = localSchemaRegistry.defineTable(
  {
    name: 'supplier_returns',
    tableClass: 'FACT',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    returnNo: sqliteBigint('return_no').notNull(),
    returnCode: text('return_code').notNull(),
    receivingId: sqliteUuidV7('receiving_id')
      .notNull()
      .references(() => goodsReceivings.id),
    supplierId: sqliteUuidV7('supplier_id')
      .notNull()
      .references(() => suppliers.id),
    reason: text('reason').notNull(),
    totalReturnCost: sqliteMoney('total_return_cost').notNull(),
    createdByUserId: sqliteUuidV7('created_by_user_id')
      .notNull()
      .references(() => users.id),
    clientRequestId: sqliteUuidV7('client_request_id').notNull(),
    requestHash: text('request_hash').notNull(),
  }),
  (self) => [
    uniqueIndex('uidx_supplier_returns_org_dev_no').on(
      self.organizationId,
      self.deviceId,
      self.returnNo,
    ),
    uniqueIndex('uidx_supplier_returns_org_client_req').on(
      self.organizationId,
      self.clientRequestId,
    ),
    index('idx_supplier_returns_rcv').on(self.receivingId),
    check('chk_supplier_returns_no_pos', sql`${self.returnNo} >= 1`),
    check('chk_supplier_returns_code_nonempty', sql`length(trim(${self.returnCode})) >= 1`),
    check('chk_supplier_returns_reason_nonempty', sql`length(trim(${self.reason})) >= 1`),
    check('chk_supplier_returns_cost_nonneg', sql`${self.totalReturnCost} >= 0`),
    check('chk_supplier_returns_req_hash_nonempty', sql`length(trim(${self.requestHash})) >= 6`),
  ],
);

/**
 * Immutable lines inside a `supplier_returns` document (`FACT`, store-scoped, T1.8).
 */
export const supplierReturnLines = localSchemaRegistry.defineTable(
  {
    name: 'supplier_return_lines',
    tableClass: 'FACT',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    supplierReturnId: sqliteUuidV7('supplier_return_id')
      .notNull()
      .references(() => supplierReturns.id),
    receivingLineId: sqliteUuidV7('receiving_line_id')
      .notNull()
      .references(() => goodsReceivingLines.id),
    sortOrder: sqliteInt('sort_order').notNull(),
    productId: sqliteUuidV7('product_id')
      .notNull()
      .references(() => products.id),
    variantId: sqliteUuidV7('variant_id').references(() => productVariants.id),
    batchId: sqliteUuidV7('batch_id').references(() => batches.id),
    stockMoveId: sqliteUuidV7('stock_move_id')
      .notNull()
      .references(() => stockMoves.id),
    qty: sqliteQuantity('qty').notNull(),
    returnCostValue: sqliteMoney('return_cost_value').notNull(),
  }),
  (self) => [
    uniqueIndex('uidx_supplier_return_lines_sort').on(self.supplierReturnId, self.sortOrder),
    uniqueIndex('uidx_supplier_return_lines_move').on(self.stockMoveId),
    index('idx_supplier_return_lines_rcv_line').on(self.receivingLineId),
    check('chk_supplier_return_lines_sort_nonneg', sql`${self.sortOrder} >= 0`),
    check('chk_supplier_return_lines_qty_pos', sql`${self.qty} > 0`),
    check('chk_supplier_return_lines_cost_nonneg', sql`${self.returnCostValue} >= 0`),
  ],
);

/**
 * Append-only supplier debt and advance ledger (`FACT`, store-scoped, T1.8).
 * Signed `amount_delta`: `+` increases Accounts Payable owed to supplier; `-` settles debt
 * or builds prepayment/advance credit (`balance < 0`).
 */
export const supplierLedger = localSchemaRegistry.defineTable(
  {
    name: 'supplier_ledger',
    tableClass: 'FACT',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    supplierId: sqliteUuidV7('supplier_id')
      .notNull()
      .references(() => suppliers.id),
    entryType: text('entry_type').notNull(),
    amountDelta: sqliteMoney('amount_delta').notNull(),
    sourceType: text('source_type').notNull(),
    sourceId: sqliteUuidV7('source_id').notNull(),
    receivingId: sqliteUuidV7('receiving_id').references(() => goodsReceivings.id),
    supplierReturnId: sqliteUuidV7('supplier_return_id').references(() => supplierReturns.id),
    paymentMethod: text('payment_method'),
    providerRef: text('provider_ref'),
    cashMoveId: sqliteUuidV7('cash_move_id').references(() => cashMoves.id),
    dueAtMs: sqliteUnixMs('due_at_ms'),
    reason: text('reason'),
    createdByUserId: sqliteUuidV7('created_by_user_id')
      .notNull()
      .references(() => users.id),
    clientRequestId: sqliteUuidV7('client_request_id'),
    requestHash: text('request_hash'),
  }),
  (self) => [
    uniqueIndex('uidx_supplier_ledger_opening_balance')
      .on(self.organizationId, self.supplierId)
      .where(sql`${self.entryType} = 'opening_balance'`),
    uniqueIndex('uidx_supplier_ledger_org_client_req')
      .on(self.organizationId, self.clientRequestId)
      .where(sql`${self.clientRequestId} IS NOT NULL`),
    index('idx_supplier_ledger_org_sup_hlc').on(
      self.organizationId,
      self.supplierId,
      self.hlc,
      self.id,
    ),
    index('idx_supplier_ledger_receiving')
      .on(self.receivingId)
      .where(sql`${self.receivingId} IS NOT NULL`),
    check(
      'chk_supplier_ledger_entry_type',
      sql`${self.entryType} IN ('opening_balance', 'receiving_debt', 'supplier_payment', 'supplier_return', 'adjustment')`,
    ),
    check(
      'chk_supplier_ledger_source_type',
      sql`${self.sourceType} IN ('opening_balance', 'receiving', 'receiving_cost_confirm', 'supplier_payment', 'supplier_return', 'adjustment')`,
    ),
    check(
      'chk_supplier_ledger_delta_sign',
      sql`(${self.entryType} IN ('opening_balance', 'receiving_debt') AND ${self.amountDelta} > 0) OR (${self.entryType} IN ('supplier_payment', 'supplier_return') AND ${self.amountDelta} < 0) OR (${self.entryType} = 'adjustment' AND ${self.amountDelta} <> 0)`,
    ),
    check(
      'chk_supplier_ledger_payment_fields',
      sql`(${self.entryType} = 'supplier_payment' AND ${self.paymentMethod} IN ('cash', 'card', 'uzqr', 'payme', 'click', 'uzum', 'other') AND ((${self.paymentMethod} = 'cash' AND ${self.cashMoveId} IS NOT NULL AND ${self.providerRef} IS NULL) OR (${self.paymentMethod} <> 'cash' AND ${self.cashMoveId} IS NULL))) OR (${self.entryType} <> 'supplier_payment' AND ${self.paymentMethod} IS NULL AND ${self.providerRef} IS NULL AND ${self.cashMoveId} IS NULL)`,
    ),
    check(
      'chk_supplier_ledger_ref_consistency',
      sql`(${self.entryType} = 'receiving_debt' AND ${self.receivingId} IS NOT NULL) OR (${self.entryType} = 'supplier_return' AND ${self.supplierReturnId} IS NOT NULL) OR (${self.entryType} IN ('opening_balance', 'supplier_payment', 'adjustment'))`,
    ),
    check(
      'chk_supplier_ledger_reason_req',
      sql`${self.entryType} NOT IN ('opening_balance', 'adjustment') OR (${self.reason} IS NOT NULL AND length(trim(${self.reason})) >= 1)`,
    ),
    check(
      'chk_supplier_ledger_req_pair',
      sql`(${self.clientRequestId} IS NULL AND ${self.requestHash} IS NULL) OR (${self.clientRequestId} IS NOT NULL AND ${self.requestHash} IS NOT NULL AND length(trim(${self.requestHash})) >= 6)`,
    ),
  ],
);

/**
 * Reconstructible derived supplier balance projection (`LOCAL`, never synced, T1.8).
 * Deliberately permits negative `balance` (`balance < 0` represents prepayment / advance credit).
 * Rebuilt deterministically from `supplier_ledger` via `rebuildSupplierBalances()`.
 */
export const localSupplierBalances = localSchemaRegistry.defineTable(
  {
    name: 'local_supplier_balances',
    tableClass: 'LOCAL',
    tenantScope: 'organization',
  },
  (common) => ({
    ...common,
    supplierId: sqliteUuidV7('supplier_id')
      .notNull()
      .references(() => suppliers.id),
    balance: sqliteMoney('balance').notNull(),
    totalDebtAccrued: sqliteMoney('total_debt_accrued').notNull(),
    totalCredited: sqliteMoney('total_credited').notNull(),
    earliestOpenDueAtMs: sqliteUnixMs('earliest_open_due_at_ms'),
    lastActivityAtMs: sqliteUnixMs('last_activity_at_ms'),
  }),
  (self) => [
    uniqueIndex('uidx_local_supplier_balances_sup').on(self.supplierId),
    index('idx_local_supplier_balances_org_due').on(
      self.organizationId,
      self.balance,
      self.earliestOpenDueAtMs,
      self.supplierId,
    ),
    check('chk_local_supplier_balances_accrued_nonneg', sql`${self.totalDebtAccrued} >= 0`),
    check('chk_local_supplier_balances_credited_nonneg', sql`${self.totalCredited} >= 0`),
  ],
);

/**
 * Store terminal cash shifts (`MONOTONE`, store-scoped, T1.9).
 * One-way irreversible lifecycle: `open` -> `closed` (`closed_at_ms` set once).
 * Enforce DB-level partial uniqueness (`uidx_shifts_one_open_per_device`) so a terminal
 * can have at most one open shift at any time.
 */
export const shifts = localSchemaRegistry.defineTable(
  {
    name: 'shifts',
    tableClass: 'MONOTONE',
    tenantScope: 'store',
    monotoneColumns: ['closed_at_ms'],
  },
  (common) => ({
    ...common,
    shiftNo: sqliteBigint('shift_no').notNull(),
    shiftCode: text('shift_code').notNull(),
    status: text('status').notNull(),
    openedByUserId: sqliteUuidV7('opened_by_user_id')
      .notNull()
      .references(() => users.id),
    closedByUserId: sqliteUuidV7('closed_by_user_id').references(() => users.id),
    openingCash: sqliteMoney('opening_cash').notNull(),
    previousCloseCash: sqliteMoney('previous_close_cash'),
    openingDiscrepancy: sqliteMoney('opening_discrepancy')
      .notNull()
      .default(sql`0`),
    openingDiscrepancyReason: text('opening_discrepancy_reason'),
    openingNote: text('opening_note'),
    closingNote: text('closing_note'),
    openedAtMs: sqliteUnixMs('opened_at_ms').notNull(),
    closedAtMs: sqliteUnixMs('closed_at_ms'),
    openClientRequestId: sqliteUuidV7('open_client_request_id').notNull(),
    openRequestHash: text('open_request_hash').notNull(),
    closeClientRequestId: sqliteUuidV7('close_client_request_id'),
    closeRequestHash: text('close_request_hash'),
  }),
  (self) => [
    uniqueIndex('uidx_shifts_org_device_no').on(self.organizationId, self.deviceId, self.shiftNo),
    uniqueIndex('uidx_shifts_one_open_per_device')
      .on(self.organizationId, self.storeId, self.deviceId)
      .where(sql`${self.status} = 'open'`),
    uniqueIndex('uidx_shifts_org_open_req').on(self.organizationId, self.openClientRequestId),
    uniqueIndex('uidx_shifts_org_close_req')
      .on(self.organizationId, self.closeClientRequestId)
      .where(sql`${self.closeClientRequestId} IS NOT NULL`),
    index('idx_shifts_store_closed').on(
      self.organizationId,
      self.storeId,
      self.status,
      self.closedAtMs,
    ),
    index('idx_shifts_store_opened').on(
      self.organizationId,
      self.storeId,
      self.status,
      self.openedAtMs,
    ),
    check('chk_shifts_no_pos', sql`${self.shiftNo} >= 1`),
    check('chk_shifts_code_nonempty', sql`length(trim(${self.shiftCode})) >= 1`),
    check('chk_shifts_status', sql`${self.status} IN ('open', 'closed')`),
    check(
      'chk_shifts_opening_nonneg',
      sql`${self.openingCash} >= 0 AND (${self.previousCloseCash} IS NULL OR ${self.previousCloseCash} >= 0)`,
    ),
    check('chk_shifts_open_req_hash', sql`length(trim(${self.openRequestHash})) >= 6`),
    check(
      'chk_shifts_open_closed_pair',
      sql`(${self.status} = 'open' AND ${self.closedAtMs} IS NULL AND ${self.closedByUserId} IS NULL AND ${self.closeClientRequestId} IS NULL AND ${self.closeRequestHash} IS NULL) OR (${self.status} = 'closed' AND ${self.closedAtMs} IS NOT NULL AND ${self.closedByUserId} IS NOT NULL AND ${self.closeClientRequestId} IS NOT NULL AND ${self.closeRequestHash} IS NOT NULL AND length(trim(${self.closeRequestHash})) >= 6 AND ${self.closedAtMs} >= ${self.openedAtMs})`,
    ),
  ],
);

/**
 * Per-cashier accountability windows inside a single shift (`MONOTONE`, store-scoped, T1.9 X2).
 * Sales, returns, and cash_moves stamp `shift_cashier_session_id` rather than inferring cashier
 * responsibility from `created_by_user_id`.
 */
export const shiftCashierSessions = localSchemaRegistry.defineTable(
  {
    name: 'shift_cashier_sessions',
    tableClass: 'MONOTONE',
    tenantScope: 'store',
    monotoneColumns: ['ended_at_ms'],
  },
  (common) => ({
    ...common,
    shiftId: sqliteUuidV7('shift_id')
      .notNull()
      .references(() => shifts.id),
    sessionSeq: sqliteInt('session_seq').notNull(),
    cashierUserId: sqliteUuidV7('cashier_user_id')
      .notNull()
      .references(() => users.id),
    status: text('status').notNull(),
    openingFloat: sqliteMoney('opening_float').notNull(),
    expectedCash: sqliteMoney('expected_cash'),
    countedCash: sqliteMoney('counted_cash'),
    discrepancy: sqliteMoney('discrepancy'),
    discrepancyReason: text('discrepancy_reason'),
    denominationsJson: text('denominations_json'),
    overrideApprovedByUserId: sqliteUuidV7('override_approved_by_user_id').references(
      () => users.id,
    ),
    handedOffByUserId: sqliteUuidV7('handed_off_by_user_id').references(() => users.id),
    note: text('note'),
    startedAtMs: sqliteUnixMs('started_at_ms').notNull(),
    endedAtMs: sqliteUnixMs('ended_at_ms'),
    handoffClientRequestId: sqliteUuidV7('handoff_client_request_id'),
    handoffRequestHash: text('handoff_request_hash'),
  }),
  (self) => [
    uniqueIndex('uidx_shift_cashier_sessions_shift_seq').on(self.shiftId, self.sessionSeq),
    uniqueIndex('uidx_shift_cashier_one_active')
      .on(self.shiftId)
      .where(sql`${self.status} = 'active'`),
    uniqueIndex('uidx_shift_cashier_handoff_req')
      .on(self.organizationId, self.handoffClientRequestId)
      .where(sql`${self.handoffClientRequestId} IS NOT NULL`),
    index('idx_shift_cashier_sessions_shift').on(self.shiftId, self.sessionSeq),
    check('chk_shift_cashier_seq_pos', sql`${self.sessionSeq} >= 1`),
    check('chk_shift_cashier_status', sql`${self.status} IN ('active', 'closed')`),
    check('chk_shift_cashier_float_nonneg', sql`${self.openingFloat} >= 0`),
    check(
      'chk_shift_cashier_closed_fields',
      sql`(${self.status} = 'active' AND ${self.expectedCash} IS NULL AND ${self.countedCash} IS NULL AND ${self.discrepancy} IS NULL AND ${self.endedAtMs} IS NULL) OR (${self.status} = 'closed' AND ${self.expectedCash} IS NOT NULL AND ${self.countedCash} IS NOT NULL AND ${self.countedCash} >= 0 AND ${self.discrepancy} IS NOT NULL AND ${self.endedAtMs} IS NOT NULL AND ${self.endedAtMs} >= ${self.startedAtMs})`,
    ),
    check(
      'chk_shift_cashier_handoff_req_pair',
      sql`(${self.handoffClientRequestId} IS NULL AND ${self.handoffRequestHash} IS NULL) OR (${self.handoffClientRequestId} IS NOT NULL AND ${self.handoffRequestHash} IS NOT NULL AND length(trim(${self.handoffRequestHash})) >= 6)`,
    ),
  ],
);

/**
 * Append-only immutable Z/shift closure snapshots (`FACT`, store-scoped, T1.9).
 * Initial close writes `closure_seq = 1, is_reclose = 0`.
 * Reclose appends `closure_seq = N + 1, is_reclose = 1` with mandatory reason — history is NEVER overwritten.
 */
export const shiftClosures = localSchemaRegistry.defineTable(
  {
    name: 'shift_closures',
    tableClass: 'FACT',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    shiftId: sqliteUuidV7('shift_id')
      .notNull()
      .references(() => shifts.id),
    closureSeq: sqliteInt('closure_seq').notNull(),
    isReclose: sqliteBoolean('is_reclose').notNull().default(false),
    reason: text('reason'),
    closedByUserId: sqliteUuidV7('closed_by_user_id')
      .notNull()
      .references(() => users.id),
    overrideApprovedByUserId: sqliteUuidV7('override_approved_by_user_id').references(
      () => users.id,
    ),
    clientRequestId: sqliteUuidV7('client_request_id').notNull(),
    requestHash: text('request_hash').notNull(),
    expectedCash: sqliteMoney('expected_cash').notNull(),
    countedCash: sqliteMoney('counted_cash').notNull(),
    discrepancy: sqliteMoney('discrepancy').notNull(),
    denominationsJson: text('denominations_json'),
    salesCount: sqliteInt('sales_count').notNull(),
    returnsCount: sqliteInt('returns_count').notNull(),
    voidsCount: sqliteInt('voids_count').notNull(),
    grossSalesTotal: sqliteMoney('gross_sales_total').notNull(),
    returnsTotal: sqliteMoney('returns_total').notNull(),
    netSalesTotal: sqliteMoney('net_sales_total').notNull(),
    orderAdvanceCashTotal: sqliteMoney('order_advance_cash_total')
      .notNull()
      .default(sql`0`),
    orderAdvanceNonCashTotal: sqliteMoney('order_advance_non_cash_total')
      .notNull()
      .default(sql`0`),
    orderAdvanceRefundTotal: sqliteMoney('order_advance_refund_total')
      .notNull()
      .default(sql`0`),
  }),
  (self) => [
    uniqueIndex('uidx_shift_closures_shift_seq').on(self.shiftId, self.closureSeq),
    uniqueIndex('uidx_shift_closures_org_req').on(self.organizationId, self.clientRequestId),
    index('idx_shift_closures_shift_seq').on(self.shiftId, self.closureSeq),
    check('chk_shift_closures_seq_pos', sql`${self.closureSeq} >= 1`),
    check('chk_shift_closures_reclose_bool', sql`${self.isReclose} IN (0, 1)`),
    check(
      'chk_shift_closures_reclose_reason',
      sql`${self.isReclose} = 0 OR (${self.reason} IS NOT NULL AND length(trim(${self.reason})) >= 1)`,
    ),
    check('chk_shift_closures_req_hash', sql`length(trim(${self.requestHash})) >= 6`),
    check(
      'chk_shift_closures_money_nonneg',
      sql`${self.countedCash} >= 0 AND ${self.grossSalesTotal} >= 0 AND ${self.returnsTotal} >= 0 AND ${self.orderAdvanceCashTotal} >= 0 AND ${self.orderAdvanceNonCashTotal} >= 0 AND ${self.orderAdvanceRefundTotal} >= 0`,
    ),
    check(
      'chk_shift_closures_counts_nonneg',
      sql`${self.salesCount} >= 0 AND ${self.returnsCount} >= 0 AND ${self.voidsCount} >= 0`,
    ),
  ],
);

/**
 * Append-only payment-method breakdown child rows of `shift_closures` (`FACT`, store-scoped, T1.9).
 * Computed strictly from `payments` / `return_payments` (`amount`, never subtracting change twice) + `debt`.
 */
export const shiftClosureMethodTotals = localSchemaRegistry.defineTable(
  {
    name: 'shift_closure_method_totals',
    tableClass: 'FACT',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    shiftClosureId: sqliteUuidV7('shift_closure_id')
      .notNull()
      .references(() => shiftClosures.id),
    method: text('method').notNull(),
    salesAmount: sqliteMoney('sales_amount').notNull(),
    returnsAmount: sqliteMoney('returns_amount').notNull(),
    netAmount: sqliteMoney('net_amount').notNull(),
  }),
  (self) => [
    uniqueIndex('uidx_shift_closure_methods').on(self.shiftClosureId, self.method),
    check(
      'chk_shift_closure_methods_enum',
      sql`${self.method} IN ('cash', 'card', 'uzqr', 'payme', 'click', 'uzum', 'social_card', 'other', 'advance', 'debt')`,
    ),
    check(
      'chk_shift_closure_methods_nonneg',
      sql`${self.salesAmount} >= 0 AND ${self.returnsAmount} >= 0`,
    ),
  ],
);

/**
 * Append-only per-cashier-session accountability snapshot rows of `shift_closures` (`FACT`, store-scoped, T1.9 X2).
 */
export const shiftClosureCashiers = localSchemaRegistry.defineTable(
  {
    name: 'shift_closure_cashiers',
    tableClass: 'FACT',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    shiftClosureId: sqliteUuidV7('shift_closure_id')
      .notNull()
      .references(() => shiftClosures.id),
    sessionId: sqliteUuidV7('session_id')
      .notNull()
      .references(() => shiftCashierSessions.id),
    cashierUserId: sqliteUuidV7('cashier_user_id')
      .notNull()
      .references(() => users.id),
    sessionSeq: sqliteInt('session_seq').notNull(),
    openingFloat: sqliteMoney('opening_float').notNull(),
    expectedCash: sqliteMoney('expected_cash').notNull(),
    countedCash: sqliteMoney('counted_cash').notNull(),
    discrepancy: sqliteMoney('discrepancy').notNull(),
    salesCount: sqliteInt('sales_count').notNull(),
    returnsCount: sqliteInt('returns_count').notNull(),
    salesTotal: sqliteMoney('sales_total').notNull(),
    returnsTotal: sqliteMoney('returns_total').notNull(),
    cashInTotal: sqliteMoney('cash_in_total').notNull(),
    cashOutTotal: sqliteMoney('cash_out_total').notNull(),
  }),
  (self) => [
    uniqueIndex('uidx_shift_closure_cashiers_sess').on(self.shiftClosureId, self.sessionId),
    check(
      'chk_shift_closure_cashiers_nonneg',
      sql`${self.sessionSeq} >= 1 AND ${self.openingFloat} >= 0 AND ${self.countedCash} >= 0 AND ${self.salesCount} >= 0 AND ${self.returnsCount} >= 0 AND ${self.salesTotal} >= 0 AND ${self.returnsTotal} >= 0 AND ${self.cashInTotal} >= 0 AND ${self.cashOutTotal} >= 0`,
    ),
  ],
);

/**
 * Append-only store-wide business day Z-close snapshots (`FACT`, store-scoped, T1.9 X4).
 * Re-closing after a shift reclose appends `close_seq = N + 1` while older snapshots remain intact
 * (`isStale` computed dynamically against latest `shift_closures` IDs vs `included_closure_ids_json`).
 */
export const dayCloses = localSchemaRegistry.defineTable(
  {
    name: 'day_closes',
    tableClass: 'FACT',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    businessDate: text('business_date').notNull(),
    closeSeq: sqliteInt('close_seq').notNull(),
    closeCode: text('close_code').notNull(),
    closedByUserId: sqliteUuidV7('closed_by_user_id')
      .notNull()
      .references(() => users.id),
    clientRequestId: sqliteUuidV7('client_request_id').notNull(),
    requestHash: text('request_hash').notNull(),
    note: text('note'),
    shiftsCount: sqliteInt('shifts_count').notNull(),
    salesCount: sqliteInt('sales_count').notNull(),
    returnsCount: sqliteInt('returns_count').notNull(),
    voidsCount: sqliteInt('voids_count').notNull(),
    grossSalesTotal: sqliteMoney('gross_sales_total').notNull(),
    returnsTotal: sqliteMoney('returns_total').notNull(),
    netSalesTotal: sqliteMoney('net_sales_total').notNull(),
    expectedCashTotal: sqliteMoney('expected_cash_total').notNull(),
    countedCashTotal: sqliteMoney('counted_cash_total').notNull(),
    discrepancyTotal: sqliteMoney('discrepancy_total').notNull(),
    methodTotalsJson: text('method_totals_json').notNull(),
    includedClosureIdsJson: text('included_closure_ids_json').notNull(),
    fiscalStatus: text('fiscal_status').notNull().default('not_fiscalized'),
    fiscalReportNo: text('fiscal_report_no'),
  }),
  (self) => [
    uniqueIndex('uidx_day_closes_store_date_seq').on(
      self.organizationId,
      self.storeId,
      self.businessDate,
      self.closeSeq,
    ),
    uniqueIndex('uidx_day_closes_org_req').on(self.organizationId, self.clientRequestId),
    index('idx_day_closes_store_date').on(
      self.organizationId,
      self.storeId,
      self.businessDate,
      self.closeSeq,
    ),
    check('chk_day_closes_seq_pos', sql`${self.closeSeq} >= 1`),
    check('chk_day_closes_date_len', sql`length(${self.businessDate}) = 10`),
    check('chk_day_closes_code_nonempty', sql`length(trim(${self.closeCode})) >= 1`),
    check('chk_day_closes_req_hash', sql`length(trim(${self.requestHash})) >= 6`),
    check(
      'chk_day_closes_fiscal_status',
      sql`${self.fiscalStatus} IN ('not_fiscalized', 'pending', 'fiscalized')`,
    ),
    check(
      'chk_day_closes_nonneg',
      sql`${self.shiftsCount} >= 0 AND ${self.salesCount} >= 0 AND ${self.returnsCount} >= 0 AND ${self.voidsCount} >= 0 AND ${self.grossSalesTotal} >= 0 AND ${self.returnsTotal} >= 0 AND ${self.countedCashTotal} >= 0`,
    ),
  ],
);

/**
 * Customer orders (`MONOTONE`, store-scoped, T1.10).
 * Prices, promotions, discounts, and VAT are evaluated ONCE at creation (O3) and frozen.
 * Unidirectional status machine (`draft -> confirmed|cancelled`, `confirmed|ready -> delivered|cancelled`,
 * terminal states `delivered` & `cancelled` locked via SQLite triggers).
 */
export const orders = localSchemaRegistry.defineTable(
  {
    name: 'orders',
    tableClass: 'MONOTONE',
    tenantScope: 'store',
    monotoneColumns: ['status', 'delivered_at_ms', 'cancelled_at_ms'],
  },
  (common) => ({
    ...common,
    originDeviceId: sqliteUuidV7('origin_device_id').notNull(),
    orderNo: sqliteBigint('order_no').notNull(),
    orderCode: text('order_code').notNull(),
    status: text('status').notNull(),
    customerId: sqliteUuidV7('customer_id').references(() => customers.id),
    customerName: text('customer_name').notNull(),
    customerPhoneNormalized: text('customer_phone_normalized'),
    dueAtMs: sqliteUnixMs('due_at_ms'),
    note: text('note'),
    subtotalGross: sqliteMoney('subtotal_gross').notNull(),
    totalPromoDiscount: sqliteMoney('total_promo_discount').notNull(),
    subtotalAfterPromo: sqliteMoney('subtotal_after_promo').notNull(),
    manualDiscountMode: text('manual_discount_mode').notNull(),
    manualDiscountValue: sqliteBigint('manual_discount_value').notNull(),
    manualDiscountReason: text('manual_discount_reason'),
    orderDiscountAmount: sqliteMoney('order_discount_amount').notNull(),
    totalAmount: sqliteMoney('total_amount').notNull(),
    totalNetExVat: sqliteMoney('total_net_ex_vat').notNull(),
    totalVat: sqliteMoney('total_vat').notNull(),
    overrideApprovedByUserId: sqliteUuidV7('override_approved_by_user_id').references(
      () => users.id,
    ),
    overrideApprovedAmount: sqliteMoney('override_approved_amount'),
    createdByUserId: sqliteUuidV7('created_by_user_id')
      .notNull()
      .references(() => users.id),
    confirmedAtMs: sqliteUnixMs('confirmed_at_ms'),
    readyAtMs: sqliteUnixMs('ready_at_ms'),
    deliveredAtMs: sqliteUnixMs('delivered_at_ms'),
    deliveredSaleId: sqliteUuidV7('delivered_sale_id').references(() => sales.id),
    cancelledAtMs: sqliteUnixMs('cancelled_at_ms'),
    cancelledByUserId: sqliteUuidV7('cancelled_by_user_id').references(() => users.id),
    cancelReason: text('cancel_reason'),
    createClientRequestId: sqliteUuidV7('create_client_request_id').notNull(),
    createRequestHash: text('create_request_hash').notNull(),
    confirmClientRequestId: sqliteUuidV7('confirm_client_request_id'),
    confirmRequestHash: text('confirm_request_hash'),
    readyClientRequestId: sqliteUuidV7('ready_client_request_id'),
    readyRequestHash: text('ready_request_hash'),
    deliverClientRequestId: sqliteUuidV7('deliver_client_request_id'),
    deliverRequestHash: text('deliver_request_hash'),
    cancelClientRequestId: sqliteUuidV7('cancel_client_request_id'),
    cancelRequestHash: text('cancel_request_hash'),
  }),
  (self) => [
    uniqueIndex('uidx_orders_org_origin_device_no').on(
      self.organizationId,
      self.originDeviceId,
      self.orderNo,
    ),
    uniqueIndex('uidx_orders_org_create_req').on(self.organizationId, self.createClientRequestId),
    uniqueIndex('uidx_orders_org_confirm_req')
      .on(self.organizationId, self.confirmClientRequestId)
      .where(sql`${self.confirmClientRequestId} IS NOT NULL`),
    uniqueIndex('uidx_orders_org_ready_req')
      .on(self.organizationId, self.readyClientRequestId)
      .where(sql`${self.readyClientRequestId} IS NOT NULL`),
    uniqueIndex('uidx_orders_org_deliver_req')
      .on(self.organizationId, self.deliverClientRequestId)
      .where(sql`${self.deliverClientRequestId} IS NOT NULL`),
    uniqueIndex('uidx_orders_org_cancel_req')
      .on(self.organizationId, self.cancelClientRequestId)
      .where(sql`${self.cancelClientRequestId} IS NOT NULL`),
    index('idx_orders_store_status_created').on(
      self.organizationId,
      self.storeId,
      self.status,
      self.createdAtMs,
    ),
    index('idx_orders_store_customer').on(
      self.organizationId,
      self.storeId,
      self.customerId,
      self.createdAtMs,
    ),
    check('chk_orders_no_pos', sql`${self.orderNo} >= 1`),
    check('chk_orders_code_nonempty', sql`length(trim(${self.orderCode})) >= 1`),
    check(
      'chk_orders_status',
      sql`${self.status} IN ('draft', 'confirmed', 'ready', 'delivered', 'cancelled')`,
    ),
    check('chk_orders_cust_name_nonempty', sql`length(trim(${self.customerName})) >= 1`),
    check('chk_orders_create_req_hash', sql`length(trim(${self.createRequestHash})) >= 6`),
    check('chk_orders_disc_mode', sql`${self.manualDiscountMode} IN ('none', 'percent', 'amount')`),
    check(
      'chk_orders_disc_val',
      sql`(${self.manualDiscountMode} = 'none' AND ${self.manualDiscountValue} = 0) OR (${self.manualDiscountMode} = 'percent' AND ${self.manualDiscountValue} BETWEEN 1 AND 10000) OR (${self.manualDiscountMode} = 'amount' AND ${self.manualDiscountValue} > 0)`,
    ),
    check(
      'chk_orders_money_nonneg',
      sql`${self.subtotalGross} >= 0 AND ${self.totalPromoDiscount} >= 0 AND ${self.subtotalAfterPromo} >= 0 AND ${self.orderDiscountAmount} >= 0 AND ${self.totalAmount} >= 0 AND ${self.totalNetExVat} >= 0 AND ${self.totalVat} >= 0`,
    ),
    check(
      'chk_orders_totals_balance',
      sql`${self.totalNetExVat} + ${self.totalVat} = ${self.totalAmount}`,
    ),
    check(
      'chk_orders_override_pair',
      sql`(${self.overrideApprovedByUserId} IS NULL AND ${self.overrideApprovedAmount} IS NULL) OR (${self.overrideApprovedByUserId} IS NOT NULL AND ${self.overrideApprovedAmount} >= 0)`,
    ),
    check(
      'chk_orders_delivered_pair',
      sql`(${self.status} <> 'delivered' AND ${self.deliveredAtMs} IS NULL AND ${self.deliveredSaleId} IS NULL) OR (${self.status} = 'delivered' AND ${self.deliveredAtMs} IS NOT NULL AND ${self.deliveredSaleId} IS NOT NULL)`,
    ),
    check(
      'chk_orders_cancelled_pair',
      sql`(${self.status} <> 'cancelled' AND ${self.cancelledAtMs} IS NULL AND ${self.cancelledByUserId} IS NULL AND ${self.cancelReason} IS NULL) OR (${self.status} = 'cancelled' AND ${self.cancelledAtMs} IS NOT NULL AND ${self.cancelledByUserId} IS NOT NULL AND ${self.cancelReason} IS NOT NULL AND length(trim(${self.cancelReason})) >= 1)`,
    ),
  ],
);

/**
 * Immutable evaluated order line snapshots (`FACT`, store-scoped, T1.10).
 * Captures O3 evaluation results once at creation so `deliverOrder` reuses them verbatim (O2).
 */
export const orderLines = localSchemaRegistry.defineTable(
  {
    name: 'order_lines',
    tableClass: 'FACT',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    orderId: sqliteUuidV7('order_id')
      .notNull()
      .references(() => orders.id),
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
  }),
  (self) => [
    uniqueIndex('uidx_order_lines_order_sort').on(self.orderId, self.sortOrder),
    index('idx_order_lines_store_order').on(self.organizationId, self.storeId, self.orderId),
    check('chk_order_lines_sort_nonneg', sql`${self.sortOrder} >= 0`),
    check('chk_order_lines_kind', sql`${self.lineKind} IN ('catalog', 'quick_sale')`),
    check(
      'chk_order_lines_kind_product',
      sql`(${self.lineKind} = 'catalog' AND ${self.productId} IS NOT NULL) OR (${self.lineKind} = 'quick_sale' AND ${self.productId} IS NULL AND ${self.variantId} IS NULL)`,
    ),
    check('chk_order_lines_name_nonempty', sql`length(trim(${self.itemName})) >= 1`),
    check(
      'chk_order_lines_unit',
      sql`${self.unit} IN ('dona', 'kg', 'g', 'litr', 'metr', 'm2', 'qadoq')`,
    ),
    check('chk_order_lines_qty_pos', sql`${self.qty} > 0`),
    check(
      'chk_order_lines_unit_int',
      sql`${self.unit} NOT IN ('dona', 'qadoq') OR (${self.qty} % 1000) = 0`,
    ),
    check(
      'chk_order_lines_money_nonneg',
      sql`${self.unitPriceSnapshot} >= 0 AND ${self.freeUnits} >= 0 AND ${self.grossTotal} >= 0 AND ${self.promoDiscount} >= 0 AND ${self.subtotalAfterPromo} >= 0 AND ${self.allocatedOrderDiscount} >= 0 AND ${self.finalTotal} >= 0 AND ${self.netExVat} >= 0 AND ${self.vatTotal} >= 0`,
    ),
    check(
      'chk_order_lines_vat_bp',
      sql`${self.vatRateBpSnapshot} >= 0 AND ${self.vatRateBpSnapshot} <= 10000`,
    ),
    check(
      'chk_order_lines_arithmetic',
      sql`${self.subtotalAfterPromo} = ${self.grossTotal} - ${self.promoDiscount} AND ${self.finalTotal} = ${self.subtotalAfterPromo} - ${self.allocatedOrderDiscount} AND ${self.netExVat} + ${self.vatTotal} = ${self.finalTotal}`,
    ),
  ],
);

/**
 * Append-only customer order advance ledger (`FACT`, store-scoped, T1.10).
 * Every advance intake (`kind = 'advance'`) and advance refund (`kind = 'advance_refund'`) binds
 * to the active shift & cashier session; does NOT enter sales revenue (`v_sales_lines`) until
 * delivery settles `'advance'` inside `completeSale`.
 */
export const orderPayments = localSchemaRegistry.defineTable(
  {
    name: 'order_payments',
    tableClass: 'FACT',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    orderId: sqliteUuidV7('order_id')
      .notNull()
      .references(() => orders.id),
    shiftId: sqliteUuidV7('shift_id')
      .notNull()
      .references(() => shifts.id),
    shiftCashierSessionId: sqliteUuidV7('shift_cashier_session_id')
      .notNull()
      .references(() => shiftCashierSessions.id),
    kind: text('kind').notNull(),
    method: text('method').notNull(),
    amount: sqliteMoney('amount').notNull(),
    tenderedAmount: sqliteMoney('tendered_amount'),
    changeAmount: sqliteMoney('change_amount')
      .notNull()
      .default(sql`0`),
    providerRef: text('provider_ref'),
    reason: text('reason'),
    createdByUserId: sqliteUuidV7('created_by_user_id')
      .notNull()
      .references(() => users.id),
    overrideApprovedByUserId: sqliteUuidV7('override_approved_by_user_id').references(
      () => users.id,
    ),
    seq: sqliteInt('seq').notNull().default(0),
    clientRequestId: sqliteUuidV7('client_request_id').notNull(),
    requestHash: text('request_hash').notNull(),
  }),
  (self) => [
    uniqueIndex('uidx_order_payments_org_req_seq').on(
      self.organizationId,
      self.clientRequestId,
      self.seq,
    ),
    index('idx_order_payments_order').on(self.orderId, self.createdAtMs, self.id),
    index('idx_order_payments_shift').on(self.shiftId, self.createdAtMs, self.id),
    index('idx_order_payments_store_kind').on(self.organizationId, self.storeId, self.kind),
    check('chk_order_payments_seq_nonneg', sql`${self.seq} >= 0`),
    check('chk_order_payments_kind', sql`${self.kind} IN ('advance', 'advance_refund')`),
    check(
      'chk_order_payments_method',
      sql`${self.method} IN ('cash', 'card', 'uzqr', 'payme', 'click', 'uzum', 'social_card', 'other')`,
    ),
    check('chk_order_payments_amt_pos', sql`${self.amount} > 0 AND ${self.changeAmount} >= 0`),
    check('chk_order_payments_req_hash', sql`length(trim(${self.requestHash})) >= 6`),
    check(
      'chk_order_payments_cash_pair',
      sql`(${self.kind} = 'advance' AND ${self.method} = 'cash' AND ${self.tenderedAmount} IS NOT NULL AND ${self.tenderedAmount} >= ${self.amount} AND ${self.tenderedAmount} - ${self.changeAmount} = ${self.amount}) OR ((${self.kind} <> 'advance' OR ${self.method} <> 'cash') AND ${self.tenderedAmount} IS NULL AND ${self.changeAmount} = 0)`,
    ),
    check(
      'chk_order_payments_refund_reason',
      sql`${self.kind} <> 'advance_refund' OR (${self.reason} IS NOT NULL AND length(trim(${self.reason})) >= 1)`,
    ),
  ],
);

/**
 * Local terminal receipt print audit log (`LOCAL`, store-scoped, T1.12).
 * Tracks every print/reprint attempt (`sale`, `return`, `shift_close`) with idempotent `client_request_id`,
 * monotonic `print_seq`, and `copy_number` (`1` for original, `2+` for `NUSXA`).
 */
export const localReceiptPrints = localSchemaRegistry.defineTable(
  {
    name: 'local_receipt_prints',
    tableClass: 'LOCAL',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    documentType: text('document_type').notNull(),
    documentId: sqliteUuidV7('document_id').notNull(),
    printSeq: sqliteInt('print_seq').notNull(),
    copyNumber: sqliteInt('copy_number').notNull(),
    isReprint: sqliteBoolean('is_reprint').notNull().default(false),
    actorUserId: sqliteUuidV7('actor_user_id')
      .notNull()
      .references(() => users.id),
    status: text('status').notNull(),
    printerMode: text('printer_mode').notNull(),
    printerTarget: text('printer_target'),
    bytesSent: sqliteInt('bytes_sent').notNull().default(0),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    textPreview: text('text_preview').notNull(),
    clientRequestId: sqliteUuidV7('client_request_id').notNull(),
  }),
  (self) => [
    uniqueIndex('uidx_local_receipt_prints_org_req').on(self.organizationId, self.clientRequestId),
    uniqueIndex('uidx_local_receipt_prints_doc_seq').on(
      self.organizationId,
      self.storeId,
      self.documentType,
      self.documentId,
      self.printSeq,
    ),
    index('idx_local_receipt_prints_doc').on(
      self.organizationId,
      self.storeId,
      self.documentType,
      self.documentId,
    ),
    check(
      'chk_local_receipt_prints_doc_type',
      sql`${self.documentType} IN ('sale', 'return', 'shift_close')`,
    ),
    check(
      'chk_local_receipt_prints_seq_pos',
      sql`${self.printSeq} >= 1 AND ${self.copyNumber} >= 1`,
    ),
    check('chk_local_receipt_prints_reprint_bool', sql`${self.isReprint} IN (0, 1)`),
    check(
      'chk_local_receipt_prints_status',
      sql`${self.status} IN ('printed', 'failed', 'disabled')`,
    ),
    check(
      'chk_local_receipt_prints_mode',
      sql`${self.printerMode} IN ('disabled', 'windows_raw', 'network_tcp')`,
    ),
    check('chk_local_receipt_prints_bytes_nonneg', sql`${self.bytesSent} >= 0`),
  ],
);

/**
 * Local terminal manual cash drawer open audit log (`LOCAL`, store-scoped, T1.12).
 * Enforces idempotency via `client_request_id` and records `actor_user_id`, optional
 * `override_approved_by_user_id`, `shift_id`, mandatory `reason`, and printer outcome.
 */
export const localCashDrawerEvents = localSchemaRegistry.defineTable(
  {
    name: 'local_cash_drawer_events',
    tableClass: 'LOCAL',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    shiftId: sqliteUuidV7('shift_id').references(() => shifts.id),
    actorUserId: sqliteUuidV7('actor_user_id')
      .notNull()
      .references(() => users.id),
    overrideApprovedByUserId: sqliteUuidV7('override_approved_by_user_id').references(
      () => users.id,
    ),
    reason: text('reason').notNull(),
    status: text('status').notNull(),
    printerMode: text('printer_mode').notNull(),
    printerTarget: text('printer_target'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    clientRequestId: sqliteUuidV7('client_request_id').notNull(),
  }),
  (self) => [
    uniqueIndex('uidx_local_cash_drawer_events_org_req').on(
      self.organizationId,
      self.clientRequestId,
    ),
    index('idx_local_cash_drawer_events_store_created').on(
      self.organizationId,
      self.storeId,
      self.createdAtMs,
    ),
    check('chk_local_cash_drawer_events_reason', sql`length(trim(${self.reason})) >= 1`),
    check(
      'chk_local_cash_drawer_events_status',
      sql`${self.status} IN ('printed', 'failed', 'disabled')`,
    ),
    check(
      'chk_local_cash_drawer_events_mode',
      sql`${self.printerMode} IN ('disabled', 'windows_raw', 'network_tcp')`,
    ),
  ],
);

/**
 * Local Cloud pairing state and credentials (`LOCAL`, D3, D4).
 * Stores encrypted device token, pairing status, and cloud connection metadata.
 * Strictly local - never synced.
 */
export const localCloudState = localSchemaRegistry.defineTable(
  {
    name: 'local_cloud_state',
    tableClass: 'LOCAL',
    tenantScope: 'none',
  },
  (common) => ({
    ...common,
    singletonGuard: sqliteInt('singleton_guard').notNull().default(1),
    status: text('status').notNull().default('unpaired'), // 'unpaired' | 'paired' | 'revoked'
    cloudUrl: text('cloud_url'),
    cloudOrganizationId: sqliteUuidV7('cloud_organization_id'),
    cloudOrganizationName: text('cloud_organization_name'),
    cloudStoreId: sqliteUuidV7('cloud_store_id'),
    cloudStoreName: text('cloud_store_name'),
    encryptedDeviceToken: text('encrypted_device_token'), // Base64 encrypted string (D4 safeStorage)
    pairedAtMs: sqliteUnixMs('paired_at_ms'),
    lastSyncAtMs: sqliteUnixMs('last_sync_at_ms'),
  }),
  (self) => [
    uniqueIndex('uidx_local_cloud_state_singleton').on(self.singletonGuard),
    check('chk_local_cloud_state_singleton', sql`${self.singletonGuard} = 1`),
    check('chk_local_cloud_state_status', sql`${self.status} IN ('unpaired', 'paired', 'revoked')`),
  ],
);
