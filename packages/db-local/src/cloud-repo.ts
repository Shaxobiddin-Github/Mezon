import { type IdGenerator, type UnixMs, type UuidV7, parseUuidV7 } from '@mezon/domain';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { LocalSqliteConnection } from './connection.js';
import { localCloudState } from './schema/index.js';
import { type SqliteUnitOfWork, runConnectionReadOnly } from './uow.js';

export interface StoredCloudState {
  readonly status: 'unpaired' | 'paired' | 'revoked';
  readonly cloudUrl: string | null;
  readonly organizationId: UuidV7 | null;
  readonly organizationName: string | null;
  readonly storeId: UuidV7 | null;
  readonly storeName: string | null;
  readonly encryptedDeviceToken: string | null;
  readonly pairedAtMs: UnixMs | null;
  readonly lastSyncAtMs: UnixMs | null;
}

export interface SaveCloudStateParams {
  readonly status: 'unpaired' | 'paired' | 'revoked';
  readonly cloudUrl: string;
  readonly organizationId: UuidV7;
  readonly organizationName: string;
  readonly storeId: UuidV7;
  readonly storeName: string;
  readonly encryptedDeviceToken: string;
  readonly pairedAtMs: UnixMs;
  readonly nowMs: UnixMs;
  readonly idGen: IdGenerator;
}

export class SqliteCloudStore {
  constructor(
    private readonly connection: LocalSqliteConnection,
    private readonly getUow?: () => SqliteUnitOfWork | null,
  ) {}

  async getCloudState(): Promise<StoredCloudState | null> {
    return runConnectionReadOnly(this.connection, () => {
      const rows = this.connection.db
        .select()
        .from(localCloudState)
        .where(eq(localCloudState.singletonGuard, 1))
        .all();

      const row = rows[0];
      if (!row) {
        return null;
      }

      return {
        status: row.status as 'unpaired' | 'paired' | 'revoked',
        cloudUrl: row.cloudUrl,
        organizationId: row.cloudOrganizationId ? parseUuidV7(row.cloudOrganizationId) : null,
        organizationName: row.cloudOrganizationName,
        storeId: row.cloudStoreId ? parseUuidV7(row.cloudStoreId) : null,
        storeName: row.cloudStoreName,
        encryptedDeviceToken: row.encryptedDeviceToken,
        pairedAtMs: row.pairedAtMs,
        lastSyncAtMs: row.lastSyncAtMs,
      };
    });
  }

  async saveCloudState(params: SaveCloudStateParams): Promise<void> {
    const uow = this.getUow?.();
    if (uow) {
      await uow.execute((session) => {
        this.writeCloudStateSync(session.db, params);
        return Promise.resolve();
      });
    } else {
      const txn = this.connection.sqlite.transaction(() => {
        this.writeCloudStateSync(this.connection.db, params);
      });
      txn();
    }
  }

  async clearCloudState(nowMs: UnixMs): Promise<void> {
    const uow = this.getUow?.();
    if (uow) {
      await uow.execute((session) => {
        this.clearCloudStateSync(session.db, nowMs);
        return Promise.resolve();
      });
    } else {
      const txn = this.connection.sqlite.transaction(() => {
        this.clearCloudStateSync(this.connection.db, nowMs);
      });
      txn();
    }
  }

  private writeCloudStateSync(
    db: BetterSQLite3Database<Record<string, unknown>>,
    params: SaveCloudStateParams,
  ): void {
    const existing = db
      .select()
      .from(localCloudState)
      .where(eq(localCloudState.singletonGuard, 1))
      .all();

    if (existing.length > 0) {
      db.update(localCloudState)
        .set({
          status: params.status,
          cloudUrl: params.cloudUrl,
          cloudOrganizationId: params.organizationId,
          cloudOrganizationName: params.organizationName,
          cloudStoreId: params.storeId,
          cloudStoreName: params.storeName,
          encryptedDeviceToken: params.encryptedDeviceToken,
          pairedAtMs: params.pairedAtMs,
          updatedAtMs: params.nowMs,
        })
        .where(eq(localCloudState.singletonGuard, 1))
        .run();
    } else {
      db.insert(localCloudState)
        .values({
          id: params.idGen.nextId(),
          singletonGuard: 1,
          status: params.status,
          cloudUrl: params.cloudUrl,
          cloudOrganizationId: params.organizationId,
          cloudOrganizationName: params.organizationName,
          cloudStoreId: params.storeId,
          cloudStoreName: params.storeName,
          encryptedDeviceToken: params.encryptedDeviceToken,
          pairedAtMs: params.pairedAtMs,
          lastSyncAtMs: null,
          createdAtMs: params.nowMs,
          updatedAtMs: params.nowMs,
        })
        .run();
    }
  }

  private clearCloudStateSync(
    db: BetterSQLite3Database<Record<string, unknown>>,
    nowMs: UnixMs,
  ): void {
    db.update(localCloudState)
      .set({
        status: 'unpaired',
        cloudUrl: null,
        cloudOrganizationId: null,
        cloudOrganizationName: null,
        cloudStoreId: null,
        cloudStoreName: null,
        encryptedDeviceToken: null,
        pairedAtMs: null,
        lastSyncAtMs: null,
        updatedAtMs: nowMs,
      })
      .where(eq(localCloudState.singletonGuard, 1))
      .run();
  }
}

export function createSqliteCloudStore(
  connection: LocalSqliteConnection,
  getUow?: () => SqliteUnitOfWork | null,
): SqliteCloudStore {
  return new SqliteCloudStore(connection, getUow);
}
