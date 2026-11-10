import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { bigint, doublePrecision, numeric, pgTable, real, text, uuid } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { provisionAppRole } from '../ops/provision-app-role.mjs';
import {
  DB_CLOUD_PACKAGE,
  PG_APP_ROLE_NAME,
  PgSchemaRegistry,
  PgSchemaValidationError,
  type PgValueParser,
  assertRlsMigrationsComplete,
  buildTenantRlsSql,
  cloudSchemaRegistry,
  createCloudPgTypesConfig,
  getDefaultCloudMigrationsFolder,
  getGlobalPgTypeParser,
  pgBigint,
  pgBoolean,
  pgInt,
  pgMoney,
  pgQuantity,
  pgUnixMs,
  validatePgSchemaRegistry,
} from './index.js';

interface DrizzlePgKitApi {
  readonly generateDrizzleJson: (imports: Record<string, unknown>) => Record<string, unknown>;
  readonly generateMigration: (
    prev: Record<string, unknown>,
    cur: Record<string, unknown>,
  ) => Promise<string[]>;
}

const require = createRequire(import.meta.url);
const { generateDrizzleJson, generateMigration } = require('drizzle-kit/api') as DrizzlePgKitApi;

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-db-cloud-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('@mezon/db-cloud - PostgreSQL schema registry, RLS templates, and bigint rules', () => {
  it('exports package marker and keeps production schema empty in T0.4', () => {
    expect(DB_CLOUD_PACKAGE).toBe('@mezon/db-cloud');
    expect(cloudSchemaRegistry.all()).toEqual([]);
    expect(fs.existsSync(getDefaultCloudMigrationsFolder())).toBe(true);
  });

  it('registers all four classes cleanly and generates valid HLC check + RLS policy DDL', async () => {
    const registry = new PgSchemaRegistry();

    const factTable = registry.defineTable(
      { name: 'pg_fact', tableClass: 'FACT', tenantScope: 'store' },
      (c) => ({
        ...c,
        totalTiyin: pgMoney('total_tiyin').notNull(),
        qtyMilli: pgQuantity('qty_milli').notNull(),
      }),
    );

    const attrTable = registry.defineTable(
      { name: 'pg_attr', tableClass: 'ATTR', tenantScope: 'organization' },
      (c) => ({
        ...c,
        name: text('name').notNull(),
        active: pgBoolean('active').notNull(),
      }),
    );

    const monotoneTable = registry.defineTable(
      {
        name: 'pg_monotone',
        tableClass: 'MONOTONE',
        tenantScope: 'store',
        monotoneColumns: ['voided_at_ms'],
      },
      (c) => ({
        ...c,
        voidedAtMs: pgUnixMs('voided_at_ms'),
      }),
    );

    const localNone = registry.defineTable(
      { name: 'pg_local_none', tableClass: 'LOCAL', tenantScope: 'none' },
      (c) => ({
        ...c,
        version: pgInt('version').notNull(),
      }),
    );

    expect(() =>
      validatePgSchemaRegistry({ factTable, attrTable, monotoneTable, localNone }, registry),
    ).not.toThrow();

    const rlsSql = buildTenantRlsSql('pg_fact').join('\n');
    expect(rlsSql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(rlsSql).toContain('FORCE ROW LEVEL SECURITY');
    expect(rlsSql).toContain(`CREATE POLICY "pg_fact_tenant_isolation" ON "pg_fact"`);
    expect(rlsSql).toContain(`TO "${PG_APP_ROLE_NAME}"`);
    expect(rlsSql).toContain('USING ("organization_id" = mezon_current_organization_id())');
    expect(rlsSql).toContain('WITH CHECK ("organization_id" = mezon_current_organization_id())');
    expect(rlsSql).toContain(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "pg_fact" TO "${PG_APP_ROLE_NAME}"`,
    );

    const emptySnap = generateDrizzleJson({});
    const currSnap = generateDrizzleJson({ pg_fact: factTable });
    const stmts = await generateMigration(emptySnap, currSnap);
    const ddl = stmts.join('\n');
    expect(ddl).toContain('CONSTRAINT "chk_pg_fact_hlc_len" CHECK (length("pg_fact"."hlc") = 58)');
    expect(ddl).toContain('CREATE POLICY "pg_fact_tenant_isolation"');
    expect(ddl).toContain('ENABLE ROW LEVEL SECURITY');
  });

  it('rejects unregistered tables, bigint({ mode: "number" }), float/numeric columns, and missing org_id', () => {
    const validReg = new PgSchemaRegistry();
    const ok = validReg.defineTable(
      { name: 'ok_pg', tableClass: 'FACT', tenantScope: 'organization' },
      (c) => ({ ...c }),
    );

    // 1. Unregistered raw pgTable
    const rogue = pgTable('rogue_pg', { id: uuid('id').primaryKey() });
    expect(() => validatePgSchemaRegistry({ ok, rogue }, validReg)).toThrowError(
      PgSchemaValidationError,
    );

    // 2. Synced table with tenantScope 'none'
    for (const cls of ['FACT', 'ATTR', 'MONOTONE'] as const) {
      expect(() =>
        validReg.defineTable({ name: `bad_${cls}`, tableClass: cls, tenantScope: 'none' }, (c) => ({
          ...c,
        })),
      ).toThrowError(PgSchemaValidationError);
    }

    // 3. bigint({ mode: 'number' }) FORBIDDEN
    const numBigintReg = new PgSchemaRegistry();
    const withNumberBigint = numBigintReg.defineTable(
      { name: 'bad_bigint53', tableClass: 'FACT', tenantScope: 'store' },
      (c) => ({
        ...c,
        amount: bigint('amount', { mode: 'number' }).notNull(),
      }),
    );
    expect(() => validatePgSchemaRegistry({ withNumberBigint }, numBigintReg)).toThrowError(
      /mode: 'number'/i,
    );

    // 4. real / doublePrecision / numeric FORBIDDEN
    for (const [label, colBuilder] of [
      ['real', () => real('amt').notNull()],
      ['double', () => doublePrecision('amt').notNull()],
      ['numeric', () => numeric('amt').notNull()],
    ] as const) {
      const reg = new PgSchemaRegistry();
      const badTbl = reg.defineTable(
        { name: `bad_${label}`, tableClass: 'FACT', tenantScope: 'store' },
        (c) => ({ ...c, amt: colBuilder() }),
      );
      expect(() => validatePgSchemaRegistry({ badTbl }, reg)).toThrowError(
        /forbidden floating\/numeric/i,
      );
    }

    // 5. Raw table stripped of organization_id bypassed into fake registry
    const sneaky = pgTable('sneaky_pg', {
      id: uuid('id').primaryKey(),
      deviceId: uuid('device_id').notNull(),
      hlc: text('hlc').notNull(),
      createdAtMs: pgBigint('created_at_ms').notNull(),
    });
    const fakeReg = {
      get: (n: string) =>
        n === 'sneaky_pg'
          ? {
              tableName: 'sneaky_pg',
              tableClass: 'FACT' as const,
              tenantScope: 'organization' as const,
              rlsEnabled: true,
              monotoneColumns: [],
              table: sneaky,
            }
          : undefined,
    } as unknown as PgSchemaRegistry;
    expect(() => validatePgSchemaRegistry({ sneaky }, fakeReg)).toThrowError(
      /missing required column "organization_id"/i,
    );
  });

  it('assertRlsMigrationsComplete rejects migrations missing FORCE RLS, WITH CHECK, or GRANT', () => {
    const reg = new PgSchemaRegistry();
    reg.defineTable({ name: 'orders_pg', tableClass: 'FACT', tenantScope: 'store' }, (c) => ({
      ...c,
    }));

    const tmpDir = makeTempDir();
    // Missing FORCE ROW LEVEL SECURITY
    fs.writeFileSync(
      path.join(tmpDir, '0001.sql'),
      `
      ALTER TABLE "orders_pg" ENABLE ROW LEVEL SECURITY;
      CREATE POLICY "orders_pg_tenant_isolation" ON "orders_pg" FOR ALL TO mezon_app
        USING (organization_id = mezon_current_organization_id())
        WITH CHECK (organization_id = mezon_current_organization_id());
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "orders_pg" TO mezon_app;
      `,
    );
    expect(() => assertRlsMigrationsComplete(tmpDir, reg.all())).toThrowError(
      /missing complete RLS/,
    );

    // Complete explicit RLS SQL passes
    fs.writeFileSync(path.join(tmpDir, '0002.sql'), buildTenantRlsSql('orders_pg').join('\n'));
    expect(() => assertRlsMigrationsComplete(tmpDir, reg.all())).not.toThrow();

    // Helper call SQL also passes
    const helperDir = makeTempDir();
    fs.writeFileSync(
      path.join(helperDir, '0001.sql'),
      "SELECT mezon_apply_tenant_rls('public.orders_pg');\n",
    );
    expect(() => assertRlsMigrationsComplete(helperDir, reg.all())).not.toThrow();
  });

  it('decodes int8 to bigint per pool without mutating global pg.types.setTypeParser', () => {
    const typesCfg = createCloudPgTypesConfig();
    const int8Parser = typesCfg.getTypeParser(20, 'text') as PgValueParser;
    expect(int8Parser('9007199254740993')).toBe(9_007_199_254_740_993n);

    // Global pg.types MUST remain untouched (default returns string)
    const globalInt8Parser = getGlobalPgTypeParser(20, 'text');
    expect(globalInt8Parser('9007199254740993')).toBe('9007199254740993');
    expect(typeof globalInt8Parser('9007199254740993')).toBe('string');
  });

  it('provisionAppRole fails clearly when password environment variable is missing', async () => {
    const prev = process.env.TEST_MISSING_PWD_VAR;
    delete process.env.TEST_MISSING_PWD_VAR;
    await expect(
      provisionAppRole({
        pool: {} as pg.Pool,
        passwordEnvVar: 'TEST_MISSING_PWD_VAR',
      }),
    ).rejects.toThrowError(/Missing required environment variable "TEST_MISSING_PWD_VAR"/);
    if (prev !== undefined) {
      process.env.TEST_MISSING_PWD_VAR = prev;
    }
  });
});
