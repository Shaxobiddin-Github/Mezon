export const DB_LOCAL_PACKAGE = '@mezon/db-local';

export {
  type SqliteColumnKind,
  getSqliteCustomColumnKind,
  sqliteBigint,
  sqliteMoney,
  sqliteQuantity,
  sqliteUnixMs,
  sqliteInt,
  sqliteUuidV7,
  sqliteHlc,
  sqliteBoolean,
} from './columns.js';

export {
  type TableClass,
  type TenantScope,
  type TableDefinitionOptions,
  type SqliteTableMetadata,
  type SqliteCommonColumns,
  SchemaValidationError,
  SqliteSchemaRegistry,
  validateSqliteSchemaRegistry,
} from './registry.js';

export {
  DEFAULT_SQLITE_BUSY_TIMEOUT_MS,
  type LocalSqliteOptions,
  type LocalSqlitePragmas,
  type LocalSqliteConnection,
  openLocalSqliteDatabase,
} from './connection.js';

export { getDefaultLocalMigrationsFolder, migrateLocalDatabase } from './migrate.js';

export {
  buildSqliteImmutabilityTriggersSql,
  buildAllSqliteTriggersSql,
  applySqliteImmutabilityTriggers,
  assertSqliteTriggersMigrationsComplete,
} from './triggers.js';

export {
  type SqliteSessionDbAccess,
  readDeviceStateRowSync,
  advanceReceiptSeqSync,
  readReceiptSeqSync,
  advanceReturnSeqSync,
  readReturnSeqSync,
  SqliteDeviceStateRepository,
} from './device-state.js';

export {
  serializeOutboxJsonValue,
  serializeOutboxPayload,
  redactOutboxPayloadForDebug,
  formatOutboxRecordForDebug,
  listAllOutboxRecordsSync,
  SqliteOutboxRepository,
} from './outbox.js';

export {
  type CreateSqliteUnitOfWorkOptions,
  SqliteUnitOfWorkSession,
  SqliteUnitOfWork,
  createSqliteUnitOfWork,
  bootstrapSqliteHubUnitOfWork,
  runConnectionReadOnly,
  runConnectionProjectionMaintenance,
  getSessionSqlite,
} from './uow.js';

export {
  type BusinessInsertValues,
  type BusinessUpdateValues,
  type InsertEntityOptions,
  type UpdateAttrOptions,
  type TombstoneAttrOptions,
  type SyncedWriteResult,
  insertFact,
  insertAttr,
  updateAttr,
  tombstoneAttr,
  insertMonotone,
  updateMonotone,
} from './writers.js';

export {
  localSchemaRegistry,
  localDeviceState,
  localOutbox,
  users,
  localHubConfig,
  localPinCredentials,
  localDeviceAuthState,
  localSessions,
  categories,
  products,
  productVariants,
  productBarcodes,
  priceChanges,
  batches,
  stockMoves,
  inventoryCounts,
  inventoryCountLines,
  localStockBalances,
  localBatchBalances,
  localStockConflicts,
  promotions,
  localCarts,
  localCartLines,
  sales,
  saleLines,
  payments,
  cashMoves,
  returns,
  returnLines,
  returnPayments,
  customers,
  customerLedger,
  localCustomerBalances,
} from './schema/index.js';

export {
  type EntityFtsSearchConfig,
  buildEntityFtsSearchSql,
  assertEntityFtsMigrationsComplete,
  buildCatalogSearchFtsSql,
  assertCatalogSearchMigrationsComplete,
} from './catalog-search-schema.js';

export {
  buildCustomerSearchFtsSql,
  assertCustomerMigrationsComplete,
} from './customer-migrations.js';

export {
  buildStockMonotoneTriggersSql,
  assertStockMigrationsComplete,
} from './stock-migrations.js';

export {
  buildSaleMonotoneTriggersSql,
  assertSaleMigrationsComplete,
  buildSalesLinesViewSql,
  assertReturnAndViewMigrationsComplete,
} from './sale-migrations.js';

export {
  type HubConfigSnapshot,
  type StoredUserRecord,
  type LoginOptionRecord,
  type LoginSelector,
  type LoginCredentialSnapshot,
  type CommitLoginOutcomeResult,
  type CommitPinCheckOutcomeResult,
  type AuthenticatedSessionSnapshot,
  type CreateSqliteHubAuthStoreOptions,
  SqliteHubAuthStore,
  createSqliteHubAuthStore,
} from './auth-repo.js';

