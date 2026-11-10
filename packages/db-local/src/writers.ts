import {
  DomainError,
  type OutboxEntityClass,
  type UnixMs,
  type UuidV7,
  parseUuidV7,
  serializeHlc,
} from '@mezon/domain';
import { type SQL, and, eq, getTableColumns, isNull } from 'drizzle-orm';
import { type SQLiteColumn, type SQLiteTable, getTableConfig } from 'drizzle-orm/sqlite-core';
import type { SqliteTableMetadata } from './registry.js';
import type { SqliteUnitOfWorkSession } from './uow.js';

type ReservedCommonKeys =
  | 'id'
  | 'organizationId'
  | 'storeId'
  | 'deviceId'
  | 'hlc'
  | 'createdAtMs'
  | 'updatedAtMs'
  | 'deletedAtMs';

const RESERVED_COMMON_KEYS = new Set<string>([
  'id',
  'organizationId',
  'storeId',
  'deviceId',
  'hlc',
  'createdAtMs',
  'updatedAtMs',
  'deletedAtMs',
]);

export type BusinessInsertValues<TTable extends SQLiteTable> = Omit<
  TTable['$inferInsert'],
  ReservedCommonKeys
>;

export type BusinessUpdateValues<TTable extends SQLiteTable> = Partial<
  BusinessInsertValues<TTable>
>;

export interface InsertEntityOptions<TValues extends Record<string, unknown>> {
  readonly organizationId: UuidV7;
  readonly storeId?: UuidV7;
  readonly values: TValues;
  readonly eventType?: string;
  readonly schemaVersion?: number;
  readonly payload?: Record<string, unknown>;
}

export interface UpdateAttrOptions<TValues extends Record<string, unknown>> {
  readonly id: UuidV7;
  readonly organizationId: UuidV7;
  readonly storeId?: UuidV7;
  readonly values: TValues;
  readonly eventType?: string;
  readonly schemaVersion?: number;
  readonly payload?: Record<string, unknown>;
}

export interface TombstoneAttrOptions {
  readonly id: UuidV7;
  readonly organizationId: UuidV7;
  readonly storeId?: UuidV7;
  readonly eventType?: string;
  readonly schemaVersion?: number;
  readonly payload?: Record<string, unknown>;
}

export interface SyncedWriteResult<TRow> {
  readonly entityId: UuidV7;
  readonly eventId: UuidV7;
  readonly deviceSeq: bigint;
  readonly hlc: string;
  readonly row: TRow;
}

interface PreparedContext {
  readonly meta: SqliteTableMetadata;
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7 | null;
}

function assertNoReservedOverrides(values: Record<string, unknown>): void {
  for (const key of Object.keys(values)) {
    if (RESERVED_COMMON_KEYS.has(key)) {
      throw new TypeError(`Business write values must not specify managed common column "${key}"`);
    }
  }
}

function prepareSyncedWriteContext(
  session: SqliteUnitOfWorkSession,
  table: SQLiteTable,
  expectedClass: OutboxEntityClass,
  organizationId: UuidV7,
  storeId?: UuidV7,
): PreparedContext {
  session.assertActiveTransaction();
  const cfg = getTableConfig(table);
  const meta = session.requireTableMetadata(table, cfg.name);

  if (meta.tableClass !== expectedClass) {
    throw new TypeError(
      `Writer expects table class "${expectedClass}", but "${meta.tableName}" is "${meta.tableClass}"`,
    );
  }

  const validOrgId = parseUuidV7(organizationId);
  if (validOrgId !== session.organizationId) {
    throw new DomainError(
      'UNIT_OF_WORK_TENANT_MISMATCH',
      `Write organizationId "${validOrgId}" does not match UnitOfWork organizationId "${session.organizationId}"`,
    );
  }
  let validStoreId: UuidV7 | null = null;
  if (meta.tenantScope === 'store') {
    if (storeId === undefined) {
      throw new TypeError(`Store-scoped table "${meta.tableName}" requires storeId`);
    }
    validStoreId = parseUuidV7(storeId);
  } else if (storeId !== undefined) {
    throw new TypeError(`Organization-scoped table "${meta.tableName}" must not receive a storeId`);
  }

  return {
    meta,
    organizationId: validOrgId,
    storeId: validStoreId,
  };
}

