import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MonotonicUuidV7Generator, parseUuidV7, unixMsFromBigInt } from '@mezon/domain';
import { SeededRandomSource } from '@mezon/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type LocalSqliteConnection,
  AUDIT_GENESIS_HASH,
  appendAuditInTxSync,
  canonicalAuditDetails,
  migrateLocalDatabase,
  openLocalSqliteDatabase,
  verifyAuditChainSync,
} from './index.js';

const ORG = parseUuidV7('01997000-0000-7000-8000-000000000001');
const USER = parseUuidV7('01997000-0000-7000-8000-000000000002');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function setup(n = 5): LocalSqliteConnection {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-audit-'));
  dirs.push(dir);
  const conn = openLocalSqliteDatabase(path.join(dir, 'a.db'));
  migrateLocalDatabase(conn.db);
  const gen = new MonotonicUuidV7Generator({
    clock: { now: () => unixMsFromBigInt(1_769_000_000_000n) },
    random: new SeededRandomSource(3),
  });
  conn.sqlite.transaction(() => {
    for (let i = 0; i < n; i += 1) {
      appendAuditInTxSync(conn.sqlite, {
        organizationId: ORG,
        eventType: i % 2 === 0 ? 'sale.voided' : 'price.changed',
        actorUserId: USER,
        entity: 'sales',
        entityId: `e-${i}`,
        details: { amount: String(1000 * (i + 1)), reason: `r${i}` },
        nowMs: unixMsFromBigInt(1_769_000_000_000n + BigInt(i)),
        nextId: () => gen.nextId(),
      });
    }
  })();
  return conn;
}

const withoutGuards = (conn: LocalSqliteConnection, sql: string, ...args: unknown[]) => {
  conn.sqlite.exec(
    'DROP TRIGGER "trg_local_audit_log_no_update"; DROP TRIGGER "trg_local_audit_log_no_delete";',
  );
  conn.sqlite.prepare(sql).run(...args);
};

describe('T3.8 audit hash chain', () => {
  it('an untouched chain verifies; seq is contiguous from 1 and starts at the genesis hash', () => {
    const conn = setup(6);
    try {
      const r = verifyAuditChainSync(conn.sqlite, ORG);
      expect(r).toMatchObject({ ok: true, checked: 6, firstBrokenSeq: null });
      const first = conn.sqlite
        .prepare('SELECT seq, prev_hash FROM local_audit_log ORDER BY seq LIMIT 1')
        .get() as { seq: bigint; prev_hash: string };
      expect([BigInt(first.seq), first.prev_hash]).toEqual([1n, AUDIT_GENESIS_HASH]);
    } finally {
      conn.close();
    }
  });

  it('UPDATE and DELETE are refused by the database', () => {
    const conn = setup(2);
    try {
      expect(() =>
        conn.sqlite.exec("UPDATE local_audit_log SET details_json = '[]' WHERE seq = 1"),
      ).toThrow(/append-only/);
      expect(() => conn.sqlite.exec('DELETE FROM local_audit_log WHERE seq = 2')).toThrow(
        /append-only/,
      );
    } finally {
      conn.close();
    }
  });

  it.each([
    [
      'details edited',
      'UPDATE local_audit_log SET details_json = \'[["amount","1"]]\' WHERE seq = 3',
      'hash_mismatch',
      '3',
    ],
    [
      'actor swapped',
      'UPDATE local_audit_log SET actor_user_id = NULL WHERE seq = 2',
      'hash_mismatch',
      '2',
    ],
    [
      'timestamp moved',
      'UPDATE local_audit_log SET created_at_ms = created_at_ms + 1 WHERE seq = 4',
      'hash_mismatch',
      '4',
    ],
    [
      'event type changed',
      "UPDATE local_audit_log SET event_type = 'auth.login' WHERE seq = 1",
      'hash_mismatch',
      '1',
    ],
    ['row deleted', 'DELETE FROM local_audit_log WHERE seq = 3', 'seq_gap', '3'],
    [
      'prev hash forged',
      "UPDATE local_audit_log SET prev_hash = '" + 'a'.repeat(64) + "' WHERE seq = 5",
      'prev_hash_mismatch',
      '5',
    ],
  ])('tamper detected: %s', (_label, sql, reason, seq) => {
    const conn = setup(6);
    try {
      withoutGuards(conn, sql);
      expect(verifyAuditChainSync(conn.sqlite, ORG)).toMatchObject({
        ok: false,
        reason,
        firstBrokenSeq: seq,
      });
    } finally {
      conn.close();
    }
  });

  it('a row re-hashed in place still breaks the NEXT link (partial rewrite is caught)', () => {
    const conn = setup(4);
    try {
      withoutGuards(
        conn,
        "UPDATE local_audit_log SET hash = '" + 'b'.repeat(64) + "' WHERE seq = 2",
      );
      expect(verifyAuditChainSync(conn.sqlite, ORG)).toMatchObject({
        ok: false,
        firstBrokenSeq: '2',
      });
    } finally {
      conn.close();
    }
  });

  it('written inside the operation transaction: a rollback leaves no audit row', () => {
    const conn = setup(1);
    try {
      expect(() =>
        conn.sqlite.transaction(() => {
          appendAuditInTxSync(conn.sqlite, {
            organizationId: ORG,
            eventType: 'sale.voided',
            actorUserId: USER,
            entity: 'sales',
            entityId: 'x',
            details: {},
            nowMs: unixMsFromBigInt(1_769_000_000_100n),
            nextId: () => parseUuidV7('01997000-0000-7000-8000-0000000000ff'),
          });
          throw new Error('operation failed');
        })(),
      ).toThrow('operation failed');
      expect(verifyAuditChainSync(conn.sqlite, ORG)).toMatchObject({ ok: true, checked: 1 });
    } finally {
      conn.close();
    }
  });

  it('canonical details do not depend on key order', () => {
    expect(canonicalAuditDetails({ b: '2', a: '1' })).toBe(
      canonicalAuditDetails({ a: '1', b: '2' }),
    );
  });
});
