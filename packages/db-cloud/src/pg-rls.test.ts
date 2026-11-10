import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { HlcClock, serializeHlc, unixMsFromBigInt } from '@mezon/domain';
import { DeterministicUuidV7Generator, FixedClock } from '@mezon/test-utils';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { provisionAppRole } from '../ops/provision-app-role.mjs';
import {
  PG_APP_ROLE_NAME,
  PgSchemaRegistry,
  buildTenantRlsSql,
  createCloudPgPool,
  getGlobalPgTypeParser,
  migrateCloudDatabase,
  pgBigint,
  withPgTenantContext,
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

function isLinuxDockerAvailable(): boolean {
  try {
    const osType = execFileSync('docker', ['info', '--format', '{{.OSType}}'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return osType === 'linux';
  } catch {
    return false;
  }
}

async function expectPgErrorCode(promise: Promise<unknown>, expectedCode: string): Promise<void> {
  try {
    await promise;
    expect.unreachable(`Expected PostgreSQL error code ${expectedCode}`);
  } catch (err) {
    const e = err as { code?: unknown; cause?: { code?: unknown } };
    const code = e?.code ?? e?.cause?.code;
    expect(code).toBe(expectedCode);
  }
}

const requirePg = process.env.MEZON_REQUIRE_PG === '1';
const describePg = requirePg || isLinuxDockerAvailable() ? describe : describe.skip;

describePg('@mezon/db-cloud - PostgreSQL 18 RLS, role isolation, and bigint fidelity', () => {
  const testRegistry = new PgSchemaRegistry();
  const rlsLedger = testRegistry.defineTable(
    { name: 'rls_test_ledger', tableClass: 'ATTR', tenantScope: 'store' },
    (c) => ({
      ...c,
      amountTiyin: pgBigint('amount_tiyin').notNull(),
    }),
  );

  const schema = { rls_test_ledger: rlsLedger };

  let container: StartedPostgreSqlContainer;
  let adminConn: ReturnType<typeof createCloudPgPool<typeof schema>>;
  let appConn: ReturnType<typeof createCloudPgPool<typeof schema>>;
  let prevAppPasswordEnv: string | undefined;

  const idGen = new DeterministicUuidV7Generator();
  const orgA = idGen.nextId();
  const orgB = idGen.nextId();
  const storeA = idGen.nextId();
  const storeB = idGen.nextId();
  const nodeId = idGen.nextId();
  const clock = new FixedClock(1_700_000_000_000n);
  const validHlc = serializeHlc(new HlcClock({ clock, nodeId }).now().hlc);

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18-alpine').start();
    adminConn = createCloudPgPool({
      connectionString: container.getConnectionUri(),
      schema,
    });

    // Provision mezon_app role ONLY after asserting migration preflight fails cleanly when role is absent
    await expect(migrateCloudDatabase(adminConn.db)).rejects.toThrowError(
      /Required PostgreSQL role "mezon_app" does not exist/,
    );

    prevAppPasswordEnv = process.env.MEZON_APP_DB_PASSWORD;
    const runtimeTestPassword = randomUUID();
    process.env.MEZON_APP_DB_PASSWORD = runtimeTestPassword;

    await provisionAppRole({ pool: adminConn.pool });

    // Apply foundation migration twice to verify idempotency
    await migrateCloudDatabase(adminConn.db);
    await migrateCloudDatabase(adminConn.db);

    // Create test table owned by admin/postgres + apply ENABLE + FORCE RLS + POLICY + GRANT
    const emptySnap = generateDrizzleJson({});
    const currSnap = generateDrizzleJson(schema);
    const ddlStatements = await generateMigration(emptySnap, currSnap);
    for (const stmt of ddlStatements) {
      await adminConn.pool.query(stmt);
    }
    for (const rlsStmt of buildTenantRlsSql('rls_test_ledger')) {
      await adminConn.pool.query(rlsStmt);
    }

    // Connect application runtime queries strictly as non-owner, non-superuser role mezon_app
    appConn = createCloudPgPool({
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      user: PG_APP_ROLE_NAME,
      password: runtimeTestPassword,
      schema,
    });
  }, 120_000);

  afterAll(async () => {
    if (prevAppPasswordEnv === undefined) {
      delete process.env.MEZON_APP_DB_PASSWORD;
    } else {
      process.env.MEZON_APP_DB_PASSWORD = prevAppPasswordEnv;
    }
    await appConn?.close();
    await adminConn?.close();
    await container?.stop();
  }, 30_000);

  it('verifies mezon_app is non-superuser/non-bypassrls/non-owner and table enforces ENABLE + FORCE RLS', async () => {
    const roleCheck = await adminConn.pool.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreaterole: boolean;
    }>('SELECT rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = $1', [
      PG_APP_ROLE_NAME,
    ]);
    expect(roleCheck.rows[0]).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
    });

    const classCheck = await adminConn.pool.query<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      owner_name: string;
    }>(
      `SELECT c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) AS owner_name
       FROM pg_class c WHERE c.relname = 'rls_test_ledger'`,
    );
    expect(classCheck.rows[0].relrowsecurity).toBe(true);
    expect(classCheck.rows[0].relforcerowsecurity).toBe(true);
    expect(classCheck.rows[0].owner_name).not.toBe(PG_APP_ROLE_NAME);
  });

  it('enforces fail-closed zero-row default and strict cross-tenant read/insert/update/delete isolation as mezon_app', async () => {
    const rowAId = idGen.nextId();
    const rowBId = idGen.nextId();
    const nowMs = unixMsFromBigInt(1_700_000_000_000n);
    const hugeAmount = 9_007_199_254_740_993n; // 2^53 + 1

    await withPgTenantContext(
      appConn.pool,
      orgA,
      async (tx) => {
        await tx.insert(rlsLedger).values({
          id: rowAId,
          organizationId: orgA,
          storeId: storeA,
          deviceId: nodeId,
          hlc: validHlc,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
          deletedAtMs: null,
          amountTiyin: hugeAmount,
        });
      },
      schema,
    );

    await withPgTenantContext(
      appConn.pool,
      orgB,
      async (tx) => {
        await tx.insert(rlsLedger).values({
          id: rowBId,
          organizationId: orgB,
          storeId: storeB,
          deviceId: nodeId,
          hlc: validHlc,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
          deletedAtMs: null,
          amountTiyin: 500n,
        });
      },
      schema,
    );

    // 1. Without tenant context -> fail-closed 0 rows (also proves pool didn't leak ORG_A or ORG_B)
    const noCtx = await appConn.pool.query('SELECT id FROM rls_test_ledger');
    expect(noCtx.rows).toHaveLength(0);

    // 2. Without tenant context -> INSERT rejected with RLS violation (42501)
    await expectPgErrorCode(
      appConn.pool.query(
        `INSERT INTO rls_test_ledger (id, organization_id, store_id, device_id, hlc, created_at_ms, updated_at_ms, amount_tiyin)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [idGen.nextId(), orgA, storeA, nodeId, validHlc, 1000n, 1000n, 100n],
      ),
      '42501',
    );

    // 3. Empty string '' and invalid non-UUID setting -> fail-closed 0 rows cleanly (no 22P02)
    const client = await appConn.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.organization_id', '', true)");
      expect((await client.query('SELECT id FROM rls_test_ledger')).rows).toHaveLength(0);

      await client.query("SELECT set_config('app.organization_id', 'not-a-uuid', true)");
      expect((await client.query('SELECT id FROM rls_test_ledger')).rows).toHaveLength(0);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    // 4. Inside ORG_A context: read own row + verify >53-bit bigint via Drizzle and raw SQL
    await withPgTenantContext(
      appConn.pool,
      orgA,
      async (tx, txClient) => {
        const visibleRows = await tx.select().from(rlsLedger);
        expect(visibleRows).toHaveLength(1);
        expect(visibleRows[0].id).toBe(rowAId);
        expect(visibleRows[0].organizationId).toBe(orgA);

        // >53-bit bigint via Drizzle
        expect(visibleRows[0].amountTiyin).toBe(hugeAmount);
        expect(typeof visibleRows[0].amountTiyin).toBe('bigint');

        // >53-bit bigint via raw SQL client.query AND db.execute
        const rawRes = await txClient.query<{ amount_tiyin: bigint; cnt: bigint }>(
          'SELECT amount_tiyin, COUNT(*) OVER () AS cnt FROM rls_test_ledger WHERE id = $1',
          [rowAId],
        );
        expect(rawRes.rows[0].amount_tiyin).toBe(hugeAmount);
        expect(typeof rawRes.rows[0].amount_tiyin).toBe('bigint');
        expect(rawRes.rows[0].cnt).toBe(1n);

        const execRes = await tx.execute(
          sql`SELECT amount_tiyin FROM rls_test_ledger WHERE id = ${rowAId}`,
        );
        expect(execRes.rows[0].amount_tiyin).toBe(hugeAmount);
        expect(typeof execRes.rows[0].amount_tiyin).toBe('bigint');

        // Pool-level db.execute (no table access, tests createCloudPgPool's Drizzle wrapper directly)
        const poolExecRes = await appConn.db.execute(
          sql`SELECT '9007199254740993'::int8 AS big_val`,
        );
        expect(poolExecRes.rows[0].big_val).toBe(hugeAmount);
        expect(typeof poolExecRes.rows[0].big_val).toBe('bigint');

        // Cannot UPDATE ORG_B row (0 rows affected)
        const updateForeign = await txClient.query(
          'UPDATE rls_test_ledger SET amount_tiyin = 999 WHERE id = $1',
          [rowBId],
        );
        expect(updateForeign.rowCount).toBe(0);

        // Cannot DELETE ORG_B row (0 rows affected)
        const deleteForeign = await txClient.query('DELETE FROM rls_test_ledger WHERE id = $1', [
          rowBId,
        ]);
        expect(deleteForeign.rowCount).toBe(0);
      },
      schema,
    );

    // 5. Inside ORG_A context -> INSERT for ORG_B rejected by WITH CHECK (42501)
    await expectPgErrorCode(
      withPgTenantContext(
        appConn.pool,
        orgA,
        async (tx) => {
          await tx.insert(rlsLedger).values({
            id: idGen.nextId(),
            organizationId: orgB,
            storeId: storeB,
            deviceId: nodeId,
            hlc: validHlc,
            createdAtMs: nowMs,
            updatedAtMs: nowMs,
            amountTiyin: 1n,
          });
        },
        schema,
      ),
      '42501',
    );

    // 6. Inside ORG_A context -> UPDATE reassigning own ORG_A row to ORG_B rejected by WITH CHECK (42501)
    await expectPgErrorCode(
      withPgTenantContext(
        appConn.pool,
        orgA,
        async (tx) => {
          await tx.update(rlsLedger).set({ organizationId: orgB }).where(eq(rlsLedger.id, rowAId));
        },
        schema,
      ),
      '42501',
    );

    // 7. Invalid HLC length rejected by PostgreSQL CHECK (length(hlc) = 58) -> 23514 check_violation
    await expectPgErrorCode(
      withPgTenantContext(
        appConn.pool,
        orgA,
        async (_tx, txClient) => {
          await txClient.query(
            `INSERT INTO rls_test_ledger (id, organization_id, store_id, device_id, hlc, created_at_ms, updated_at_ms, amount_tiyin)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [idGen.nextId(), orgA, storeA, nodeId, 'short-hlc', 1000n, 1000n, 10n],
          );
        },
        schema,
      ),
      '23514',
    );

    // 8. After all transactions exit, global pg.types remains untouched and pool has 0 leaked context
    expect(getGlobalPgTypeParser(20, 'text')('9007199254740993')).toBe('9007199254740993');
    const afterPoolSelect = await appConn.pool.query('SELECT id FROM rls_test_ledger');
    expect(afterPoolSelect.rows).toHaveLength(0);
  });
});
