import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PinHasher, UuidV7 } from '@mezon/domain';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_VAT_SETTINGS,
  createSqliteHubAuthStore,
  createSqliteTaxSettingsStore,
  effectiveVatRateBp,
  migrateLocalDatabase,
  openLocalSqliteDatabase,
  readEffectiveVatSettingsSync,
} from './index.js';

const FAST_TEST_HASHER: PinHasher = {
  hash: (pin) => Promise.resolve(`$stub$${pin}`),
  verify: (hash, pin) => Promise.resolve(hash === `$stub$${pin}`),
};

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-tax-'));
  tempDirs.push(dir);
  return path.join(dir, 'tax.db');
}

async function setup(seed = 3131) {
  const conn = openLocalSqliteDatabase(tempDb());
  migrateLocalDatabase(conn.db);
  const auth = await createSqliteHubAuthStore({
    connection: conn,
    clock: new FixedClock(1_762_950_000_000n),
    random: new SeededRandomSource(seed),
  });
  const res = await auth.completeSetup({
    fullName: 'Egasi',
    username: 'owner',
    pinHash: await FAST_TEST_HASHER.hash('849201'),
  });
  const store = createSqliteTaxSettingsStore({
    connection: conn,
    getRuntimeContext: () => {
      const c = auth.getActiveRuntimeContext();
      return c ? { uow: c.uow, organizationId: c.config.organizationId } : null;
    },
  });
  const orgId = auth.getActiveRuntimeContext()!.config.organizationId;
  return { conn, store, ownerId: res.owner.id, orgId };
}

const VALID = {
  tin: '305123456',
  legalName: 'Guzar MChJ',
  legalAddress: 'Kattaqoʻrgʻon',
  isVatPayer: true,
  defaultVatRateBp: 1200,
};

describe('@mezon/db-local - T3.1 organization_tax_profiles', () => {
  it('upsert uses id = organization_id and records updated_by_user_id', async () => {
    const env = await setup();
    try {
      const p = await env.store.upsertProfile(VALID, env.ownerId);
      expect(p.id).toBe(env.orgId);
      expect(p.updatedByUserId).toBe(env.ownerId);
      const p2 = await env.store.upsertProfile({ ...VALID, isVatPayer: false }, env.ownerId);
      expect(p2.id).toBe(env.orgId);
      expect(p2.isVatPayer).toBe(false);
      expect((await env.store.getEffectiveVatSettings()).isVatPayer).toBe(false);
    } finally {
      env.conn.close();
    }
  });

  it('DB CHECKs reject id ≠ organization_id, malformed STIR, out-of-range VAT; physical DELETE is blocked', async () => {
    const env = await setup();
    try {
      await env.store.upsertProfile(VALID, env.ownerId);
      const row = env.conn.sqlite
        .prepare('SELECT * FROM organization_tax_profiles')
        .get() as Record<string, unknown>;

      const insert = (over: Record<string, unknown>) => {
        const r = { ...row, ...over };
        const cols = Object.keys(r);
        env.conn.sqlite
          .prepare(
            `INSERT INTO organization_tax_profiles (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
          )
          .run(...cols.map((c) => r[c]));
      };
      // Second row for the same org with a different id → CHECK id = organization_id
      expect(() => insert({ id: '01950000-0000-7000-8000-00000000abcd' })).toThrow(
        /chk_org_tax_profiles_id_is_org|CHECK/,
      );

      const update = (col: string, val: unknown) =>
        env.conn.sqlite
          .prepare(`UPDATE organization_tax_profiles SET ${col} = ? WHERE id = ?`)
          .run(val, env.orgId);
      for (const bad of ['12345678', '1234567890', '12345678a', '1234 5678', '']) {
        expect(() => update('tin', bad), bad).toThrow(/chk_org_tax_profiles_tin|CHECK/);
      }
      expect(() => update('default_vat_rate_bp', 10_001)).toThrow(/CHECK/);
      expect(() => update('is_vat_payer', 2)).toThrow(/CHECK/);
      expect(() => env.conn.sqlite.prepare('DELETE FROM organization_tax_profiles').run()).toThrow(
        /forbids physical DELETE/,
      );
    } finally {
      env.conn.close();
    }
  });

  it('a failed write rolls back the profile AND its outbox event; the next write succeeds', async () => {
    const env = await setup();
    try {
      const outboxCount = () =>
        (
          env.conn.sqlite
            .prepare(
              `SELECT COUNT(*) AS n FROM local_outbox WHERE entity = 'organization_tax_profiles'`,
            )
            .get() as { n: bigint }
        ).n;
      // Unknown actor violates the users FK inside the transaction.
      await expect(
        env.store.upsertProfile(VALID, '01950000-0000-7000-8000-0000000fffff' as UuidV7),
      ).rejects.toThrow();
      expect(await env.store.getProfile()).toBeNull();
      expect(outboxCount()).toBe(0n);

      await expect(env.store.upsertProfile({ ...VALID, tin: '1234' }, env.ownerId)).rejects.toThrow(
        /INVALID_TIN/,
      );
      expect(outboxCount()).toBe(0n);

      await env.store.upsertProfile(VALID, env.ownerId);
      expect(outboxCount()).toBe(1n);
    } finally {
      env.conn.close();
    }
  });

  it('effective VAT settings: default (payer) without profile; pre-T3.1 schema falls back to the pre-T3.1 behaviour', async () => {
    const env = await setup();
    try {
      expect(readEffectiveVatSettingsSync(env.conn.db, env.orgId)).toEqual(DEFAULT_VAT_SETTINGS);
      await env.store.upsertProfile(
        { ...VALID, isVatPayer: false, defaultVatRateBp: 0 },
        env.ownerId,
      );
      expect(readEffectiveVatSettingsSync(env.conn.db, env.orgId)).toEqual({
        isVatPayer: false,
        defaultVatRateBp: 0,
      });
    } finally {
      env.conn.close();
    }

    // A database without the T3.1 table (older schema) keeps snapshotting product rates as before.
    const legacy = openLocalSqliteDatabase(tempDb());
    try {
      expect(
        readEffectiveVatSettingsSync(legacy.db, '01950000-0000-7000-8000-000000000001' as UuidV7),
      ).toEqual(DEFAULT_VAT_SETTINGS);
    } finally {
      legacy.close();
    }
  });

  it('effectiveVatRateBp: payer keeps rate, non-payer 0, out-of-range rejected', () => {
    expect(effectiveVatRateBp(1200, true)).toBe(1200);
    expect(effectiveVatRateBp(1200, false)).toBe(0);
    expect(effectiveVatRateBp(0, true)).toBe(0);
    expect(() => effectiveVatRateBp(10_001, true)).toThrow();
  });
});