export {
  type CatalogRuntimeContext,
  type CreateSqliteCatalogStoreOptions,
  type StoredCategoryRecord,
  type StoredProductRecord,
  type StoredProductVariantRecord,
  type StoredProductBarcodeRecord,
  type StoredPriceChangeRecord,
  type StoredProductDetailRecord,
  type StoredBarcodeScanResult,
  type ListProductsFilter,
  type ListProductsPageResult,
  type RebuildCatalogSearchResult,
  rebuildCatalogSearchIndex,
  SqliteCatalogStore,
  createSqliteCatalogStore,
} from './catalog-repo.js';

export {
  type StockRuntimeContext,
  type CreateSqliteStockStoreOptions,
  type StoredCashierBalanceRecord,
  type StoredStockValuationRecord,
  type StoredBatchRecord,
  type StoredStockMoveRecord,
  type StockMoveWarningRecord,
  type CreateStockMovesOutcome,
  type OutboundStockMoveSessionParams,
  type OutboundStockMoveSessionOutcome,
  type StoredStockConflictRecord,
  type StoredInventoryCountRecord,
  type StoredInventoryCountLineRecord,
  type StoredInventoryCountDetailRecord,
  type FinalizeInventoryCountOutcome,
  type RebuildStockProjectionsResult,
  type StockPoolPrefetchTarget,
  stockPoolKey,
  prefetchMutablePoolStatesSync,
  applyOutboundStockMoveSync,
  rebuildStockProjections,
  SqliteStockStore,
  createSqliteStockStore,
} from './stock-repo.js';

export {
  type CartRuntimeContext,
  type CreateSqliteCartStoreOptions,
  type StoredPromotionRecord,
  type StoredCartDiscountSettings,
  type StoredPriceChangeWarning,
  type StoredCartLineRecord,
  type StoredCartSummaryRecord,
  type StoredCartDetailRecord,
  type AddCartLineInput,
  type SetCartDiscountInput,
  SqliteCartStore,
  createSqliteCartStore,
} from './cart-repo.js';

export {
  type SaleRuntimeContext,
  type SaleStoreTestHooks,
  type CreateSqliteSaleStoreOptions,
  type CompleteSaleInput,
  type StoredSaleLineRecord,
  type StoredSalePaymentRecord,
  type StoredCashMoveRecord,
  type StoredSaleRecord,
  type CompleteSaleOutcome,
  getCashDrawerBalanceSync,
  getStoreCashBalanceSync,
  SqliteSaleStore,
  createSqliteSaleStore,
} from './sale-repo.js';

export {
  type ReturnRuntimeContext,
  type ReturnStoreTestHooks,
  type CreateSqliteReturnStoreOptions,
  type VoidSaleInput,
  type StoredVoidedSaleRecord,
  type VoidSaleOutcome,
  type CreateReturnLineInput,
  type CreateReturnInput,
  type StoredReturnLineRecord,
  type StoredReturnPaymentRecord,
  type StoredReturnRecord,
  type CreateReturnOutcome,
  type SalesLinesReportSummaryRecord,
  SqliteReturnStore,
  createSqliteReturnStore,
} from './return-repo.js';

export {
  type CustomerRuntimeContext,
  type CreateSqliteCustomerStoreOptions,
  type CreateCustomerInput,
  type UpdateCustomerInput,
  type CustomerSummaryRecord,
  type CustomerDetailRecord,
  type CustomerListQueryInput,
  type CustomerListOutcome,
  type StoredCustomerLedgerEntryRecord,
  type RecordOpeningBalanceInput,
  type RecordDebtPaymentInput,
  type RecordDebtAdjustmentInput,
  type CustomerLedgerMutationOutcome,
  type CustomerLedgerListQueryInput,
  type CustomerLedgerListOutcome,
  type RebuildCustomerBalancesOutcome,
  type RebuildCustomerSearchIndexOutcome,
  readCustomerLedgerFifoSync,
  SqliteCustomerStore,
  createSqliteCustomerStore,
} from './customer-repo.js';
