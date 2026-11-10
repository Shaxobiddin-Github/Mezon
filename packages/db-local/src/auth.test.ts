import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { UuidV7 } from '@mezon/domain';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSqliteHubAuthStore,
  listAllOutboxRecordsSync,
  localDeviceAuthState,
  localHubConfig,
  localPinCredentials,
  localSessions,
  migrateLocalDatabase,
  openLocalSqliteDatabase,
} from './index.js';

const tempDirs: string[] = [];

function makeDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-db-auth-'));
  tempDirs.push(dir);
  return path.join(dir, name);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('@mezon/db-local - SqliteHubAuthStore, partial username uniqueness, persistence & UoW serialization', () => {
  it('enforces single atomic setup under concurrency, outboxes users ATTR only, and blocks physical DELETE on users', async () => {
    const dbPath = makeDbPath('setup.db');
    const conn = openLocalSqliteDatabase(dbPath);
    const clock = new FixedClock(1_700_000_000_000n);
    const random = new SeededRandomSource(101);

    try {
      migrateLocalDatabase(conn.db);
      const store = await createSqliteHubAuthStore({ connection: conn, clock, random });
      expect(await store.getHealthStatus()).toEqual({ needsSetup: true });

      const settled = await Promise.allSettled([
        store.completeSetup({
          fullName: 'Owner One',
          username: 'owner1',
          pinHash: '$argon2id$v=19$m=19456,t=2,p=1$stub1$stubhash1',
        }),
        store.completeSetup({
          fullName: 'Owner Two',
          username: 'owner2',
          pinHash: '$argon2id$v=19$m=19456,t=2,p=1$stub2$stubhash2',
        }),
      ]);

      const fulfilled = settled.filter((s) => s.status === 'fulfilled');
      const rejected = settled.filter((s) => s.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(await store.getHealthStatus()).toEqual({ needsSetup: false });

      expect(conn.db.select().from(localHubConfig).all()).toHaveLength(1);
      const outbox = listAllOutboxRecordsSync(conn.db);
      expect(outbox).toHaveLength(1);
      expect(outbox[0].entity).toBe('users');
      expect(outbox[0].class).toBe('ATTR');
      expect(outbox[0].deviceSeq).toBe(1n);
      // Verify pin hash NEVER leaked into outbox payload
      expect(outbox[0].payload).not.toContain('stubhash');
      expect(outbox[0].payload).not.toContain('pinHash');

      // Raw DELETE on synced ATTR users table is blocked by SQLite trigger
      expect(() => conn.sqlite.exec('DELETE FROM users')).toThrow(/forbids physical DELETE/);
    } finally {
      conn.close();
    }
  });

  it('allows reusing a tombstoned username via partial unique index WHERE deleted_at_ms IS NULL (T5)', async () => {
    const dbPath = makeDbPath('tombstone-reuse.db');
    const conn = openLocalSqliteDatabase(dbPath);
    const clock = new FixedClock(1_700_000_100_000n);

    try {
      migrateLocalDatabase(conn.db);
      const store = await createSqliteHubAuthStore({
        connection: conn,
        clock,
        random: new SeededRandomSource(102),
      });
      await store.completeSetup({
        fullName: 'Ega',
        username: 'owner',
        pinHash: '$argon2id$v=19$m=19456,t=2,p=1$s$h0',
      });

      const cashier1 = await store.createUser({
        fullName: 'Kassir Bir',
        username: 'kassir1',
        role: 'cashier',
        pinHash: '$argon2id$v=19$m=19456,t=2,p=1$s$h1',
      });

      // Duplicate active username rejects
      await expect(
        store.createUser({
          fullName: 'Kassir Ikki',
          username: 'kassir1',
          role: 'cashier',
          pinHash: '$argon2id$v=19$m=19456,t=2,p=1$s$h2',
        }),
      ).rejects.toThrow(/USERNAME_ALREADY_EXISTS/);

      // Tombstone cashier1 -> now 'kassir1' can be reused cleanly!
      clock.advance(50n);
      await store.tombstoneUser(cashier1.id);

      clock.advance(50n);
      const cashier2 = await store.createUser({
        fullName: 'Yangi Kassir',
        username: 'kassir1',
        role: 'cashier',
        pinHash: '$argon2id$v=19$m=19456,t=2,p=1$s$h3',
      });
      expect(cashier2.id).not.toBe(cashier1.id);
      expect(cashier2.username).toBe('kassir1');
      expect(await store.listUsers()).toHaveLength(2);
      expect(await store.listLoginOptions()).toHaveLength(2);
    } finally {
      conn.close();
    }
  });

  it('persists committed failure counters & lockouts across hub restarts and throttles last_seen_at_ms to >= 60s', async () => {
    const dbPath = makeDbPath('restart-throttle.db');
    const clock = new FixedClock(1_700_000_200_000n);
    let ownerId!: UuidV7;
    const tokenHash = 'a'.repeat(64);

    {
      const conn = openLocalSqliteDatabase(dbPath);
      try {
        migrateLocalDatabase(conn.db);
        const store = await createSqliteHubAuthStore({
          connection: conn,
          clock,
          random: new SeededRandomSource(103),
        });
        const setupRes = await store.completeSetup({
          fullName: 'Restart Owner',
          username: 'owner',
          pinHash: 'hash-owner',
        });
        ownerId = setupRes.owner.id;

        // Mint valid session + check last_seen_at_ms throttling
        const okRes = await store.commitLoginOutcome({
          selector: { kind: 'userId', userId: ownerId },
          verifiedPinForUserId: ownerId,
          tokenHashToMint: tokenHash,
        });
        expect(okRes.kind).toBe('authenticated');

        clock.advance(30_000n); // < 60s: should NOT update last_seen_at_ms
        expect(await store.authenticateSession(tokenHash)).not.toBeNull();
        const sessionBefore = conn.db
          .select()
          .from(localSessions)
          .where(eq(localSessions.tokenHash, tokenHash))
          .all()[0];
        expect(sessionBefore.lastSeenAtMs).toBe(1_700_000_200_000n);

        clock.advance(30_000n); // >= 60s: updates last_seen_at_ms
        expect(await store.authenticateSession(tokenHash)).not.toBeNull();
        const sessionAfter = conn.db
          .select()
          .from(localSessions)
          .where(eq(localSessions.tokenHash, tokenHash))
          .all()[0];
        expect(sessionAfter.lastSeenAtMs).toBe(1_700_000_260_000n);

        // 5 failed attempts commit to SQLite even though login rejects afterwards
        for (let i = 0; i < 5; i++) {
          clock.advance(10n);
          const failRes = await store.commitLoginOutcome({
            selector: { kind: 'username', username: 'owner' },
            verifiedPinForUserId: null,
            tokenHashToMint: 'unused',
          });
          expect(failRes).toEqual({ kind: 'invalid_credentials' });
        }

        const rawCred = conn.sqlite
          .prepare<
            [],
            { readonly failed_attempts: number | bigint; readonly locked_until_ms: bigint }
          >('SELECT failed_attempts, locked_until_ms FROM local_pin_credentials')
          .get();
        expect(Number(rawCred?.failed_attempts)).toBe(5);
        expect(rawCred?.locked_until_ms).toBe(1_700_000_260_050n + 300_000n);
      } finally {
        conn.close();
      }
    }

    // Reopen fresh DB connection + store -> lockout & device failure state persist cleanly!
    {
      const conn2 = openLocalSqliteDatabase(dbPath);
      try {
        const store2 = await createSqliteHubAuthStore({
          connection: conn2,
          clock,
          random: new SeededRandomSource(104),
        });
        const snap = await store2.prepareLoginSnapshot({ kind: 'userId', userId: ownerId });
        expect(snap.kind).toBe('rate_limited');
        expect(snap.retryAfterSeconds).toBe(300n);
        expect(conn2.db.select().from(localDeviceAuthState).all()[0]?.failedAttempts).toBe(5);

        // Unlock clears failed_attempts & locked_until_ms cleanly
        await store2.unlockUser(ownerId);
        const rawAfterUnlock = conn2.db
          .select()
          .from(localPinCredentials)
          .where(eq(localPinCredentials.userId, ownerId))
          .all()[0];
        expect(rawAfterUnlock.failedAttempts).toBe(0);
        expect(rawAfterUnlock.lockedUntilMs).toBeNull();
      } finally {
        conn2.close();
      }
    }
  });

  it('protects last active owner against disable/demote/tombstone until another owner exists', async () => {
    const dbPath = makeDbPath('last-owner.db');
    const conn = openLocalSqliteDatabase(dbPath);
    const clock = new FixedClock(1_700_000_300_000n);

    try {
      migrateLocalDatabase(conn.db);
      const store = await createSqliteHubAuthStore({
        connection: conn,
        clock,
        random: new SeededRandomSource(105),
      });
      const { owner } = await store.completeSetup({
        fullName: 'Sole Owner',
        username: 'owner1',
        pinHash: 'hash1',
      });

      await expect(store.updateUser({ userId: owner.id, isActive: false })).rejects.toThrow(
        /LAST_OWNER_PROTECTED/,
      );
      await expect(store.updateUser({ userId: owner.id, role: 'manager' })).rejects.toThrow(
        /LAST_OWNER_PROTECTED/,
      );
      await expect(store.tombstoneUser(owner.id)).rejects.toThrow(/LAST_OWNER_PROTECTED/);

      await store.createUser({
        fullName: 'Second Owner',
        username: 'owner2',
        role: 'owner',
        pinHash: 'hash2',
      });
      const updated = await store.updateUser({ userId: owner.id, role: 'manager' });
      expect(updated.role).toBe('manager');
    } finally {
      conn.close();
    }
  });
});
