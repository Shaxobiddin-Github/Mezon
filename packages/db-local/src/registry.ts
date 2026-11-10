import { is, sql } from 'drizzle-orm';
import type { BuildColumns } from 'drizzle-orm/column-builder';
import {
  type SQLiteColumn,
  type SQLiteColumnBuilderBase,
  SQLiteSyncDialect,
  SQLiteTable,
  type SQLiteTableExtraConfigValue,
  type SQLiteTableWithColumns,
  check,
  getTableConfig,
  sqliteTable,
} from 'drizzle-orm/sqlite-core';
import { getSqliteCustomColumnKind, sqliteHlc, sqliteUnixMs, sqliteUuidV7 } from './columns.js';

export type TableClass = 'FACT' | 'ATTR' | 'MONOTONE' | 'LOCAL';
export type TenantScope = 'organization' | 'store' | 'none';

export interface TableDefinitionOptions<
  TClass extends TableClass = TableClass,
  TScope extends TenantScope = TenantScope,
> {
  readonly name: string;
  readonly tableClass: TClass;
  readonly tenantScope: TScope;
  readonly monotoneColumns?: readonly string[];
}

export interface SqliteTableMetadata {
  readonly tableName: string;
  readonly tableClass: TableClass;
  readonly tenantScope: TenantScope;
  readonly monotoneColumns: readonly string[];
  readonly table: SQLiteTable;
}

export class SchemaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaValidationError';
  }
}

function createIdColumn() {
  return sqliteUuidV7('id').primaryKey().notNull();
}

function createOrgColumn() {
  return sqliteUuidV7('organization_id').notNull();
}

function createStoreColumn() {
  return sqliteUuidV7('store_id').notNull();
}

function createDeviceColumn() {
  return sqliteUuidV7('device_id').notNull();
}

function createHlcColumn() {
  return sqliteHlc('hlc').notNull();
}

function createCreatedAtMsColumn() {
  return sqliteUnixMs('created_at_ms').notNull();
}

function createUpdatedAtMsColumn() {
  return sqliteUnixMs('updated_at_ms').notNull();
}

function createDeletedAtMsColumn() {
  return sqliteUnixMs('deleted_at_ms');
}

type IdCol = { readonly id: ReturnType<typeof createIdColumn> };
type CreatedCol = { readonly createdAtMs: ReturnType<typeof createCreatedAtMsColumn> };
type UpdatedCol = { readonly updatedAtMs: ReturnType<typeof createUpdatedAtMsColumn> };
type DeletedCol = { readonly deletedAtMs: ReturnType<typeof createDeletedAtMsColumn> };
type SyncMetaCols = {
  readonly deviceId: ReturnType<typeof createDeviceColumn>;
  readonly hlc: ReturnType<typeof createHlcColumn>;
};
type TenantCols<TScope extends TenantScope> = TScope extends 'store'
  ? {
      readonly organizationId: ReturnType<typeof createOrgColumn>;
      readonly storeId: ReturnType<typeof createStoreColumn>;
    }
  : TScope extends 'organization'
    ? { readonly organizationId: ReturnType<typeof createOrgColumn> }
    : Record<never, never>;

export type SqliteCommonColumns<
  TClass extends TableClass,
  TScope extends TenantScope,
> = TClass extends 'FACT'
  ? IdCol & TenantCols<TScope> & SyncMetaCols & CreatedCol
  : TClass extends 'ATTR'
    ? IdCol & TenantCols<TScope> & SyncMetaCols & CreatedCol & UpdatedCol & DeletedCol
    : TClass extends 'MONOTONE'
      ? IdCol & TenantCols<TScope> & SyncMetaCols & CreatedCol & UpdatedCol
      : IdCol & TenantCols<TScope> & CreatedCol & UpdatedCol;

/**
 * Note: Cloud PostgreSQL RLS isolates at the `organization_id` level; `store_id` isolation on
 * store-scoped tables is enforced at the application/repository layer.
 */
function buildCommonColumns<TClass extends TableClass, TScope extends TenantScope>(
  tableClass: TClass,
  tenantScope: TScope,
): SqliteCommonColumns<TClass, TScope> {
  if (tableClass !== 'LOCAL' && tenantScope === 'none') {
    throw new SchemaValidationError(
      `Synced table class "${tableClass}" cannot use tenantScope "none" (organization_id is mandatory)`,
    );
  }

  const base: Record<string, SQLiteColumnBuilderBase> = {
    id: createIdColumn(),
  };

  if (tenantScope === 'organization' || tenantScope === 'store') {
    base.organizationId = createOrgColumn();
  }
  if (tenantScope === 'store') {
    base.storeId = createStoreColumn();
  }

  if (tableClass !== 'LOCAL') {
    base.deviceId = createDeviceColumn();
    base.hlc = createHlcColumn();
  }

  base.createdAtMs = createCreatedAtMsColumn();

  if (tableClass === 'ATTR' || tableClass === 'MONOTONE' || tableClass === 'LOCAL') {
    base.updatedAtMs = createUpdatedAtMsColumn();
  }
  if (tableClass === 'ATTR') {
    base.deletedAtMs = createDeletedAtMsColumn();
  }

  return base as SqliteCommonColumns<TClass, TScope>;
}

