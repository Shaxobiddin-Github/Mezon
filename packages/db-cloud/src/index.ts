export const DB_CLOUD_PACKAGE = '@mezon/db-cloud';

export {
  pgBigint,
  pgMoney,
  pgQuantity,
  pgUnixMs,
  pgInt,
  pgUuidV7,
  pgHlc,
  pgBoolean,
} from './columns.js';

export {
  PG_APP_ROLE_NAME,
  PG_TENANT_SETTING_KEY,
  type SyncedTableClass,
  getTenantPrivilegesForClass,
  buildTenantRlsSql,
  assertRlsMigrationsComplete,
} from './rls.js';

export {
  type TableClass,
  type TenantScope,
  type PgTableDefinitionOptions,
  type PgTableMetadata,
  type PgCommonColumns,
  type CloudForeignKeyRef,
  PgSchemaValidationError,
  PgSchemaRegistry,
  validatePgSchemaRegistry,
  snakeToCamel,
  buildDrizzleForeignReferencesMap,
} from './registry.js';

export {
  type PgValueParser,
  getGlobalPgTypeParser,
  createCloudPgTypesConfig,
  type CloudPgConnection,
  createCloudPgPool,
  withPgTenantContext,
  assertNonSuperuserNonBypassRls,
} from './connection.js';

export { getDefaultCloudMigrationsFolder, migrateCloudDatabase } from './migrate.js';

export {
  cloudSchemaRegistry,
  cloudOrganizations,
  cloudStores,
  cloudUsers,
  cloudRefreshTokens,
  cloudLoginIdentities,
  cloudDevicePairingCodes,
  cloudDevices,
  cloudDeviceTokens,
  cloudSyncEvents,
  cloudStoreSyncPositions,
  cloudSyncParked,
  users,
  categories,
  products,
  productVariants,
  productBarcodes,
  priceChanges,
  batches,
  stockMoves,
  inventoryCounts,
  inventoryCountLines,
  promotions,
  sales,
  saleLines,
  payments,
  cashMoves,
  returns,
  returnLines,
  returnPayments,
  customers,
  customerLedger,
  suppliers,
  goodsReceivings,
  goodsReceivingLines,
  receivingCostConfirmations,
  supplierReturns,
  supplierReturnLines,
  supplierLedger,
  shifts,
  shiftCashierSessions,
  shiftClosures,
  shiftClosureMethodTotals,
  shiftClosureCashiers,
  dayCloses,
  orders,
  orderLines,
  orderPayments,
  organizationTaxProfiles,
  fiscalDocs,
} from './schema/index.js';

export { CloudAuthStore, type CloudLoginLookupResult } from './auth-store.js';

export { CloudTenantStore, type CreateOrganizationParams } from './tenant-store.js';

export {
  CloudDeviceStore,
  type PairingCodeLookup,
  type DeviceOwnerLookup,
  type VerifiedDeviceContext,
} from './device-store.js';

export {
  CloudSyncPushStore,
  type ForeignRefCheckResult,
  type MissingReferenceInfo,
  extractPgErrorCode,
} from './sync-push-store.js';

export { AdminReadStore, type AdminStoreOptions } from './admin-store.js';
export { resolveIntlDateKey } from './timezone.js';
export { CloudSyncPullStore, ForeignStoreError } from './sync-pull-store.js';
export { CloudSyncParkedStore, type CloudParkedEventRecord } from './sync-parked-store.js';

export { isDockerAvailable, shouldRunPgTests } from './pg-test-helper.js';
