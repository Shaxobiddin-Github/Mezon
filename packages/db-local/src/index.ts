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
  SqliteDeviceStateRepository,
} from './device-state.js';

export {
  serializeOutboxJsonValue,
  serializeOutboxPayload,
  listAllOutboxRecordsSync,
  SqliteOutboxRepository,
} from './outbox.js';

export {
  type CreateSqliteUnitOfWorkOptions,
  SqliteUnitOfWorkSession,
  SqliteUnitOfWork,
  createSqliteUnitOfWork,
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
} from './writers.js';

export { localSchemaRegistry, localDeviceState, localOutbox } from './schema/index.js';
