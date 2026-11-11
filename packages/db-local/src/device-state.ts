import {
  type DeviceStateRepository,
  type DeviceStateSnapshot,
  type UnitOfWorkSession,
  type UuidV7,
  parseHlc,
  parseUuidV7,
  serializeHlc,
  unixMsFromBigInt,
} from '@mezon/domain';
import type Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { localDeviceState } from './schema/index.js';

export interface SqliteSessionDbAccess extends UnitOfWorkSession {
  readonly db: BetterSQLite3Database;
  assertOpen(): void;
}

export interface EnsureDeviceStateParams {
  readonly rowId: UuidV7;
  readonly organizationId: UuidV7;
  readonly deviceId: UuidV7;
  readonly initialHlcStr: string;
  readonly initialUuidMs: bigint;
  readonly nowMs: bigint;
}

export interface AdvanceDeviceSeqParams {
  readonly deviceId: UuidV7;
  readonly hlc: string;
  readonly uuidMs: bigint;
  readonly updatedAtMs: bigint;
}

export function readDeviceStateRowSync(
  db: BetterSQLite3Database,
  deviceId: UuidV7,
): DeviceStateSnapshot | null {
  const validDeviceId = parseUuidV7(deviceId);
  const rows = db
    .select({
      id: localDeviceState.id,
      organizationId: localDeviceState.organizationId,
      deviceId: localDeviceState.deviceId,
      lastDeviceSeq: localDeviceState.lastDeviceSeq,
      lastHlc: localDeviceState.lastHlc,
      lastUuidMs: localDeviceState.lastUuidMs,
      createdAtMs: localDeviceState.createdAtMs,
      updatedAtMs: localDeviceState.updatedAtMs,
    })
    .from(localDeviceState)
    .where(eq(localDeviceState.deviceId, validDeviceId))
    .all();

  if (rows.length === 0) {
    return null;
  }

  const row = rows[0];
  return {
    id: row.id,
    organizationId: row.organizationId,
    deviceId: row.deviceId,
    lastDeviceSeq: row.lastDeviceSeq,
    lastHlc: row.lastHlc,
    lastUuidMs: row.lastUuidMs,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

/**
 * Ensures the persistent `local_device_state` row exists inside the bootstrap transaction,
 * verifying tenant consistency and returning the persisted snapshot for clock/UUID recovery.
 */
export function ensureDeviceStateRowSync(
  sqlite: Database.Database,
  db: BetterSQLite3Database,
  params: EnsureDeviceStateParams,
): DeviceStateSnapshot {
  const validOrgId = parseUuidV7(params.organizationId);
  const validDeviceId = parseUuidV7(params.deviceId);
  const validRowId = parseUuidV7(params.rowId);
  const canonicalHlc = serializeHlc(parseHlc(params.initialHlcStr));
  const validUuidMs = unixMsFromBigInt(params.initialUuidMs);
  const validNowMs = unixMsFromBigInt(params.nowMs);

  const existing = readDeviceStateRowSync(db, validDeviceId);
  if (existing !== null) {
    if (existing.organizationId !== validOrgId) {
      throw new Error(
        `Device "${validDeviceId}" belongs to organization "${existing.organizationId}", expected "${validOrgId}"`,
      );
    }
    return existing;
  }

  sqlite
    .prepare(
      `
      INSERT INTO local_device_state (
        id, organization_id, device_id, last_device_seq, last_hlc, last_uuid_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      validRowId,
      validOrgId,
      validDeviceId,
      0n,
      canonicalHlc,
      validUuidMs,
      validNowMs,
      validNowMs,
    );

  const created = readDeviceStateRowSync(db, validDeviceId);
  if (created === null) {
    throw new Error(`Failed to initialize local_device_state for device "${validDeviceId}"`);
  }
  return created;
}

/**
 * Atomically allocates the next gapless `device_seq` (`last_device_seq + 1`) and persists
 * `last_hlc` and `last_uuid_ms` directly in SQLite `local_device_state`.
 *
 * Because this runs inside the caller's `BEGIN IMMEDIATE` / `SAVEPOINT` transaction,
 * SQLite automatically rolls back `last_device_seq` on outer rollback or `ROLLBACK TO SAVEPOINT`.
 */
export function advanceDeviceSeqAndStateSync(
  sqlite: Database.Database,
  params: AdvanceDeviceSeqParams,
): bigint {
  const validDeviceId = parseUuidV7(params.deviceId);
  const canonicalHlc = serializeHlc(parseHlc(params.hlc));
  const validUuidMs = unixMsFromBigInt(params.uuidMs);
  const validUpdatedAtMs = unixMsFromBigInt(params.updatedAtMs);

  const result = sqlite
    .prepare<[string, bigint, bigint, string], { readonly last_device_seq: unknown }>(
      `
      UPDATE local_device_state
      SET
        last_device_seq = last_device_seq + 1,
        last_hlc = ?,
        last_uuid_ms = ?,
        updated_at_ms = ?
      WHERE device_id = ?
      RETURNING last_device_seq
      `,
    )
    .get(canonicalHlc, validUuidMs, validUpdatedAtMs, validDeviceId);

  if (!result || typeof result.last_device_seq !== 'bigint') {
    throw new Error(
      `Cannot allocate device_seq: local_device_state row missing or invalid for device "${validDeviceId}"`,
    );
  }

  return result.last_device_seq;
}

type DeviceSequenceColumn =
  | 'last_receipt_seq'
  | 'last_return_seq'
  | 'last_receiving_seq'
  | 'last_supplier_return_seq'
  | 'last_shift_seq'
  | 'last_order_seq';

function advanceSeqColumnSync(
  sqlite: Database.Database,
  column: DeviceSequenceColumn,
  fieldLabel: string,
  params: {
    readonly deviceId: UuidV7;
    readonly updatedAtMs: bigint;
  },
): bigint {
  const validDeviceId = parseUuidV7(params.deviceId);
  const validUpdatedAtMs = unixMsFromBigInt(params.updatedAtMs);

  const row = sqlite
    .prepare<[bigint, string], Record<string, unknown>>(
      `
      UPDATE local_device_state
      SET
        ${column} = ${column} + 1,
        updated_at_ms = ?
      WHERE device_id = ?
      RETURNING ${column} AS seq_val
      `,
    )
    .get(validUpdatedAtMs, validDeviceId);

  const seqVal = row?.seq_val;
  if (typeof seqVal !== 'bigint') {
    throw new Error(
      `Cannot allocate ${fieldLabel}: local_device_state row missing or invalid for device "${validDeviceId}"`,
    );
  }

  return seqVal;
}

/**
 * Atomically allocates the next gapless per-device `receipt_no` (`last_receipt_seq + 1`) inside the
 * caller's active `BEGIN IMMEDIATE` transaction so failed sales and crashes never consume numbers.
 */
export function advanceReceiptSeqSync(
  sqlite: Database.Database,
  params: {
    readonly deviceId: UuidV7;
    readonly updatedAtMs: bigint;
  },
): bigint {
  return advanceSeqColumnSync(sqlite, 'last_receipt_seq', 'receipt_no', params);
}

export function readReceiptSeqSync(db: BetterSQLite3Database, deviceId: UuidV7): bigint {
  const validDeviceId = parseUuidV7(deviceId);
  const rows = db
    .select({ val: localDeviceState.lastReceiptSeq })
    .from(localDeviceState)
    .where(eq(localDeviceState.deviceId, validDeviceId))
    .limit(1)
    .all();
  return rows[0]?.val ?? 0n;
}

/**
 * Atomically allocates the next gapless per-device `return_no` (`last_return_seq + 1`) inside the
 * caller's active `BEGIN IMMEDIATE` transaction so failed returns and crashes never consume numbers.
 */
export function advanceReturnSeqSync(
  sqlite: Database.Database,
  params: {
    readonly deviceId: UuidV7;
    readonly updatedAtMs: bigint;
  },
): bigint {
  return advanceSeqColumnSync(sqlite, 'last_return_seq', 'return_no', params);
}

export function readReturnSeqSync(db: BetterSQLite3Database, deviceId: UuidV7): bigint {
  const validDeviceId = parseUuidV7(deviceId);
  const rows = db
    .select({ val: localDeviceState.lastReturnSeq })
    .from(localDeviceState)
    .where(eq(localDeviceState.deviceId, validDeviceId))
    .limit(1)
    .all();
  return rows[0]?.val ?? 0n;
}

/**
 * Atomically allocates the next gapless per-device `receiving_no` (`last_receiving_seq + 1`).
 */
export function advanceReceivingSeqSync(
  sqlite: Database.Database,
  params: {
    readonly deviceId: UuidV7;
    readonly updatedAtMs: bigint;
  },
): bigint {
  return advanceSeqColumnSync(sqlite, 'last_receiving_seq', 'receiving_no', params);
}

export function readReceivingSeqSync(db: BetterSQLite3Database, deviceId: UuidV7): bigint {
  const validDeviceId = parseUuidV7(deviceId);
  const rows = db
    .select({ val: localDeviceState.lastReceivingSeq })
    .from(localDeviceState)
    .where(eq(localDeviceState.deviceId, validDeviceId))
    .limit(1)
    .all();
  return rows[0]?.val ?? 0n;
}

/**
 * Atomically allocates the next gapless per-device supplier `return_no` (`last_supplier_return_seq + 1`).
 */
export function advanceSupplierReturnSeqSync(
  sqlite: Database.Database,
  params: {
    readonly deviceId: UuidV7;
    readonly updatedAtMs: bigint;
  },
): bigint {
  return advanceSeqColumnSync(sqlite, 'last_supplier_return_seq', 'supplier_return_no', params);
}

export function readSupplierReturnSeqSync(db: BetterSQLite3Database, deviceId: UuidV7): bigint {
  const validDeviceId = parseUuidV7(deviceId);
  const rows = db
    .select({ val: localDeviceState.lastSupplierReturnSeq })
    .from(localDeviceState)
    .where(eq(localDeviceState.deviceId, validDeviceId))
    .limit(1)
    .all();
  return rows[0]?.val ?? 0n;
}

/**
 * Atomically allocates the next gapless per-device `shift_no` (`last_shift_seq + 1`).
 */
export function advanceShiftSeqSync(
  sqlite: Database.Database,
  params: {
    readonly deviceId: UuidV7;
    readonly updatedAtMs: bigint;
  },
): bigint {
  return advanceSeqColumnSync(sqlite, 'last_shift_seq', 'shift_no', params);
}

export function readShiftSeqSync(db: BetterSQLite3Database, deviceId: UuidV7): bigint {
  const validDeviceId = parseUuidV7(deviceId);
  const rows = db
    .select({ val: localDeviceState.lastShiftSeq })
    .from(localDeviceState)
    .where(eq(localDeviceState.deviceId, validDeviceId))
    .limit(1)
    .all();
  return rows[0]?.val ?? 0n;
}

/**
 * Atomically allocates the next gapless per-device `order_no` (`last_order_seq + 1`).
 */
export function advanceOrderSeqSync(
  sqlite: Database.Database,
  params: {
    readonly deviceId: UuidV7;
    readonly updatedAtMs: bigint;
  },
): bigint {
  return advanceSeqColumnSync(sqlite, 'last_order_seq', 'order_no', params);
}

export function readOrderSeqSync(db: BetterSQLite3Database, deviceId: UuidV7): bigint {
  const validDeviceId = parseUuidV7(deviceId);
  const rows = db
    .select({ val: localDeviceState.lastOrderSeq })
    .from(localDeviceState)
    .where(eq(localDeviceState.deviceId, validDeviceId))
    .limit(1)
    .all();
  return rows[0]?.val ?? 0n;
}

export class SqliteDeviceStateRepository implements DeviceStateRepository<SqliteSessionDbAccess> {
  getByDeviceId(
    session: SqliteSessionDbAccess,
    deviceId: UuidV7,
  ): Promise<DeviceStateSnapshot | null> {
    session.assertOpen();
    return Promise.resolve(readDeviceStateRowSync(session.db, deviceId));
  }
}
