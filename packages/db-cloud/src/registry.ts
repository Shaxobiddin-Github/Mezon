import { is, sql } from 'drizzle-orm';
import type { BuildColumns, BuildExtraConfigColumns } from 'drizzle-orm/column-builder';
import {
  type PgColumn,
  type PgColumnBuilderBase,
  PgDialect,
  PgTable,
  type PgTableExtraConfigValue,
  type PgTableWithColumns,
  check,
  getTableConfig,
  pgPolicy,
  pgTable,
} from 'drizzle-orm/pg-core';
import { pgHlc, pgUnixMs, pgUuidV7 } from './columns.js';
import { PG_APP_ROLE_NAME } from './rls.js';

export type TableClass = 'FACT' | 'ATTR' | 'MONOTONE' | 'LOCAL';
export type TenantScope = 'organization' | 'store' | 'none';

export interface PgTableDefinitionOptions<
  TClass extends TableClass = TableClass,
  TScope extends TenantScope = TenantScope,
> {
  readonly name: string;
  readonly tableClass: TClass;
  readonly tenantScope: TScope;
  readonly monotoneColumns?: readonly string[];
}

export interface PgTableMetadata {
  readonly tableName: string;
  readonly tableClass: TableClass;
  readonly tenantScope: TenantScope;
  readonly rlsEnabled: boolean;
  readonly monotoneColumns: readonly string[];
  readonly table: PgTable;
}

export class PgSchemaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PgSchemaValidationError';
  }
}

function createPgIdColumn() {
  return pgUuidV7('id').primaryKey().notNull();
}

function createPgOrgColumn() {
  return pgUuidV7('organization_id').notNull();
}

function createPgStoreColumn() {
  return pgUuidV7('store_id').notNull();
}

function createPgDeviceColumn() {
  return pgUuidV7('device_id').notNull();
}

function createPgHlcColumn() {
  return pgHlc('hlc').notNull();
}

function createPgCreatedAtMsColumn() {
  return pgUnixMs('created_at_ms').notNull();
}

function createPgUpdatedAtMsColumn() {
  return pgUnixMs('updated_at_ms').notNull();
}

function createPgDeletedAtMsColumn() {
  return pgUnixMs('deleted_at_ms');
}

type IdCol = { readonly id: ReturnType<typeof createPgIdColumn> };
type CreatedCol = { readonly createdAtMs: ReturnType<typeof createPgCreatedAtMsColumn> };
type UpdatedCol = { readonly updatedAtMs: ReturnType<typeof createPgUpdatedAtMsColumn> };
type DeletedCol = { readonly deletedAtMs: ReturnType<typeof createPgDeletedAtMsColumn> };
type SyncMetaCols = {
  readonly deviceId: ReturnType<typeof createPgDeviceColumn>;
  readonly hlc: ReturnType<typeof createPgHlcColumn>;
};
type TenantCols<TScope extends TenantScope> = TScope extends 'store'
  ? {
      readonly organizationId: ReturnType<typeof createPgOrgColumn>;
      readonly storeId: ReturnType<typeof createPgStoreColumn>;
    }
  : TScope extends 'organization'
    ? { readonly organizationId: ReturnType<typeof createPgOrgColumn> }
    : Record<never, never>;

export type PgCommonColumns<
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
 * Note: Cloud PostgreSQL RLS currently isolates strictly at the `organization_id` level.
 * Store-level (`store_id`) isolation on store-scoped tables is enforced at the application layer.
 */
function buildPgCommonColumns<TClass extends TableClass, TScope extends TenantScope>(
  tableClass: TClass,
  tenantScope: TScope,
): PgCommonColumns<TClass, TScope> {
  if (tableClass !== 'LOCAL' && tenantScope === 'none') {
    throw new PgSchemaValidationError(
      `Synced PostgreSQL table class "${tableClass}" cannot use tenantScope "none" (organization_id is mandatory)`,
    );
  }

  const base: Record<string, PgColumnBuilderBase> = {
    id: createPgIdColumn(),
  };

  if (tenantScope === 'organization' || tenantScope === 'store') {
    base.organizationId = createPgOrgColumn();
  }
  if (tenantScope === 'store') {
    base.storeId = createPgStoreColumn();
  }

  if (tableClass !== 'LOCAL') {
    base.deviceId = createPgDeviceColumn();
    base.hlc = createPgHlcColumn();
  }

  base.createdAtMs = createPgCreatedAtMsColumn();

  if (tableClass === 'ATTR' || tableClass === 'MONOTONE' || tableClass === 'LOCAL') {
    base.updatedAtMs = createPgUpdatedAtMsColumn();
  }
  if (tableClass === 'ATTR') {
    base.deletedAtMs = createPgDeletedAtMsColumn();
  }

  return base as PgCommonColumns<TClass, TScope>;
}

