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
  PgSchemaValidationError,
  PgSchemaRegistry,
  validatePgSchemaRegistry,
} from './registry.js';

export {
  type PgValueParser,
  getGlobalPgTypeParser,
  createCloudPgTypesConfig,
  type CloudPgConnection,
  createCloudPgPool,
  withPgTenantContext,
} from './connection.js';

export { getDefaultCloudMigrationsFolder, migrateCloudDatabase } from './migrate.js';

export { cloudSchemaRegistry } from './schema/index.js';
