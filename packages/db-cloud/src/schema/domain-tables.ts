import { sql } from 'drizzle-orm';
import { type AnyPgColumn, check, index, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { pgBigint, pgBoolean, pgInt, pgMoney, pgQuantity, pgUnixMs, pgUuidV7 } from '../columns.js';
import { cloudSchemaRegistry } from './registry-instance.js';

export const users = cloudSchemaRegistry.defineTable(
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
    isActive: pgBoolean('is_active').notNull(),
  }),
  (self) => [
    uniqueIndex('uidx_users_org_username')
      .on(self.organizationId, self.username)
      .where(sql`${self.deletedAtMs} IS NULL`),
    index('idx_users_org_active_role').on(self.organizationId, self.deletedAtMs, self.isActive),
    check('chk_users_role', sql`${self.role} IN ('owner', 'manager', 'cashier')`),
    check('chk_users_username_nonempty', sql`length(trim(${self.username})) >= 2`),
    check('chk_users_full_name_nonempty', sql`length(trim(${self.fullName})) >= 1`),
  ],
);

export const categories = cloudSchemaRegistry.defineTable(
  {
    name: 'categories',
    tableClass: 'ATTR',
    tenantScope: 'organization',
  },
  (common) => ({
    ...common,
    name: text('name').notNull(),
    nameSearch: text('name_search').notNull(),
    parentId: pgUuidV7('parent_id').references((): AnyPgColumn => categories.id),
    sortOrder: pgInt('sort_order').notNull().default(0),
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

export const products = cloudSchemaRegistry.defineTable(
  {
    name: 'products',
    tableClass: 'ATTR',
    tenantScope: 'organization',
  },
  (common) => ({
    ...common,
    categoryId: pgUuidV7('category_id').references(() => categories.id),
    sku: text('sku'),
    skuSearch: text('sku_search'),
    name: text('name').notNull(),
    nameSearch: text('name_search').notNull(),
    unit: text('unit').notNull(),
    unlimited: pgBoolean('unlimited').notNull().default(false),
    minStock: pgQuantity('min_stock'),
    hasVariants: pgBoolean('has_variants').notNull().default(false),
    trackBatches: pgBoolean('track_batches').notNull().default(false),
    salePrice: pgMoney('sale_price').notNull(),
    mxik: text('mxik'),
    packageCode: text('package_code'),
    vatRateBp: pgInt('vat_rate_bp').notNull().default(0),
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
    check('chk_products_min_stock_nonneg', sql`${self.minStock} IS NULL OR ${self.minStock} >= 0`),
    check(
      'chk_products_min_stock_unit_int',
      sql`${self.minStock} IS NULL OR ${self.unit} NOT IN ('dona', 'qadoq') OR (${self.minStock} % 1000) = 0`,
    ),
    check('chk_products_sale_price_nonneg', sql`${self.salePrice} >= 0`),
    check('chk_products_vat_rate_bp', sql`${self.vatRateBp} >= 0 AND ${self.vatRateBp} <= 10000`),
  ],
);

export const productVariants = cloudSchemaRegistry.defineTable(
  {
    name: 'product_variants',
    tableClass: 'ATTR',
    tenantScope: 'organization',
  },
  (common) => ({
    ...common,
    productId: pgUuidV7('product_id')
      .notNull()
      .references(() => products.id),
    name: text('name').notNull(),
    nameSearch: text('name_search').notNull(),
    sku: text('sku'),
    skuSearch: text('sku_search'),
    attributesJson: text('attributes_json').notNull(),
    salePrice: pgMoney('sale_price'),
  }),
  (self) => [
    index('idx_product_variants_org_product')
      .on(self.organizationId, self.productId)
      .where(sql`${self.deletedAtMs} IS NULL`),
    uniqueIndex('uidx_product_variants_org_sku')
      .on(self.organizationId, self.sku)
      .where(sql`${self.sku} IS NOT NULL AND ${self.deletedAtMs} IS NULL`),
    check('chk_product_variants_name_nonempty', sql`length(trim(${self.name})) >= 1`),
    check('chk_product_variants_attrs_json', sql`length(trim(${self.attributesJson})) >= 2`),
    check(
      'chk_product_variants_sale_price_nonneg',
      sql`${self.salePrice} IS NULL OR ${self.salePrice} >= 0`,
    ),
  ],
);

export const productBarcodes = cloudSchemaRegistry.defineTable(
  {
    name: 'product_barcodes',
    tableClass: 'ATTR',
    tenantScope: 'organization',
  },
  (common) => ({
    ...common,
    productId: pgUuidV7('product_id')
      .notNull()
      .references(() => products.id),
    variantId: pgUuidV7('variant_id').references(() => productVariants.id),
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

export const priceChanges = cloudSchemaRegistry.defineTable(
  {
    name: 'price_changes',
    tableClass: 'FACT',
    tenantScope: 'organization',
  },
  (common) => ({
    ...common,
    productId: pgUuidV7('product_id')
      .notNull()
      .references(() => products.id),
    variantId: pgUuidV7('variant_id').references(() => productVariants.id),
    oldPrice: pgMoney('old_price'),
    newPrice: pgMoney('new_price').notNull(),
    changedByUserId: pgUuidV7('changed_by_user_id')
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

export const batches = cloudSchemaRegistry.defineTable(
  {
    name: 'batches',
    tableClass: 'FACT',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    productId: pgUuidV7('product_id')
      .notNull()
      .references(() => products.id),
    variantId: pgUuidV7('variant_id').references(() => productVariants.id),
    batchNumber: text('batch_number'),
    expiryDateMs: pgUnixMs('expiry_date_ms'),
    initialQty: pgQuantity('initial_qty').notNull(),
    initialCostValue: pgMoney('initial_cost_value').notNull(),
    supplierId: pgUuidV7('supplier_id'),
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

export const stockMoves = cloudSchemaRegistry.defineTable(
  {
    name: 'stock_moves',
    tableClass: 'FACT',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    productId: pgUuidV7('product_id')
      .notNull()
      .references(() => products.id),
    variantId: pgUuidV7('variant_id').references(() => productVariants.id),
    batchId: pgUuidV7('batch_id').references(() => batches.id),
    qtyDelta: pgQuantity('qty_delta').notNull(),
    costValueDelta: pgMoney('cost_value_delta').notNull(),
    reason: text('reason').notNull(),
    sourceType: text('source_type').notNull(),
    sourceId: pgUuidV7('source_id').notNull(),
    createdByUserId: pgUuidV7('created_by_user_id')
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

export const inventoryCounts = cloudSchemaRegistry.defineTable(
  {
    name: 'inventory_counts',
    tableClass: 'MONOTONE',
    tenantScope: 'store',
    monotoneColumns: ['status', 'finalized_at_ms'],
  },
  (common) => ({
    ...common,
    status: text('status').notNull().default('open'),
    startedByUserId: pgUuidV7('started_by_user_id')
      .notNull()
      .references(() => users.id),
    finalizedByUserId: pgUuidV7('finalized_by_user_id').references(() => users.id),
    finalizedAtMs: pgUnixMs('finalized_at_ms'),
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

export const inventoryCountLines = cloudSchemaRegistry.defineTable(
  {
    name: 'inventory_count_lines',
    tableClass: 'MONOTONE',
    tenantScope: 'store',
    monotoneColumns: ['expected_qty_at_count', 'counted_qty', 'adjustment_qty'],
  },
  (common) => ({
    ...common,
    countId: pgUuidV7('count_id')
      .notNull()
      .references(() => inventoryCounts.id),
    productId: pgUuidV7('product_id')
      .notNull()
      .references(() => products.id),
    variantId: pgUuidV7('variant_id').references(() => productVariants.id),
    expectedQtyAtCount: pgQuantity('expected_qty_at_count'),
    countedQty: pgQuantity('counted_qty'),
    adjustmentQty: pgQuantity('adjustment_qty'),
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

export const promotions = cloudSchemaRegistry.defineTable(
  {
    name: 'promotions',
    tableClass: 'ATTR',
    tenantScope: 'organization',
  },
  (common) => ({
    ...common,
    targetStoreId: pgUuidV7('target_store_id'),
    name: text('name').notNull(),
    type: text('type').notNull(),
    scope: text('scope').notNull(),
    targetProductId: pgUuidV7('target_product_id').references(() => products.id),
    targetCategoryId: pgUuidV7('target_category_id').references(() => categories.id),
    discountPercentBp: pgInt('discount_percent_bp'),
    discountAmount: pgMoney('discount_amount'),
    buyQty: pgInt('buy_qty'),
    freeQty: pgInt('free_qty'),
    startsAtMs: pgUnixMs('starts_at_ms').notNull(),
    endsAtMs: pgUnixMs('ends_at_ms'),
    isActive: pgBoolean('is_active').notNull().default(true),
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

export const sales = cloudSchemaRegistry.defineTable(
  {
    name: 'sales',
    tableClass: 'MONOTONE',
    tenantScope: 'store',
    monotoneColumns: ['voided_at_ms'],
  },
  (common) => ({
    ...common,
    receiptNo: pgBigint('receipt_no').notNull(),
    receiptCode: text('receipt_code').notNull(),
    sourceCartId: pgUuidV7('source_cart_id'),
    sourceOrderId: pgUuidV7('source_order_id'),
    cashierUserId: pgUuidV7('cashier_user_id')
      .notNull()
      .references(() => users.id),
    completedByUserId: pgUuidV7('completed_by_user_id')
      .notNull()
      .references(() => users.id),
    customerId: pgUuidV7('customer_id'),
    shiftId: pgUuidV7('shift_id'),
    shiftCashierSessionId: pgUuidV7('shift_cashier_session_id'),
    clientRequestId: pgUuidV7('client_request_id').notNull(),
    requestHash: text('request_hash').notNull(),
    subtotalGross: pgMoney('subtotal_gross').notNull(),
    totalPromoDiscount: pgMoney('total_promo_discount').notNull(),
    subtotalAfterPromo: pgMoney('subtotal_after_promo').notNull(),
    manualDiscountMode: text('manual_discount_mode').notNull(),
    manualDiscountValue: pgBigint('manual_discount_value').notNull(),
    manualDiscountReason: text('manual_discount_reason'),
    orderDiscountAmount: pgMoney('order_discount_amount').notNull(),
    totalFinal: pgMoney('total_final').notNull(),
    totalNetExVat: pgMoney('total_net_ex_vat').notNull(),
    totalVat: pgMoney('total_vat').notNull(),
    totalPaid: pgMoney('total_paid').notNull(),
    debtAmount: pgMoney('debt_amount')
      .notNull()
      .default(sql`0`),
    changeAmount: pgMoney('change_amount').notNull(),
    overrideApprovedByUserId: pgUuidV7('override_approved_by_user_id').references(() => users.id),
    overrideApprovedAmount: pgMoney('override_approved_amount'),
    overrideApprovedAtMs: pgUnixMs('override_approved_at_ms'),
    voidedAtMs: pgUnixMs('voided_at_ms'),
    voidedByUserId: pgUuidV7('voided_by_user_id').references(() => users.id),
    voidReason: text('void_reason'),
    voidClientRequestId: pgUuidV7('void_client_request_id'),
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

export const saleLines = cloudSchemaRegistry.defineTable(
  {
    name: 'sale_lines',
    tableClass: 'FACT',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    saleId: pgUuidV7('sale_id')
      .notNull()
      .references(() => sales.id),
    sortOrder: pgInt('sort_order').notNull(),
    lineKind: text('line_kind').notNull(),
    productId: pgUuidV7('product_id').references(() => products.id),
    variantId: pgUuidV7('variant_id').references(() => productVariants.id),
    categoryIdSnapshot: pgUuidV7('category_id_snapshot'),
    itemName: text('item_name').notNull(),
    unit: text('unit').notNull(),
    qty: pgQuantity('qty').notNull(),
    unitPriceSnapshot: pgMoney('unit_price_snapshot').notNull(),
    appliedPromotionId: pgUuidV7('applied_promotion_id'),
    appliedPromotionName: text('applied_promotion_name'),
    freeUnits: pgBigint('free_units')
      .notNull()
      .default(sql`0`),
    grossTotal: pgMoney('gross_total').notNull(),
    promoDiscount: pgMoney('promo_discount').notNull(),
    subtotalAfterPromo: pgMoney('subtotal_after_promo').notNull(),
    allocatedOrderDiscount: pgMoney('allocated_order_discount').notNull(),
    finalTotal: pgMoney('final_total').notNull(),
    vatRateBpSnapshot: pgInt('vat_rate_bp_snapshot').notNull(),
    netExVat: pgMoney('net_ex_vat').notNull(),
    vatTotal: pgMoney('vat_total').notNull(),
    mxikSnapshot: text('mxik_snapshot'),
    packageCodeSnapshot: text('package_code_snapshot'),
    costValue: pgMoney('cost_value')
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

export const payments = cloudSchemaRegistry.defineTable(
  {
    name: 'payments',
    tableClass: 'FACT',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    saleId: pgUuidV7('sale_id')
      .notNull()
      .references(() => sales.id),
    method: text('method').notNull(),
    amount: pgMoney('amount').notNull(),
    tenderedAmount: pgMoney('tendered_amount'),
    changeAmount: pgMoney('change_amount')
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

export const cashMoves = cloudSchemaRegistry.defineTable(
  {
    name: 'cash_moves',
    tableClass: 'FACT',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    shiftId: pgUuidV7('shift_id'),
    shiftCashierSessionId: pgUuidV7('shift_cashier_session_id'),
    type: text('type').notNull(),
    amountDelta: pgMoney('amount_delta').notNull(),
    sourceType: text('source_type').notNull(),
    sourceId: pgUuidV7('source_id').notNull(),
    paymentId: pgUuidV7('payment_id').references(() => payments.id),
    expenseCategory: text('expense_category'),
    reason: text('reason'),
    createdByUserId: pgUuidV7('created_by_user_id')
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

export const returns = cloudSchemaRegistry.defineTable(
  {
    name: 'returns',
    tableClass: 'FACT',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    saleId: pgUuidV7('sale_id')
      .notNull()
      .references(() => sales.id),
    shiftId: pgUuidV7('shift_id'),
    shiftCashierSessionId: pgUuidV7('shift_cashier_session_id'),
    returnNo: pgBigint('return_no').notNull(),
    returnCode: text('return_code').notNull(),
    processedByUserId: pgUuidV7('processed_by_user_id')
      .notNull()
      .references(() => users.id),
    overrideApprovedByUserId: pgUuidV7('override_approved_by_user_id').references(() => users.id),
    overrideApprovedAtMs: pgUnixMs('override_approved_at_ms'),
    reason: text('reason').notNull(),
    clientRequestId: pgUuidV7('client_request_id').notNull(),
    requestHash: text('request_hash').notNull(),
    totalRefund: pgMoney('total_refund').notNull(),
    totalNetExVat: pgMoney('total_net_ex_vat').notNull(),
    totalVat: pgMoney('total_vat').notNull(),
    cashRefundAmount: pgMoney('cash_refund_amount').notNull(),
    nonCashRefundAmount: pgMoney('non_cash_refund_amount').notNull(),
    debtOffsetAmount: pgMoney('debt_offset_amount')
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

export const returnLines = cloudSchemaRegistry.defineTable(
  {
    name: 'return_lines',
    tableClass: 'FACT',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    returnId: pgUuidV7('return_id')
      .notNull()
      .references(() => returns.id),
    saleId: pgUuidV7('sale_id')
      .notNull()
      .references(() => sales.id),
    saleLineId: pgUuidV7('sale_line_id')
      .notNull()
      .references(() => saleLines.id),
    sortOrder: pgInt('sort_order').notNull(),
    lineKind: text('line_kind').notNull(),
    productId: pgUuidV7('product_id').references(() => products.id),
    variantId: pgUuidV7('variant_id').references(() => productVariants.id),
    itemName: text('item_name').notNull(),
    unit: text('unit').notNull(),
    qty: pgQuantity('qty').notNull(),
    unitPriceSnapshot: pgMoney('unit_price_snapshot').notNull(),
    vatRateBpSnapshot: pgInt('vat_rate_bp_snapshot').notNull(),
    mxikSnapshot: text('mxik_snapshot'),
    packageCodeSnapshot: text('package_code_snapshot'),
    refundAmount: pgMoney('refund_amount').notNull(),
    netExVat: pgMoney('net_ex_vat').notNull(),
    vatTotal: pgMoney('vat_total').notNull(),
    costValue: pgMoney('cost_value')
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

export const returnPayments = cloudSchemaRegistry.defineTable(
  {
    name: 'return_payments',
    tableClass: 'FACT',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    returnId: pgUuidV7('return_id')
      .notNull()
      .references(() => returns.id),
    saleId: pgUuidV7('sale_id')
      .notNull()
      .references(() => sales.id),
    method: text('method').notNull(),
    amount: pgMoney('amount').notNull(),
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

export const customers = cloudSchemaRegistry.defineTable(
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
    creditLimit: pgMoney('credit_limit'),
    defaultDueDays: pgInt('default_due_days'),
    note: text('note'),
    isActive: pgBoolean('is_active').notNull().default(true),
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
      sql`${self.phoneNormalized} IS NULL OR (${self.phoneNormalized} ~ '^\\+[1-9]' AND length(${self.phoneNormalized}) BETWEEN 9 AND 16)`,
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
  ],
);

export const customerLedger = cloudSchemaRegistry.defineTable(
  {
    name: 'customer_ledger',
    tableClass: 'FACT',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    customerId: pgUuidV7('customer_id')
      .notNull()
      .references(() => customers.id),
    entryType: text('entry_type').notNull(),
    amountDelta: pgMoney('amount_delta').notNull(),
    sourceType: text('source_type').notNull(),
    sourceId: pgUuidV7('source_id').notNull(),
    saleId: pgUuidV7('sale_id').references(() => sales.id),
    paymentMethod: text('payment_method'),
    providerRef: text('provider_ref'),
    cashMoveId: pgUuidV7('cash_move_id').references(() => cashMoves.id),
    dueAtMs: pgUnixMs('due_at_ms'),
    reason: text('reason'),
    createdByUserId: pgUuidV7('created_by_user_id')
      .notNull()
      .references(() => users.id),
    overrideApprovedByUserId: pgUuidV7('override_approved_by_user_id').references(() => users.id),
    clientRequestId: pgUuidV7('client_request_id'),
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

export const suppliers = cloudSchemaRegistry.defineTable(
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
    defaultDueDays: pgInt('default_due_days'),
    isActive: pgBoolean('is_active').notNull().default(true),
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
    check(
      'chk_suppliers_due_days',
      sql`${self.defaultDueDays} IS NULL OR (${self.defaultDueDays} >= 1 AND ${self.defaultDueDays} <= 3650)`,
    ),
  ],
);

export const goodsReceivings = cloudSchemaRegistry.defineTable(
  {
    name: 'goods_receivings',
    tableClass: 'FACT',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    receivingNo: pgBigint('receiving_no').notNull(),
    receivingCode: text('receiving_code').notNull(),
    supplierId: pgUuidV7('supplier_id')
      .notNull()
      .references(() => suppliers.id),
    supplierInvoiceNo: text('supplier_invoice_no'),
    dueDays: pgInt('due_days'),
    dueAtMs: pgUnixMs('due_at_ms'),
    knownCostTotal: pgMoney('known_cost_total').notNull(),
    unknownCostLineCount: pgInt('unknown_cost_line_count').notNull(),
    note: text('note'),
    postedByUserId: pgUuidV7('posted_by_user_id')
      .notNull()
      .references(() => users.id),
    clientRequestId: pgUuidV7('client_request_id').notNull(),
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

export const goodsReceivingLines = cloudSchemaRegistry.defineTable(
  {
    name: 'goods_receiving_lines',
    tableClass: 'FACT',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    receivingId: pgUuidV7('receiving_id')
      .notNull()
      .references(() => goodsReceivings.id),
    sortOrder: pgInt('sort_order').notNull(),
    productId: pgUuidV7('product_id')
      .notNull()
      .references(() => products.id),
    variantId: pgUuidV7('variant_id').references(() => productVariants.id),
    qty: pgQuantity('qty').notNull(),
    costUnknown: pgBoolean('cost_unknown').notNull(),
    initialTotalCost: pgMoney('initial_total_cost').notNull(),
    vatRateBp: pgInt('vat_rate_bp'),
    vatAmount: pgMoney('vat_amount'),
    stockMoveId: pgUuidV7('stock_move_id')
      .notNull()
      .references(() => stockMoves.id),
    batchId: pgUuidV7('batch_id').references(() => batches.id),
    batchNumber: text('batch_number'),
    expiryDateMs: pgUnixMs('expiry_date_ms'),
  }),
  (self) => [
    uniqueIndex('uidx_goods_receiving_lines_sort').on(self.receivingId, self.sortOrder),
    uniqueIndex('uidx_goods_receiving_lines_move').on(self.stockMoveId),
    index('idx_goods_receiving_lines_rcv').on(self.receivingId),
    check('chk_goods_receiving_lines_sort_nonneg', sql`${self.sortOrder} >= 0`),
    check('chk_goods_receiving_lines_qty_pos', sql`${self.qty} > 0`),
    check(
      'chk_goods_receiving_lines_cost_pair',
      sql`(${self.costUnknown} = true AND ${self.initialTotalCost} = 0) OR (${self.costUnknown} = false AND ${self.initialTotalCost} >= 0)`,
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

export const receivingCostConfirmations = cloudSchemaRegistry.defineTable(
  {
    name: 'receiving_cost_confirmations',
    tableClass: 'FACT',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    receivingId: pgUuidV7('receiving_id')
      .notNull()
      .references(() => goodsReceivings.id),
    receivingLineId: pgUuidV7('receiving_line_id')
      .notNull()
      .references(() => goodsReceivingLines.id),
    supplierId: pgUuidV7('supplier_id')
      .notNull()
      .references(() => suppliers.id),
    productId: pgUuidV7('product_id')
      .notNull()
      .references(() => products.id),
    variantId: pgUuidV7('variant_id').references(() => productVariants.id),
    batchId: pgUuidV7('batch_id').references(() => batches.id),
    receivedQty: pgQuantity('received_qty').notNull(),
    confirmedTotalCost: pgMoney('confirmed_total_cost').notNull(),
    dueDays: pgInt('due_days'),
    dueAtMs: pgUnixMs('due_at_ms'),
    reason: text('reason').notNull(),
    confirmedByUserId: pgUuidV7('confirmed_by_user_id')
      .notNull()
      .references(() => users.id),
    clientRequestId: pgUuidV7('client_request_id').notNull(),
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

export const supplierReturns = cloudSchemaRegistry.defineTable(
  {
    name: 'supplier_returns',
    tableClass: 'FACT',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    returnNo: pgBigint('return_no').notNull(),
    returnCode: text('return_code').notNull(),
    receivingId: pgUuidV7('receiving_id')
      .notNull()
      .references(() => goodsReceivings.id),
    supplierId: pgUuidV7('supplier_id')
      .notNull()
      .references(() => suppliers.id),
    reason: text('reason').notNull(),
    totalReturnCost: pgMoney('total_return_cost').notNull(),
    createdByUserId: pgUuidV7('created_by_user_id')
      .notNull()
      .references(() => users.id),
    clientRequestId: pgUuidV7('client_request_id').notNull(),
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

export const supplierReturnLines = cloudSchemaRegistry.defineTable(
  {
    name: 'supplier_return_lines',
    tableClass: 'FACT',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    supplierReturnId: pgUuidV7('supplier_return_id')
      .notNull()
      .references(() => supplierReturns.id),
    receivingLineId: pgUuidV7('receiving_line_id')
      .notNull()
      .references(() => goodsReceivingLines.id),
    sortOrder: pgInt('sort_order').notNull(),
    productId: pgUuidV7('product_id')
      .notNull()
      .references(() => products.id),
    variantId: pgUuidV7('variant_id').references(() => productVariants.id),
    batchId: pgUuidV7('batch_id').references(() => batches.id),
    stockMoveId: pgUuidV7('stock_move_id')
      .notNull()
      .references(() => stockMoves.id),
    qty: pgQuantity('qty').notNull(),
    returnCostValue: pgMoney('return_cost_value').notNull(),
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

export const supplierLedger = cloudSchemaRegistry.defineTable(
  {
    name: 'supplier_ledger',
    tableClass: 'FACT',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    supplierId: pgUuidV7('supplier_id')
      .notNull()
      .references(() => suppliers.id),
    entryType: text('entry_type').notNull(),
    amountDelta: pgMoney('amount_delta').notNull(),
    sourceType: text('source_type').notNull(),
    sourceId: pgUuidV7('source_id').notNull(),
    receivingId: pgUuidV7('receiving_id').references(() => goodsReceivings.id),
    supplierReturnId: pgUuidV7('supplier_return_id').references(() => supplierReturns.id),
    paymentMethod: text('payment_method'),
    providerRef: text('provider_ref'),
    cashMoveId: pgUuidV7('cash_move_id').references(() => cashMoves.id),
    dueAtMs: pgUnixMs('due_at_ms'),
    reason: text('reason'),
    createdByUserId: pgUuidV7('created_by_user_id')
      .notNull()
      .references(() => users.id),
    clientRequestId: pgUuidV7('client_request_id'),
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

export const shifts = cloudSchemaRegistry.defineTable(
  {
    name: 'shifts',
    tableClass: 'MONOTONE',
    tenantScope: 'store',
    monotoneColumns: ['closed_at_ms'],
  },
  (common) => ({
    ...common,
    shiftNo: pgBigint('shift_no').notNull(),
    shiftCode: text('shift_code').notNull(),
    status: text('status').notNull(),
    openedByUserId: pgUuidV7('opened_by_user_id')
      .notNull()
      .references(() => users.id),
    closedByUserId: pgUuidV7('closed_by_user_id').references(() => users.id),
    openingCash: pgMoney('opening_cash').notNull(),
    previousCloseCash: pgMoney('previous_close_cash'),
    openingDiscrepancy: pgMoney('opening_discrepancy')
      .notNull()
      .default(sql`0`),
    openingDiscrepancyReason: text('opening_discrepancy_reason'),
    openingNote: text('opening_note'),
    closingNote: text('closing_note'),
    openedAtMs: pgUnixMs('opened_at_ms').notNull(),
    closedAtMs: pgUnixMs('closed_at_ms'),
    openClientRequestId: pgUuidV7('open_client_request_id').notNull(),
    openRequestHash: text('open_request_hash').notNull(),
    closeClientRequestId: pgUuidV7('close_client_request_id'),
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

export const shiftCashierSessions = cloudSchemaRegistry.defineTable(
  {
    name: 'shift_cashier_sessions',
    tableClass: 'MONOTONE',
    tenantScope: 'store',
    monotoneColumns: ['ended_at_ms'],
  },
  (common) => ({
    ...common,
    shiftId: pgUuidV7('shift_id')
      .notNull()
      .references(() => shifts.id),
    sessionSeq: pgInt('session_seq').notNull(),
    cashierUserId: pgUuidV7('cashier_user_id')
      .notNull()
      .references(() => users.id),
    status: text('status').notNull(),
    openingFloat: pgMoney('opening_float').notNull(),
    expectedCash: pgMoney('expected_cash'),
    countedCash: pgMoney('counted_cash'),
    discrepancy: pgMoney('discrepancy'),
    discrepancyReason: text('discrepancy_reason'),
    denominationsJson: text('denominations_json'),
    overrideApprovedByUserId: pgUuidV7('override_approved_by_user_id').references(() => users.id),
    handedOffByUserId: pgUuidV7('handed_off_by_user_id').references(() => users.id),
    note: text('note'),
    startedAtMs: pgUnixMs('started_at_ms').notNull(),
    endedAtMs: pgUnixMs('ended_at_ms'),
    handoffClientRequestId: pgUuidV7('handoff_client_request_id'),
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

export const shiftClosures = cloudSchemaRegistry.defineTable(
  {
    name: 'shift_closures',
    tableClass: 'FACT',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    shiftId: pgUuidV7('shift_id')
      .notNull()
      .references(() => shifts.id),
    closureSeq: pgInt('closure_seq').notNull(),
    isReclose: pgBoolean('is_reclose').notNull().default(false),
    reason: text('reason'),
    closedByUserId: pgUuidV7('closed_by_user_id')
      .notNull()
      .references(() => users.id),
    overrideApprovedByUserId: pgUuidV7('override_approved_by_user_id').references(() => users.id),
    clientRequestId: pgUuidV7('client_request_id').notNull(),
    requestHash: text('request_hash').notNull(),
    expectedCash: pgMoney('expected_cash').notNull(),
    countedCash: pgMoney('counted_cash').notNull(),
    discrepancy: pgMoney('discrepancy').notNull(),
    denominationsJson: text('denominations_json'),
    salesCount: pgInt('sales_count').notNull(),
    returnsCount: pgInt('returns_count').notNull(),
    voidsCount: pgInt('voids_count').notNull(),
    grossSalesTotal: pgMoney('gross_sales_total').notNull(),
    returnsTotal: pgMoney('returns_total').notNull(),
    netSalesTotal: pgMoney('net_sales_total').notNull(),
    orderAdvanceCashTotal: pgMoney('order_advance_cash_total')
      .notNull()
      .default(sql`0`),
    orderAdvanceNonCashTotal: pgMoney('order_advance_non_cash_total')
      .notNull()
      .default(sql`0`),
    orderAdvanceRefundTotal: pgMoney('order_advance_refund_total')
      .notNull()
      .default(sql`0`),
  }),
  (self) => [
    uniqueIndex('uidx_shift_closures_shift_seq').on(self.shiftId, self.closureSeq),
    uniqueIndex('uidx_shift_closures_org_req').on(self.organizationId, self.clientRequestId),
    index('idx_shift_closures_shift_seq').on(self.shiftId, self.closureSeq),
    check('chk_shift_closures_seq_pos', sql`${self.closureSeq} >= 1`),
    check(
      'chk_shift_closures_reclose_reason',
      sql`${self.isReclose} = false OR (${self.reason} IS NOT NULL AND length(trim(${self.reason})) >= 1)`,
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

export const shiftClosureMethodTotals = cloudSchemaRegistry.defineTable(
  {
    name: 'shift_closure_method_totals',
    tableClass: 'FACT',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    shiftClosureId: pgUuidV7('shift_closure_id')
      .notNull()
      .references(() => shiftClosures.id),
    method: text('method').notNull(),
    salesAmount: pgMoney('sales_amount').notNull(),
    returnsAmount: pgMoney('returns_amount').notNull(),
    netAmount: pgMoney('net_amount').notNull(),
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

export const shiftClosureCashiers = cloudSchemaRegistry.defineTable(
  {
    name: 'shift_closure_cashiers',
    tableClass: 'FACT',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    shiftClosureId: pgUuidV7('shift_closure_id')
      .notNull()
      .references(() => shiftClosures.id),
    sessionId: pgUuidV7('session_id')
      .notNull()
      .references(() => shiftCashierSessions.id),
    cashierUserId: pgUuidV7('cashier_user_id')
      .notNull()
      .references(() => users.id),
    sessionSeq: pgInt('session_seq').notNull(),
    openingFloat: pgMoney('opening_float').notNull(),
    expectedCash: pgMoney('expected_cash').notNull(),
    countedCash: pgMoney('counted_cash').notNull(),
    discrepancy: pgMoney('discrepancy').notNull(),
    salesCount: pgInt('sales_count').notNull(),
    returnsCount: pgInt('returns_count').notNull(),
    salesTotal: pgMoney('sales_total').notNull(),
    returnsTotal: pgMoney('returns_total').notNull(),
    cashInTotal: pgMoney('cash_in_total').notNull(),
    cashOutTotal: pgMoney('cash_out_total').notNull(),
  }),
  (self) => [
    uniqueIndex('uidx_shift_closure_cashiers_sess').on(self.shiftClosureId, self.sessionId),
    check(
      'chk_shift_closure_cashiers_nonneg',
      sql`${self.sessionSeq} >= 1 AND ${self.openingFloat} >= 0 AND ${self.countedCash} >= 0 AND ${self.salesCount} >= 0 AND ${self.returnsCount} >= 0 AND ${self.salesTotal} >= 0 AND ${self.returnsTotal} >= 0 AND ${self.cashInTotal} >= 0 AND ${self.cashOutTotal} >= 0`,
    ),
  ],
);

export const dayCloses = cloudSchemaRegistry.defineTable(
  {
    name: 'day_closes',
    tableClass: 'FACT',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    businessDate: text('business_date').notNull(),
    closeSeq: pgInt('close_seq').notNull(),
    closeCode: text('close_code').notNull(),
    closedByUserId: pgUuidV7('closed_by_user_id')
      .notNull()
      .references(() => users.id),
    clientRequestId: pgUuidV7('client_request_id').notNull(),
    requestHash: text('request_hash').notNull(),
    note: text('note'),
    shiftsCount: pgInt('shifts_count').notNull(),
    salesCount: pgInt('sales_count').notNull(),
    returnsCount: pgInt('returns_count').notNull(),
    voidsCount: pgInt('voids_count').notNull(),
    grossSalesTotal: pgMoney('gross_sales_total').notNull(),
    returnsTotal: pgMoney('returns_total').notNull(),
    netSalesTotal: pgMoney('net_sales_total').notNull(),
    expectedCashTotal: pgMoney('expected_cash_total').notNull(),
    countedCashTotal: pgMoney('counted_cash_total').notNull(),
    discrepancyTotal: pgMoney('discrepancy_total').notNull(),
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

export const orders = cloudSchemaRegistry.defineTable(
  {
    name: 'orders',
    tableClass: 'MONOTONE',
    tenantScope: 'store',
    monotoneColumns: ['status', 'delivered_at_ms', 'cancelled_at_ms'],
  },
  (common) => ({
    ...common,
    originDeviceId: pgUuidV7('origin_device_id').notNull(),
    orderNo: pgBigint('order_no').notNull(),
    orderCode: text('order_code').notNull(),
    status: text('status').notNull(),
    customerId: pgUuidV7('customer_id').references(() => customers.id),
    customerName: text('customer_name').notNull(),
    customerPhoneNormalized: text('customer_phone_normalized'),
    dueAtMs: pgUnixMs('due_at_ms'),
    note: text('note'),
    subtotalGross: pgMoney('subtotal_gross').notNull(),
    totalPromoDiscount: pgMoney('total_promo_discount').notNull(),
    subtotalAfterPromo: pgMoney('subtotal_after_promo').notNull(),
    manualDiscountMode: text('manual_discount_mode').notNull(),
    manualDiscountValue: pgBigint('manual_discount_value').notNull(),
    manualDiscountReason: text('manual_discount_reason'),
    orderDiscountAmount: pgMoney('order_discount_amount').notNull(),
    totalAmount: pgMoney('total_amount').notNull(),
    totalNetExVat: pgMoney('total_net_ex_vat').notNull(),
    totalVat: pgMoney('total_vat').notNull(),
    overrideApprovedByUserId: pgUuidV7('override_approved_by_user_id').references(() => users.id),
    overrideApprovedAmount: pgMoney('override_approved_amount'),
    createdByUserId: pgUuidV7('created_by_user_id')
      .notNull()
      .references(() => users.id),
    confirmedAtMs: pgUnixMs('confirmed_at_ms'),
    readyAtMs: pgUnixMs('ready_at_ms'),
    deliveredAtMs: pgUnixMs('delivered_at_ms'),
    deliveredSaleId: pgUuidV7('delivered_sale_id').references(() => sales.id),
    cancelledAtMs: pgUnixMs('cancelled_at_ms'),
    cancelledByUserId: pgUuidV7('cancelled_by_user_id').references(() => users.id),
    cancelReason: text('cancel_reason'),
    createClientRequestId: pgUuidV7('create_client_request_id').notNull(),
    createRequestHash: text('create_request_hash').notNull(),
    confirmClientRequestId: pgUuidV7('confirm_client_request_id'),
    confirmRequestHash: text('confirm_request_hash'),
    readyClientRequestId: pgUuidV7('ready_client_request_id'),
    readyRequestHash: text('ready_request_hash'),
    deliverClientRequestId: pgUuidV7('deliver_client_request_id'),
    deliverRequestHash: text('deliver_request_hash'),
    cancelClientRequestId: pgUuidV7('cancel_client_request_id'),
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

export const orderLines = cloudSchemaRegistry.defineTable(
  {
    name: 'order_lines',
    tableClass: 'FACT',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    orderId: pgUuidV7('order_id')
      .notNull()
      .references(() => orders.id),
    sortOrder: pgInt('sort_order').notNull(),
    lineKind: text('line_kind').notNull(),
    productId: pgUuidV7('product_id').references(() => products.id),
    variantId: pgUuidV7('variant_id').references(() => productVariants.id),
    categoryIdSnapshot: pgUuidV7('category_id_snapshot'),
    itemName: text('item_name').notNull(),
    unit: text('unit').notNull(),
    qty: pgQuantity('qty').notNull(),
    unitPriceSnapshot: pgMoney('unit_price_snapshot').notNull(),
    appliedPromotionId: pgUuidV7('applied_promotion_id'),
    appliedPromotionName: text('applied_promotion_name'),
    freeUnits: pgBigint('free_units')
      .notNull()
      .default(sql`0`),
    grossTotal: pgMoney('gross_total').notNull(),
    promoDiscount: pgMoney('promo_discount').notNull(),
    subtotalAfterPromo: pgMoney('subtotal_after_promo').notNull(),
    allocatedOrderDiscount: pgMoney('allocated_order_discount').notNull(),
    finalTotal: pgMoney('final_total').notNull(),
    vatRateBpSnapshot: pgInt('vat_rate_bp_snapshot').notNull(),
    netExVat: pgMoney('net_ex_vat').notNull(),
    vatTotal: pgMoney('vat_total').notNull(),
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

export const orderPayments = cloudSchemaRegistry.defineTable(
  {
    name: 'order_payments',
    tableClass: 'FACT',
    tenantScope: 'store',
  },
  (common) => ({
    ...common,
    orderId: pgUuidV7('order_id')
      .notNull()
      .references(() => orders.id),
    shiftId: pgUuidV7('shift_id')
      .notNull()
      .references(() => shifts.id),
    shiftCashierSessionId: pgUuidV7('shift_cashier_session_id')
      .notNull()
      .references(() => shiftCashierSessions.id),
    kind: text('kind').notNull(),
    method: text('method').notNull(),
    amount: pgMoney('amount').notNull(),
    tenderedAmount: pgMoney('tendered_amount'),
    changeAmount: pgMoney('change_amount')
      .notNull()
      .default(sql`0`),
    providerRef: text('provider_ref'),
    reason: text('reason'),
    createdByUserId: pgUuidV7('created_by_user_id')
      .notNull()
      .references(() => users.id),
    overrideApprovedByUserId: pgUuidV7('override_approved_by_user_id').references(() => users.id),
    seq: pgInt('seq').notNull().default(0),
    clientRequestId: pgUuidV7('client_request_id').notNull(),
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