const FORBIDDEN_PG_SQL_TYPE_REGEX = /\b(real|double|float|numeric|decimal)\b/i;

export class PgSchemaRegistry {
  private readonly entries = new Map<string, PgTableMetadata>();

  defineTable<
    TName extends string,
    TClass extends TableClass,
    TScope extends TenantScope,
    TColumnsMap extends Record<string, PgColumnBuilderBase>,
  >(
    options: PgTableDefinitionOptions<TClass, TScope> & { readonly name: TName },
    buildColumns: (common: PgCommonColumns<TClass, TScope>) => TColumnsMap,
    extraConfig?: (
      self: BuildExtraConfigColumns<TName, TColumnsMap, 'pg'>,
    ) => PgTableExtraConfigValue[],
  ): PgTableWithColumns<{
    name: TName;
    schema: undefined;
    columns: BuildColumns<TName, TColumnsMap, 'pg'>;
    dialect: 'pg';
  }> {
    if (this.entries.has(options.name)) {
      throw new PgSchemaValidationError(`PostgreSQL table "${options.name}" is already registered`);
    }
    if (options.tableClass !== 'LOCAL' && options.tenantScope === 'none') {
      throw new PgSchemaValidationError(
        `Synced table "${options.name}" (${options.tableClass}) requires tenantScope "organization" or "store"`,
      );
    }

    const common = buildPgCommonColumns(options.tableClass, options.tenantScope);
    const columns = buildColumns(common);

    const rlsEnabled = options.tenantScope !== 'none';

    const tbl = pgTable(options.name, columns, (self) => {
      const autoExtra: PgTableExtraConfigValue[] = [];
      const cols = Object.values(self) as PgColumn[];
      for (const col of cols) {
        if (col.name === 'hlc') {
          autoExtra.push(check(`chk_${options.name}_${col.name}_len`, sql`length(${col}) = 58`));
        }
      }

      if (rlsEnabled) {
        autoExtra.push(
          pgPolicy(`${options.name}_tenant_isolation`, {
            as: 'permissive',
            for: 'all',
            to: PG_APP_ROLE_NAME,
            using: sql`${sql.identifier('organization_id')} = mezon_current_organization_id()`,
            withCheck: sql`${sql.identifier('organization_id')} = mezon_current_organization_id()`,
          }),
        );
      }

      const userExtra = extraConfig ? extraConfig(self) : [];
      return [...autoExtra, ...userExtra];
    });

    if (rlsEnabled) {
      tbl.enableRLS();
    }

    this.entries.set(options.name, {
      tableName: options.name,
      tableClass: options.tableClass,
      tenantScope: options.tenantScope,
      rlsEnabled,
      monotoneColumns: [...(options.monotoneColumns ?? [])],
      table: tbl,
    });

    return tbl;
  }

  get(tableName: string): PgTableMetadata | undefined {
    return this.entries.get(tableName);
  }

  all(): readonly PgTableMetadata[] {
    return Array.from(this.entries.values());
  }
}

function collectPgTablesFromNamespace(namespace: Record<string, unknown>): PgTable[] {
  const tables: PgTable[] = [];
  for (const value of Object.values(namespace)) {
    if (is(value, PgTable)) {
      tables.push(value);
    }
  }
  return tables;
}

function assertPgColumnExists(
  tableName: string,
  colsByName: ReadonlyMap<string, PgColumn>,
  columnName: string,
  expectedNotNull: boolean,
): void {
  const col = colsByName.get(columnName);
  if (!col) {
    throw new PgSchemaValidationError(
      `PostgreSQL table "${tableName}" is missing required column "${columnName}"`,
    );
  }
  if (col.notNull !== expectedNotNull) {
    throw new PgSchemaValidationError(
      `PostgreSQL table "${tableName}" column "${columnName}" must have notNull=${expectedNotNull}`,
    );
  }
}

