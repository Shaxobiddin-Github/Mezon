import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PG_APP_ROLE_NAME,
  createCloudPgPool,
  CloudAuthStore,
  shouldRunPgTests,
} from '@mezon/db-cloud';
import { provisionAppRole } from '../../../../packages/db-cloud/ops/provision-app-role.mjs';
import { runCreateOrgCli } from './create-org.js';

const describePg = shouldRunPgTests() ? describe : describe.skip;

describePg('@mezon/cloud - CLI org:create (C4)', () => {
  let container: StartedPostgreSqlContainer;
  let adminConn: ReturnType<typeof createCloudPgPool>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18-alpine').start();
    const adminUri = container.getConnectionUri();
    process.env.DATABASE_ADMIN_URL = adminUri;
    process.env.JWT_SECRET = 'super-secure-jwt-secret-key-at-least-32-chars-long-12345';
    process.env.NODE_ENV = 'test';
    process.env.MEZON_APP_DB_PASSWORD = 'test-cli-password-12345';

    adminConn = createCloudPgPool({
      connectionString: adminUri,
    });
    await provisionAppRole({ pool: adminConn.pool });

    const appConnUri = new URL(adminUri);
    appConnUri.username = PG_APP_ROLE_NAME;
    appConnUri.password = 'test-cli-password-12345';
    process.env.DATABASE_URL = appConnUri.toString();
  }, 60_000);

  afterAll(async () => {
    if (adminConn) await adminConn.close();
    if (container) await container.stop();
  });

  it('v1: refuses to create an owner without an explicit login and a strong password', async () => {
    await expect(runCreateOrgCli([])).rejects.toThrow(/--login/);
    await expect(runCreateOrgCli(['--login', 'a@b.uz'])).rejects.toThrow(/--password/);
    await expect(runCreateOrgCli(['--login', 'a@b.uz', '--password', 'short'])).rejects.toThrow(
      /at least 10/,
    );
  });

  it('pilot 11-21: runs with only DATABASE_ADMIN_URL, as in the migrate container (no JWT_SECRET, no DATABASE_URL)', async () => {
    const saved = { jwt: process.env.JWT_SECRET, url: process.env.DATABASE_URL };
    delete process.env.JWT_SECRET;
    delete process.env.DATABASE_URL;
    try {
      await runCreateOrgCli([
        '--store-code',
        'adminonly',
        '--login',
        'admin_only@guzar.uz',
        '--password',
        'AdminOnlyPassword2026',
      ]);
      const appConnUri = new URL(container.getConnectionUri());
      appConnUri.username = PG_APP_ROLE_NAME;
      appConnUri.password = 'test-cli-password-12345';
      const appConn = createCloudPgPool({ connectionString: appConnUri.toString() });
      try {
        const lookup = await new CloudAuthStore(appConn.pool).lookupLogin('admin_only@guzar.uz');
        expect(lookup?.userRole).toBe('owner');
      } finally {
        await appConn.close();
      }
      // Without any database URL it fails clearly, before touching anything.
      const admin = process.env.DATABASE_ADMIN_URL;
      delete process.env.DATABASE_ADMIN_URL;
      try {
        await expect(
          runCreateOrgCli(['--login', 'x@guzar.uz', '--password', 'AdminOnlyPassword2026']),
        ).rejects.toThrow(/DATABASE_ADMIN_URL/);
      } finally {
        process.env.DATABASE_ADMIN_URL = admin;
      }
    } finally {
      process.env.JWT_SECRET = saved.jwt;
      process.env.DATABASE_URL = saved.url;
    }
  }, 30_000);

  it('provisions organization, store, and owner via CLI and enables login without leaking password', async () => {
    const rawPassword = 'CliOwnerPassword2026!';
    const login = 'cli_owner@guzar.uz';

    await runCreateOrgCli([
      '--org-name',
      'Kattaqo‘rg‘on Savdo MCHJ',
      '--store-name',
      '1-Do‘kon',
      '--store-code',
      'shop1',
      '--login',
      login,
      '--password',
      rawPassword,
      '--username',
      'Bobur',
    ]);

    // Now connect as mezon_app role to verify pre-auth lookup
    const appConnUri = new URL(container.getConnectionUri());
    appConnUri.username = PG_APP_ROLE_NAME;
    appConnUri.password = 'test-cli-password-12345';

    const appConn = createCloudPgPool({
      connectionString: appConnUri.toString(),
    });

    try {
      const authStore = new CloudAuthStore(appConn.pool);
      const lookup = await authStore.lookupLogin(login);

      expect(lookup).not.toBeNull();
      expect(lookup?.userName).toBe('Bobur');
      expect(lookup?.userRole).toBe('owner');
      expect(lookup?.userStatus).toBe('active');
      expect(lookup?.passwordHash).not.toBe(rawPassword);
      expect(lookup?.passwordHash.startsWith('$argon2id$')).toBe(true);
    } finally {
      await appConn.close();
    }
  }, 30_000);
});