function requireColumn(
  cols: Readonly<Record<string, SQLiteColumn>>,
  tableName: string,
  key: string,
): SQLiteColumn {
  const col = cols[key];
  if (!col) {
    throw new Error(`Expected column "${key}" on table "${tableName}"`);
  }
  return col;
}

function buildActiveAttrPredicates(
  table: SQLiteTable,
  tableName: string,
  entityId: UuidV7,
  organizationId: UuidV7,
  storeId: UuidV7 | null,
): SQL[] {
  const cols = getTableColumns(table);
  const predicates: SQL[] = [
    eq(requireColumn(cols, tableName, 'id'), entityId),
    eq(requireColumn(cols, tableName, 'organizationId'), organizationId),
    isNull(requireColumn(cols, tableName, 'deletedAtMs')),
  ];
  if (storeId !== null) {
    predicates.push(eq(requireColumn(cols, tableName, 'storeId'), storeId));
  }
  return predicates;
}

function extractSingleReturnedRow(raw: unknown): Record<string, unknown> | null {
  if (!Array.isArray(raw) || raw.length !== 1) {
    return null;
  }
  const first: unknown = raw[0];
  if (typeof first !== 'object' || first === null || Array.isArray(first)) {
    return null;
  }
  return first as Record<string, unknown>;
}

function insertSyncedRecord<TTable extends SQLiteTable>(
  session: SqliteUnitOfWorkSession,
  table: TTable,
  expectedClass: 'FACT' | 'ATTR',
  options: InsertEntityOptions<BusinessInsertValues<TTable>>,
): SyncedWriteResult<TTable['$inferSelect']> {
  const { meta, organizationId, storeId } = prepareSyncedWriteContext(
    session,
    table,
    expectedClass,
    options.organizationId,
    options.storeId,
  );
  const rawValues = options.values as Record<string, unknown>;
  assertNoReservedOverrides(rawValues);

  const entityId = session.nextId();
  const hlc = serializeHlc(session.nextHlc());
  const nowMs = session.nowUnixMs();

  const rowToInsert: Record<string, unknown> = {
    ...rawValues,
    id: entityId,
    organizationId,
    ...(storeId !== null ? { storeId } : {}),
    deviceId: session.deviceId,
    hlc,
    createdAtMs: nowMs,
    ...(expectedClass === 'ATTR' ? { updatedAtMs: nowMs, deletedAtMs: null } : {}),
  };

  session.db
    .insert(table)
    .values(rowToInsert as TTable['$inferInsert'])
    .run();

  const outboxRes = session.recordOutboxEvent({
    organizationId,
    storeId,
    hlc,
    nowMs,
    type: options.eventType ?? `${meta.tableName}.created`,
    entity: meta.tableName,
    entityId,
    entityClass: expectedClass,
    schemaVersion: options.schemaVersion ?? 1,
    payload: options.payload ?? rowToInsert,
  });

  return {
    entityId,
    eventId: outboxRes.eventId,
    deviceSeq: outboxRes.deviceSeq,
    hlc: outboxRes.hlc,
    row: rowToInsert,
  };
}

function mutateActiveAttr<TTable extends SQLiteTable>(
  session: SqliteUnitOfWorkSession,
  table: TTable,
  options: {
    readonly opName: 'updateAttr' | 'tombstoneAttr';
    readonly id: UuidV7;
    readonly organizationId: UuidV7;
    readonly storeId?: UuidV7;
    readonly defaultVerb: 'updated' | 'deleted';
    readonly eventType?: string;
    readonly schemaVersion?: number;
    readonly payload?: Record<string, unknown>;
    readonly buildPatch: (nowMs: UnixMs, hlc: string) => Record<string, unknown>;
  },
): SyncedWriteResult<TTable['$inferSelect']> {
  const { meta, organizationId, storeId } = prepareSyncedWriteContext(
    session,
    table,
    'ATTR',
    options.organizationId,
    options.storeId,
  );

  const validEntityId = parseUuidV7(options.id);
  const hlc = serializeHlc(session.nextHlc());
  const nowMs = session.nowUnixMs();
  const predicates = buildActiveAttrPredicates(
    table,
    meta.tableName,
    validEntityId,
    organizationId,
    storeId,
  );

  const setPatch = options.buildPatch(nowMs, hlc);
  const rawReturned: unknown = session.db
    .update(table)
    .set(setPatch as Partial<TTable['$inferInsert']>)
    .where(and(...predicates))
    .returning()
    .all();

  const updatedRow = extractSingleReturnedRow(rawReturned);
  if (!updatedRow) {
    throw new Error(
      `${options.opName} target "${validEntityId}" in "${meta.tableName}" not found, belongs to another tenant, or is already tombstoned`,
    );
  }

  const outboxRes = session.recordOutboxEvent({
    organizationId,
    storeId,
    hlc,
    nowMs,
    type: options.eventType ?? `${meta.tableName}.${options.defaultVerb}`,
    entity: meta.tableName,
    entityId: validEntityId,
    entityClass: 'ATTR',
    schemaVersion: options.schemaVersion ?? 1,
    payload: options.payload ?? updatedRow,
  });

  return {
    entityId: validEntityId,
    eventId: outboxRes.eventId,
    deviceSeq: outboxRes.deviceSeq,
    hlc: outboxRes.hlc,
    row: updatedRow,
  };
}

