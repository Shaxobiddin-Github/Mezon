import { type UuidV7, parseUuidV7 } from '@mezon/domain';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { PG_TENANT_SETTING_KEY } from './rls.js';

const PG_INT8_OID = pg.types.builtins.INT8;

export type PgValueParser = (value: string) => unknown;

export function getGlobalPgTypeParser(id: number, format?: 'text' | 'binary'): PgValueParser {
  // @types/pg references untyped transitive pg-types under pnpm strict isolation.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return pg.types.getTypeParser(id, format);
}

/**
 * Per-pool type parser configuration decoding PostgreSQL `int8` (`bigint`) directly to JS `bigint`.
 * Never mutates global `pg.types.setTypeParser`.
 */
export function createCloudPgTypesConfig(): pg.CustomTypesConfig {
  return {
    getTypeParser(id, format) {
      if (id === PG_INT8_OID && (format === undefined || String(format) === 'text')) {
        return (value: string) => BigInt(value);
      }
      return getGlobalPgTypeParser(id, format);
    },
  };
}

export interface CloudPgConnection<
  TSchema extends Record<string, unknown> = Record<string, never>,
> {
  readonly pool: pg.Pool;
  readonly db: NodePgDatabase<TSchema>;
  close(): Promise<void>;
}

export function createCloudPgPool<TSchema extends Record<string, unknown> = Record<string, never>>(
  config: Omit<pg.PoolConfig, 'types'> & { readonly schema?: TSchema },
): CloudPgConnection<TSchema> {
  const { schema, ...poolConfig } = config;
  const pool = new pg.Pool({
    ...poolConfig,
    types: createCloudPgTypesConfig(),
  });

  const db = schema ? drizzle(pool, { schema }) : drizzle<TSchema>(pool);

  return {
    pool,
    db,
    async close() {
      await pool.end();
    },
  };
}

/**
 * Runs a callback inside an explicit PostgreSQL transaction with transaction-local
 * `set_config('app.organization_id', $1, true)` so tenant context never leaks across
 * pooled connections after commit or rollback.
 */
export async function withPgTenantContext<
  TResult,
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  pool: pg.Pool,
  organizationId: UuidV7,
  fn: (db: NodePgDatabase<TSchema>, client: pg.PoolClient) => Promise<TResult>,
  schema?: TSchema,
): Promise<TResult> {
  const canonicalOrgId = parseUuidV7(organizationId);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config($1, $2, true)`, [PG_TENANT_SETTING_KEY, canonicalOrgId]);
    const txDb = schema
      ? drizzle<TSchema, pg.PoolClient>(client, { schema })
      : drizzle<TSchema, pg.PoolClient>(client);
    const result = await fn(txDb, client);
    await client.query('COMMIT');
    return result;
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