export function validatePgSchemaRegistry(
  schemaNamespace: Record<string, unknown>,
  registry: PgSchemaRegistry,
): void {
  const tables = collectPgTablesFromNamespace(schemaNamespace);
  const dialect = new PgDialect();

  for (const table of tables) {
    const cfg = getTableConfig(table);
    const meta = registry.get(cfg.name);
    if (!meta || meta.table !== table) {
      throw new PgSchemaValidationError(`Unregistered PostgreSQL Drizzle table "${cfg.name}"`);
    }

    const isSynced = meta.tableClass !== 'LOCAL';
    if (isSynced && meta.tenantScope === 'none') {
      throw new PgSchemaValidationError(
        `Synced table "${cfg.name}" (${meta.tableClass}) cannot have tenantScope "none"`,
      );
    }

    const colsByName = new Map<string, PgColumn>(cfg.columns.map((c) => [c.name, c]));

    assertPgColumnExists(cfg.name, colsByName, 'id', true);
    assertPgColumnExists(cfg.name, colsByName, 'created_at_ms', true);

    if (meta.tenantScope === 'organization' || meta.tenantScope === 'store') {
      assertPgColumnExists(cfg.name, colsByName, 'organization_id', true);
      if (cfg.policies.length === 0) {
        throw new PgSchemaValidationError(
          `Tenant-scoped PostgreSQL table "${cfg.name}" must declare an RLS pgPolicy`,
        );
      }
    } else if (colsByName.has('organization_id')) {
      throw new PgSchemaValidationError(
        `Table "${cfg.name}" with tenantScope "none" must not declare organization_id`,
      );
    }

    if (meta.tenantScope === 'store') {
      assertPgColumnExists(cfg.name, colsByName, 'store_id', true);
    }

    if (isSynced) {
      assertPgColumnExists(cfg.name, colsByName, 'device_id', true);
      assertPgColumnExists(cfg.name, colsByName, 'hlc', true);
    } else if (colsByName.has('hlc') || colsByName.has('device_id')) {
      throw new PgSchemaValidationError(`LOCAL table "${cfg.name}" must not declare hlc/device_id`);
    }

    if (meta.tableClass === 'FACT') {
      if (colsByName.has('updated_at_ms') || colsByName.has('deleted_at_ms')) {
        throw new PgSchemaValidationError(
          `FACT table "${cfg.name}" is immutable and must not have updated_at_ms or deleted_at_ms`,
        );
      }
    } else if (meta.tableClass === 'MONOTONE') {
      assertPgColumnExists(cfg.name, colsByName, 'updated_at_ms', true);
      if (colsByName.has('deleted_at_ms')) {
        throw new PgSchemaValidationError(
          `MONOTONE table "${cfg.name}" must not declare tombstone column deleted_at_ms`,
        );
      }
    } else if (meta.tableClass === 'ATTR') {
      assertPgColumnExists(cfg.name, colsByName, 'updated_at_ms', true);
      assertPgColumnExists(cfg.name, colsByName, 'deleted_at_ms', false);
    } else {
      assertPgColumnExists(cfg.name, colsByName, 'updated_at_ms', true);
      if (colsByName.has('deleted_at_ms')) {
        throw new PgSchemaValidationError(
          `LOCAL table "${cfg.name}" must not declare tombstone column deleted_at_ms`,
        );
      }
    }

    const compiledChecks = cfg.checks.map((c) => dialect.sqlToQuery(c.value).sql);

    for (const col of cfg.columns) {
      const sqlType = col.getSQLType();
      if (
        col.columnType === 'PgReal' ||
        col.columnType === 'PgDoublePrecision' ||
        col.columnType === 'PgNumeric' ||
        FORBIDDEN_PG_SQL_TYPE_REGEX.test(sqlType)
      ) {
        throw new PgSchemaValidationError(
          `PostgreSQL table "${cfg.name}" column "${col.name}" uses forbidden floating/numeric type "${sqlType}" (${col.columnType})`,
        );
      }
      if (col.columnType === 'PgBigInt53') {
        throw new PgSchemaValidationError(
          `PostgreSQL table "${cfg.name}" column "${col.name}" uses bigint({ mode: 'number' }) which loses >53-bit precision; use bigint({ mode: 'bigint' }) only`,
        );
      }
      if (col.name === 'hlc') {
        const hasHlcCheck = compiledChecks.some((chkSql) =>
          chkSql.includes(`length("${cfg.name}"."${col.name}") = 58`),
        );
        if (!hasHlcCheck) {
          throw new PgSchemaValidationError(
            `PostgreSQL table "${cfg.name}" column "${col.name}" is missing mandatory CHECK (length(hlc) = 58)`,
          );
        }
      }
    }
  }
}