/**
 * Inserts an immutable `FACT` record inside an active `SqliteUnitOfWorkSession`, populating all
 * common columns and appending the matching `local_outbox` event + `device_seq` in the same tx.
 */
export function insertFact<TTable extends SQLiteTable>(
  session: SqliteUnitOfWorkSession,
  table: TTable,
  options: InsertEntityOptions<BusinessInsertValues<TTable>>,
): SyncedWriteResult<TTable['$inferSelect']> {
  return insertSyncedRecord(session, table, 'FACT', options);
}

/**
 * Inserts an editable `ATTR` record inside an active `SqliteUnitOfWorkSession`, populating all
 * common columns (`deletedAtMs: null`) and atomically recording its `local_outbox` event.
 */
export function insertAttr<TTable extends SQLiteTable>(
  session: SqliteUnitOfWorkSession,
  table: TTable,
  options: InsertEntityOptions<BusinessInsertValues<TTable>>,
): SyncedWriteResult<TTable['$inferSelect']> {
  return insertSyncedRecord(session, table, 'ATTR', options);
}

/**
 * Updates an active (non-tombstoned) `ATTR` record inside an active `SqliteUnitOfWorkSession`,
 * advancing `deviceId`, `hlc`, `updatedAtMs`, and recording a matching `local_outbox` event.
 */
export function updateAttr<TTable extends SQLiteTable>(
  session: SqliteUnitOfWorkSession,
  table: TTable,
  options: UpdateAttrOptions<BusinessUpdateValues<TTable>>,
): SyncedWriteResult<TTable['$inferSelect']> {
  const rawValues = options.values as Record<string, unknown>;
  assertNoReservedOverrides(rawValues);
  if (Object.keys(rawValues).length === 0) {
    throw new TypeError('updateAttr requires at least one business field to update');
  }

  return mutateActiveAttr(session, table, {
    opName: 'updateAttr',
    id: options.id,
    organizationId: options.organizationId,
    storeId: options.storeId,
    defaultVerb: 'updated',
    eventType: options.eventType,
    schemaVersion: options.schemaVersion,
    payload: options.payload,
    buildPatch: (nowMs, hlc) => ({
      ...rawValues,
      deviceId: session.deviceId,
      hlc,
      updatedAtMs: nowMs,
    }),
  });
}

/**
 * Tombstones an active `ATTR` record (`deleted_at_ms = nowMs`) without executing SQL `DELETE`,
 * advancing `deviceId`, `hlc`, `updatedAtMs`, and recording a matching `local_outbox` event.
 */
export function tombstoneAttr<TTable extends SQLiteTable>(
  session: SqliteUnitOfWorkSession,
  table: TTable,
  options: TombstoneAttrOptions,
): SyncedWriteResult<TTable['$inferSelect']> {
  return mutateActiveAttr(session, table, {
    opName: 'tombstoneAttr',
    id: options.id,
    organizationId: options.organizationId,
    storeId: options.storeId,
    defaultVerb: 'deleted',
    eventType: options.eventType,
    schemaVersion: options.schemaVersion,
    payload: options.payload,
    buildPatch: (nowMs, hlc) => ({
      deviceId: session.deviceId,
      hlc,
      updatedAtMs: nowMs,
      deletedAtMs: nowMs,
    }),
  });
}