const FORBIDDEN_SQL_TYPE_REGEX = /\b(real|double|float|numeric|decimal)\b/i;

export class SqliteSchemaRegistry {
  private readonly entries = new Map<string, SqliteTableMetadata>();

  defineTable<
    TName extends string,
    TClass extends TableClass,
    TScope extends TenantScope,
    TColumnsMap extends Record<string, SQLiteColumnBuilderBase>,
  >(
    options: TableDefinitionOptions<TClass, TScope> & { readonly name: TName },
    buildColumns: (common: SqliteCommonColumns<TClass, TScope>) => TColumnsMap,
    extraConfig?: (
      self: BuildColumns<TName, TColumnsMap, 'sqlite'>,
    ) => SQLiteTableExtraConfigValue[],
  ): SQLiteTableWithColumns<{
    name: TName;
    schema: undefined;
    columns: BuildColumns<TName, TColumnsMap, 'sqlite'>;
    dialect: 'sqlite';
  }> {
    if (this.entries.has(options.name)) {
      throw new SchemaValidationError(`Table "${options.name}" is already registered`);
    }
    if (options.tableClass !== 'LOCAL' && options.tenantScope === 'none') {
      throw new SchemaValidationError(
        `Synced table "${options.name}" (${options.tableClass}) requires tenantScope "organization" or "store"`,
      );
    }

    const common = buildCommonColumns(options.tableClass, options.tenantScope);
    const columns = buildColumns(common);

    const tbl = sqliteTable(options.name, columns, (self) => {
      const autoChecks: SQLiteTableExtraConfigValue[] = [];
      const cols = Object.values(self) as SQLiteColumn[];
      for (const col of cols) {
        const kind = getSqliteCustomColumnKind(col);
        if (kind === 'bigint') {
          const expr = col.notNull
            ? sql`typeof(${col}) = 'integer'`
            : sql`${col} IS NULL OR typeof(${col}) = 'integer'`;
          autoChecks.push(check(`chk_${options.name}_${col.name}_int`, expr));
        }
        if (kind === 'hlc' || col.name === 'hlc') {
          autoChecks.push(check(`chk_${options.name}_${col.name}_len`, sql`length(${col}) = 58`));
        }
      }
      const userExtra = extraConfig ? extraConfig(self) : [];
      return [...autoChecks, ...userExtra];
    });

    this.entries.set(options.name, {
      tableName: options.name,
      tableClass: options.tableClass,
      tenantScope: options.tenantScope,
      monotoneColumns: [...(options.monotoneColumns ?? [])],
      table: tbl,
    });

    return tbl;
  }

  get(tableName: string): SqliteTableMetadata | undefined {
    return this.entries.get(tableName);
  }

  all(): readonly SqliteTableMetadata[] {
    return Array.from(this.entries.values());
  }
}

function collectTablesFromNamespace(namespace: Record<string, unknown>): SQLiteTable[] {
  const tables: SQLiteTable[] = [];
  for (const value of Object.values(namespace)) {
    if (is(value, SQLiteTable)) {
      tables.push(value);
    }
  }
  return tables;
}

function assertColumnExists(
  tableName: string,
  colsByName: ReadonlyMap<string, SQLiteColumn>,
  columnName: string,
  expectedNotNull: boolean,
): void {
  const col = colsByName.get(columnName);
  if (!col) {
    throw new SchemaValidationError(
      `Table "${tableName}" is missing required column "${columnName}"`,
    );
  }
  if (col.notNull !== expectedNotNull) {
    throw new SchemaValidationError(
      `Table "${tableName}" column "${columnName}" must have notNull=${expectedNotNull}`,
    );
  }
}

