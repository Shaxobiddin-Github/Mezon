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
  type SyncedTableClass,
  assertRlsMigrationsComplete,
  buildTenantRlsSql,
  cloudSchemaRegistry,
  createCloudPgTypesConfig,
  getDefaultCloudMigrationsFolder,
  getGlobalPgTypeParser,
  getTenantPrivilegesForClass,
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
  it('exports package marker and registers T2.1 foundation schema tables', () => {
    expect(DB_CLOUD_PACKAGE).toBe('@mezon/db-cloud');
    const tableNames = cloudSchemaRegistry.all().map((t) => t.tableName);
    expect(tableNames).toEqual([
      'cloud_organizations',
      'cloud_stores',
      'cloud_users',
      'cloud_refresh_tokens',
      'cloud_login_identities',
    ]);
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

    const factRlsSql = buildTenantRlsSql('pg_fact', 'FACT').join('\n');
    expect(factRlsSql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(factRlsSql).toContain('FORCE ROW LEVEL SECURITY');
    expect(factRlsSql).toContain(`CREATE POLICY "pg_fact_tenant_isolation" ON "pg_fact"`);
    expect(factRlsSql).toContain(`TO "${PG_APP_ROLE_NAME}"`);
    expect(factRlsSql).toContain('USING ("organization_id" = mezon_current_organization_id())');
    expect(factRlsSql).toContain(
      'WITH CHECK ("organization_id" = mezon_current_organization_id())',
    );
    expect(factRlsSql).toContain(`REVOKE ALL ON TABLE "pg_fact" FROM "${PG_APP_ROLE_NAME}"`);
    expect(factRlsSql).toContain(
      `GRANT SELECT, INSERT ON TABLE "pg_fact" TO "${PG_APP_ROLE_NAME}"`,
    );
    expect(factRlsSql).not.toContain('UPDATE');
    expect(factRlsSql).not.toContain('DELETE');
    expect(factRlsSql.indexOf('REVOKE ALL')).toBeLessThan(
      factRlsSql.indexOf('GRANT SELECT, INSERT'),
    );

    const attrRlsSql = buildTenantRlsSql('pg_attr', 'ATTR').join('\n');
    expect(attrRlsSql).toContain(`REVOKE ALL ON TABLE "pg_attr" FROM "${PG_APP_ROLE_NAME}"`);
    expect(attrRlsSql).toContain(
      `GRANT SELECT, INSERT, UPDATE ON TABLE "pg_attr" TO "${PG_APP_ROLE_NAME}"`,
    );
    expect(attrRlsSql).not.toContain('DELETE');

    const monoRlsSql = buildTenantRlsSql('pg_monotone', 'MONOTONE').join('\n');
    expect(monoRlsSql).toContain(
      `GRANT SELECT, INSERT, UPDATE ON TABLE "pg_monotone" TO "${PG_APP_ROLE_NAME}"`,
    );
    expect(monoRlsSql).not.toContain('DELETE');

    expect(getTenantPrivilegesForClass('FACT')).toBe('SELECT, INSERT');
    expect(getTenantPrivilegesForClass('ATTR')).toBe('SELECT, INSERT, UPDATE');
    expect(getTenantPrivilegesForClass('MONOTONE')).toBe('SELECT, INSERT, UPDATE');
    expect(() =>
      buildTenantRlsSql('pg_local_none', 'LOCAL' as unknown as SyncedTableClass),
    ).toThrowError(RangeError);

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

  it('assertRlsMigrationsComplete validates RLS completeness and rejects excess privileges per class', () => {
    const reg = new PgSchemaRegistry();
    reg.defineTable({ name: 'fact_orders_pg', tableClass: 'FACT', tenantScope: 'store' }, (c) => ({
      ...c,
    }));
    reg.defineTable(
      { name: 'attr_customers_pg', tableClass: 'ATTR', tenantScope: 'organization' },
      (c) => ({
        ...c,
      }),
    );
    reg.defineTable(
      { name: 'mono_voids_pg', tableClass: 'MONOTONE', tenantScope: 'store' },
      (c) => ({
        ...c,
      }),
    );

    const allMeta = reg.all();
    const factMeta = [allMeta[0]];
    const attrMeta = [allMeta[1]];
    const monoMeta = [allMeta[2]];

    // 1. Missing FORCE ROW LEVEL SECURITY
    const missingForceDir = makeTempDir();
    fs.writeFileSync(
      path.join(missingForceDir, '0001.sql'),
      `
      ALTER TABLE "attr_customers_pg" ENABLE ROW LEVEL SECURITY;
      CREATE POLICY "attr_customers_pg_tenant_isolation" ON "attr_customers_pg" FOR ALL TO mezon_app
        USING (organization_id = mezon_current_organization_id())
        WITH CHECK (organization_id = mezon_current_organization_id());
      REVOKE ALL ON TABLE "attr_customers_pg" FROM mezon_app;
      GRANT SELECT, INSERT, UPDATE ON TABLE "attr_customers_pg" TO mezon_app;
      `,
    );
    expect(() => assertRlsMigrationsComplete(missingForceDir, attrMeta)).toThrowError(
      /missing complete RLS/,
    );

    // 2. FACT table with UPDATE grant must fail
    const factUpdateDir = makeTempDir();
    fs.writeFileSync(
      path.join(factUpdateDir, '0001.sql'),
      `
      ALTER TABLE "fact_orders_pg" ENABLE ROW LEVEL SECURITY;
      ALTER TABLE "fact_orders_pg" FORCE ROW LEVEL SECURITY;
      CREATE POLICY "fact_orders_pg_tenant_isolation" ON "fact_orders_pg" FOR ALL TO mezon_app
        USING (organization_id = mezon_current_organization_id())
        WITH CHECK (organization_id = mezon_current_organization_id());
      REVOKE ALL ON TABLE "fact_orders_pg" FROM mezon_app;
      GRANT SELECT, INSERT, UPDATE ON TABLE "fact_orders_pg" TO mezon_app;
      `,
    );
    expect(() => assertRlsMigrationsComplete(factUpdateDir, factMeta)).toThrowError(
      /Forbidden privilege "UPDATE" granted on immutable FACT table "fact_orders_pg"/,
    );

    // 3. FACT table with DELETE grant must fail
    const factDeleteDir = makeTempDir();
    fs.writeFileSync(
      path.join(factDeleteDir, '0001.sql'),
      `
      ALTER TABLE "fact_orders_pg" ENABLE ROW LEVEL SECURITY;
      ALTER TABLE "fact_orders_pg" FORCE ROW LEVEL SECURITY;
      CREATE POLICY "fact_orders_pg_tenant_isolation" ON "fact_orders_pg" FOR ALL TO mezon_app
        USING (organization_id = mezon_current_organization_id())
        WITH CHECK (organization_id = mezon_current_organization_id());
      REVOKE ALL ON TABLE "fact_orders_pg" FROM mezon_app;
      GRANT SELECT, INSERT, DELETE ON TABLE "fact_orders_pg" TO mezon_app;
      `,
    );
    expect(() => assertRlsMigrationsComplete(factDeleteDir, factMeta)).toThrowError(
      /Forbidden privilege "DELETE" granted on synced table "fact_orders_pg"/,
    );

    // 4. ATTR table with DELETE grant must fail
    const attrDeleteDir = makeTempDir();
    fs.writeFileSync(
      path.join(attrDeleteDir, '0001.sql'),
      `
      ALTER TABLE "attr_customers_pg" ENABLE ROW LEVEL SECURITY;
      ALTER TABLE "attr_customers_pg" FORCE ROW LEVEL SECURITY;
      CREATE POLICY "attr_customers_pg_tenant_isolation" ON "attr_customers_pg" FOR ALL TO mezon_app
        USING (organization_id = mezon_current_organization_id())
        WITH CHECK (organization_id = mezon_current_organization_id());
      REVOKE ALL ON TABLE "attr_customers_pg" FROM mezon_app;
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "attr_customers_pg" TO mezon_app;
      `,
    );
    expect(() => assertRlsMigrationsComplete(attrDeleteDir, attrMeta)).toThrowError(
      /Forbidden privilege "DELETE" granted on synced table "attr_customers_pg"/,
    );

    // 5. MONOTONE table with ALL grant must fail
    const monoAllDir = makeTempDir();
    fs.writeFileSync(
      path.join(monoAllDir, '0001.sql'),
      `
      ALTER TABLE "mono_voids_pg" ENABLE ROW LEVEL SECURITY;
      ALTER TABLE "mono_voids_pg" FORCE ROW LEVEL SECURITY;
      CREATE POLICY "mono_voids_pg_tenant_isolation" ON "mono_voids_pg" FOR ALL TO mezon_app
        USING (organization_id = mezon_current_organization_id())
        WITH CHECK (organization_id = mezon_current_organization_id());
      REVOKE ALL ON TABLE "mono_voids_pg" FROM mezon_app;
      GRANT ALL ON TABLE "mono_voids_pg" TO mezon_app;
      `,
    );
    expect(() => assertRlsMigrationsComplete(monoAllDir, monoMeta)).toThrowError(
      /Forbidden privilege "ALL" granted on synced table "mono_voids_pg"/,
    );

    // 6. Explicit GRANT without prior REVOKE ALL must fail
    const missingRevokeDir = makeTempDir();
    fs.writeFileSync(
      path.join(missingRevokeDir, '0001.sql'),
      `
      ALTER TABLE "fact_orders_pg" ENABLE ROW LEVEL SECURITY;
      ALTER TABLE "fact_orders_pg" FORCE ROW LEVEL SECURITY;
      CREATE POLICY "fact_orders_pg_tenant_isolation" ON "fact_orders_pg" FOR ALL TO mezon_app
        USING (organization_id = mezon_current_organization_id())
        WITH CHECK (organization_id = mezon_current_organization_id());
      GRANT SELECT, INSERT ON TABLE "fact_orders_pg" TO mezon_app;
      `,
    );
    expect(() => assertRlsMigrationsComplete(missingRevokeDir, factMeta)).toThrowError(
      /missing complete RLS or class-matched REVOKE ALL/,
    );

    // 7. Helper call missing mandatory table_class argument must fail
    const missingClassArgDir = makeTempDir();
    fs.writeFileSync(
      path.join(missingClassArgDir, '0001.sql'),
      "SELECT mezon_apply_tenant_rls('public.fact_orders_pg');\n",
    );
    expect(() => assertRlsMigrationsComplete(missingClassArgDir, factMeta)).toThrowError(
      /without required literal table_class argument/,
    );

    // 8. Helper call with mismatched class (ATTR on FACT) must fail
    const wrongHelperClassDir = makeTempDir();
    fs.writeFileSync(
      path.join(wrongHelperClassDir, '0001.sql'),
      "SELECT mezon_apply_tenant_rls('public.fact_orders_pg', 'ATTR');\n",
    );
    expect(() => assertRlsMigrationsComplete(wrongHelperClassDir, factMeta)).toThrowError(
      /registered as "FACT", but migration invokes mezon_apply_tenant_rls with class "ATTR"/,
    );

    // 9. Complete explicit SQL via buildTenantRlsSql passes for all three synced classes
    const explicitOkDir = makeTempDir();
    fs.writeFileSync(
      path.join(explicitOkDir, '0001.sql'),
      [
        ...buildTenantRlsSql('fact_orders_pg', 'FACT'),
        ...buildTenantRlsSql('attr_customers_pg', 'ATTR'),
        ...buildTenantRlsSql('mono_voids_pg', 'MONOTONE'),
      ].join('\n'),
    );
    expect(() => assertRlsMigrationsComplete(explicitOkDir, allMeta)).not.toThrow();

    // 10. Helper call SQL with matching table classes also passes
    const helperOkDir = makeTempDir();
    fs.writeFileSync(
      path.join(helperOkDir, '0001.sql'),
      [
        "SELECT mezon_apply_tenant_rls('public.fact_orders_pg', 'FACT');",
        "SELECT mezon_apply_tenant_rls('public.attr_customers_pg', 'ATTR');",
        "SELECT mezon_apply_tenant_rls('public.mono_voids_pg', 'MONOTONE');",
      ].join('\n'),
    );
    expect(() => assertRlsMigrationsComplete(helperOkDir, allMeta)).not.toThrow();
  });

  it('decodes int8 to bigint per pool and preserves fallback parsers without mutating global pg.types.setTypeParser', () => {
    const typesCfg = createCloudPgTypesConfig();
    const int8Parser = typesCfg.getTypeParser(20, 'text') as PgValueParser;
    expect(int8Parser('9007199254740993')).toBe(9_007_199_254_740_993n);

    // Fallback parser (e.g., Drizzle TIMESTAMPTZ string passthrough) is preserved for non-int8 OIDs
    const timestamptzOid = 1184;
    const customFallback: pg.CustomTypesConfig = {
      getTypeParser: ((id: number) =>
        id === timestamptzOid
          ? (v: string) => `raw:${v}`
          : getGlobalPgTypeParser(id)) as pg.CustomTypesConfig['getTypeParser'],
    };
    const wrappedCfg = createCloudPgTypesConfig(customFallback);
    expect((wrappedCfg.getTypeParser(20, 'text') as PgValueParser)('9007199254740993')).toBe(
      9_007_199_254_740_993n,
    );
    expect(
      (wrappedCfg.getTypeParser(timestamptzOid, 'text') as PgValueParser)('2026-01-01T00:00:00Z'),
    ).toBe('raw:2026-01-01T00:00:00Z');

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
