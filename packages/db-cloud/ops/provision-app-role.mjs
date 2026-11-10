import pg from 'pg';

export const DEFAULT_APP_ROLE_NAME = 'mezon_app';
export const DEFAULT_APP_PASSWORD_ENV = 'MEZON_APP_DB_PASSWORD';

const PG_IDENTIFIER_REGEX = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Provisions or updates the non-owner, non-superuser application database role (`mezon_app`).
 * Separated from Drizzle migrations so production migration roles never require `CREATEROLE`
 * and passwords never appear in SQL files or logs.
 */
export async function provisionAppRole(options) {
  const {
    pool,
    roleName = DEFAULT_APP_ROLE_NAME,
    passwordEnvVar = DEFAULT_APP_PASSWORD_ENV,
  } = options ?? {};

  if (!pool) {
    throw new TypeError('provisionAppRole requires a pg Pool instance');
  }
  if (!PG_IDENTIFIER_REGEX.test(roleName)) {
    throw new RangeError(`Invalid PostgreSQL role identifier: "${roleName}"`);
  }

  const password = process.env[passwordEnvVar];
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error(
      `Missing required environment variable "${passwordEnvVar}" for PostgreSQL role "${roleName}" provisioning`,
    );
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('mezon.prov_role', $1, true), set_config('mezon.prov_pwd', $2, true)",
      [roleName, password],
    );
    await client.query(`
      DO $$
      DECLARE
        v_role text := current_setting('mezon.prov_role', true);
        v_pwd  text := current_setting('mezon.prov_pwd', true);
      BEGIN
        IF v_role IS NULL OR v_pwd IS NULL OR length(v_pwd) = 0 THEN
          RAISE EXCEPTION 'Provisioning context not initialized';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
          EXECUTE format(
            'CREATE ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD %L',
            v_role,
            v_pwd
          );
        ELSE
          EXECUTE format(
            'ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD %L',
            v_role,
            v_pwd
          );
        END IF;
      END
      $$;
    `);
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback failure
    }
    throw err;
  } finally {
    client.release();
  }
}

async function runCli() {
  const adminUrl = process.env.MEZON_PG_ADMIN_URL;
  if (typeof adminUrl !== 'string' || adminUrl.length === 0) {
    throw new Error('Missing required environment variable "MEZON_PG_ADMIN_URL"');
  }
  const roleName = process.env.MEZON_APP_ROLE_NAME || DEFAULT_APP_ROLE_NAME;
  const pool = new pg.Pool({ connectionString: adminUrl });
  try {
    await provisionAppRole({ pool, roleName });
    console.info(`Provisioned PostgreSQL role "${roleName}" cleanly.`);
  } finally {
    await pool.end();
  }
}

const isEntrypoint =
  typeof process.argv[1] === 'string' &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

if (isEntrypoint) {
  runCli().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