export function validateSqliteSchemaRegistry(
  schemaNamespace: Record<string, unknown>,
  registry: SqliteSchemaRegistry,
): void {
  const tables = collectTablesFromNamespace(schemaNamespace);
  const dialect = new SQLiteSyncDialect();

  for (const table of tables) {
    const cfg = getTableConfig(table);
    const meta = registry.get(cfg.name);
    if (!meta || meta.table !== table) {
      throw new SchemaValidationError(`Unregistered SQLite Drizzle table "${cfg.name}"`);
    }

    const isSynced = meta.tableClass !== 'LOCAL';
    if (isSynced && meta.tenantScope === 'none') {
      throw new SchemaValidationError(
        `Synced table "${cfg.name}" (${meta.tableClass}) cannot have tenantScope "none"`,
      );
    }

    const colsByName = new Map<string, SQLiteColumn>(cfg.columns.map((c) => [c.name, c]));

    assertColumnExists(cfg.name, colsByName, 'id', true);
    assertColumnExists(cfg.name, colsByName, 'created_at_ms', true);

    if (meta.tenantScope === 'organization' || meta.tenantScope === 'store') {
      assertColumnExists(cfg.name, colsByName, 'organization_id', true);
    } else if (colsByName.has('organization_id')) {
      throw new SchemaValidationError(
        `Table "${cfg.name}" with tenantScope "none" must not declare organization_id`,
      );
    }

    if (meta.tenantScope === 'store') {
      assertColumnExists(cfg.name, colsByName, 'store_id', true);
    }

    if (isSynced) {
      assertColumnExists(cfg.name, colsByName, 'device_id', true);
      assertColumnExists(cfg.name, colsByName, 'hlc', true);
    } else {
      if (colsByName.has('hlc') || colsByName.has('device_id')) {
        throw new SchemaValidationError(`LOCAL table "${cfg.name}" must not declare hlc/device_id`);
      }
    }

    if (meta.tableClass === 'FACT') {
      if (colsByName.has('updated_at_ms') || colsByName.has('deleted_at_ms')) {
        throw new SchemaValidationError(
          `FACT table "${cfg.name}" is immutable and must not have updated_at_ms or deleted_at_ms`,
        );
      }
    } else if (meta.tableClass === 'MONOTONE') {
      assertColumnExists(cfg.name, colsByName, 'updated_at_ms', true);
      if (colsByName.has('deleted_at_ms')) {
        throw new SchemaValidationError(
          `MONOTONE table "${cfg.name}" must not declare tombstone column deleted_at_ms`,
        );
      }
    } else if (meta.tableClass === 'ATTR') {
      assertColumnExists(cfg.name, colsByName, 'updated_at_ms', true);
      assertColumnExists(cfg.name, colsByName, 'deleted_at_ms', false);
    } else {
      assertColumnExists(cfg.name, colsByName, 'updated_at_ms', true);
      if (colsByName.has('deleted_at_ms')) {
        throw new SchemaValidationError(
          `LOCAL table "${cfg.name}" must not declare tombstone column deleted_at_ms`,
        );
      }
    }

    const compiledChecks = cfg.checks.map((c) => dialect.sqlToQuery(c.value).sql);

    for (const col of cfg.columns) {
      const sqlType = col.getSQLType();
      if (
        col.columnType === 'SQLiteReal' ||
        col.columnType === 'SQLiteNumeric' ||
        FORBIDDEN_SQL_TYPE_REGEX.test(sqlType)
      ) {
        throw new SchemaValidationError(
          `Table "${cfg.name}" column "${col.name}" uses forbidden floating/numeric type "${sqlType}" (${col.columnType})`,
        );
      }
      if (col.columnType === 'SQLiteInteger') {
        throw new SchemaValidationError(
          `Table "${cfg.name}" column "${col.name}" uses raw SQLiteInteger which is unsafe with defaultSafeIntegers(true); use sqliteBigint, sqliteUnixMs, sqliteInt, or sqliteBoolean`,
        );
      }

      const kind = getSqliteCustomColumnKind(col);
      if (kind === 'bigint') {
        const hasTypeCheck = compiledChecks.some((chkSql) => {
          const hasIntCheck = chkSql.includes(`typeof("${cfg.name}"."${col.name}") = 'integer'`);
          if (!col.notNull) {
            return hasIntCheck && chkSql.includes(`"${cfg.name}"."${col.name}" IS NULL OR`);
          }
          return hasIntCheck;
        });
        if (!hasTypeCheck) {
          throw new SchemaValidationError(
            `Table "${cfg.name}" bigint column "${col.name}" is missing mandatory typeof() = 'integer' CHECK constraint`,
          );
        }
      }

      if (col.name === 'hlc' || kind === 'hlc') {
        const hasHlcCheck = compiledChecks.some((chkSql) =>
          chkSql.includes(`length("${cfg.name}"."${col.name}") = 58`),
        );
        if (!hasHlcCheck) {
          throw new SchemaValidationError(
            `Table "${cfg.name}" hlc column "${col.name}" is missing mandatory CHECK (length(hlc) = 58)`,
          );
        }
      }
    }
  }
}
