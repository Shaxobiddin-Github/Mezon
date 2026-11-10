import type { UnixMs } from './clock.js';
import type { UuidV7 } from './uuidv7.js';

export type OutboxEntityClass = 'FACT' | 'ATTR' | 'MONOTONE';

export type OutboxPushStatus = 'pending' | 'acked' | 'rejected';

/**
 * Sync envelope schema matching GEMINI.md Section 4.
 * `id = eventId` in local storage so there is a single UUIDv7 primary identifier.
 */
export interface OutboxEnvelope {
  readonly eventId: UuidV7;
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7 | null;
  readonly deviceId: UuidV7;
  readonly deviceSeq: bigint;
  readonly hlc: string;
  readonly type: string;
  readonly entity: string;
  readonly entityId: UuidV7;
  readonly class: OutboxEntityClass;
  readonly schemaVersion: number;
  readonly payload: Record<string, unknown>;
}

export interface PersistedOutboxRecord extends OutboxEnvelope {
  readonly status: OutboxPushStatus;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly pushedAtMs: UnixMs | null;
  readonly createdAtMs: UnixMs;
  readonly updatedAtMs: UnixMs;
}

export interface DeviceStateSnapshot {
  readonly id: UuidV7;
  readonly organizationId: UuidV7;
  readonly deviceId: UuidV7;
  readonly lastDeviceSeq: bigint;
  readonly lastHlc: string;
  readonly lastUuidMs: UnixMs;
  readonly createdAtMs: UnixMs;
  readonly updatedAtMs: UnixMs;
}

/**
 * Active transactional session handle passed into `UnitOfWork.execute` and `nested`.
 * Repositories and writers accept a session handle rather than raw DB connections
 * so writes outside an active transaction are rejected at both compile time and runtime.
 */
export interface UnitOfWorkSession {
  nested<T>(fn: (session: this) => Promise<T>): Promise<T>;
  isClosed(): boolean;
}

/**
 * Asynchronous Unit of Work port compatible with both synchronous (`better-sqlite3` on Windows/Node)
 * and asynchronous (`@capacitor-community/sqlite` on Android) drivers.
 */
export interface UnitOfWork<TSession extends UnitOfWorkSession = UnitOfWorkSession> {
  execute<T>(fn: (session: TSession) => Promise<T>): Promise<T>;
  runReadOnly<T>(fn: () => Promise<T>): Promise<T>;
}

export interface OutboxRepository<TSession extends UnitOfWorkSession = UnitOfWorkSession> {
  listPending(session: TSession, limit?: number): Promise<readonly PersistedOutboxRecord[]>;
}

export interface DeviceStateRepository<TSession extends UnitOfWorkSession = UnitOfWorkSession> {
  getByDeviceId(session: TSession, deviceId: UuidV7): Promise<DeviceStateSnapshot | null>;
}
