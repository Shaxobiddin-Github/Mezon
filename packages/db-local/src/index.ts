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

export { localSchemaRegistry } from './schema/index.js';
