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
export function createCloudPgTypesConfig(fallback?: pg.CustomTypesConfig): pg.CustomTypesConfig {
  return {
    getTypeParser(id, format) {
      if (id === PG_INT8_OID && (format === undefined || String(format) === 'text')) {
        return (value: string) => BigInt(value);
      }
      if (fallback) {
        // @types/pg getTypeParser returns an untyped pg-types TypeParser function.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return fallback.getTypeParser(id, format);
      }
      return getGlobalPgTypeParser(id, format);
    },
  };
}

interface QueryConfigWithOptionalTypes {
  readonly types?: pg.CustomTypesConfig;
}

function isCustomTypesConfig(value: unknown): value is pg.CustomTypesConfig {
  return (
    typeof value === 'object' &&
    value !== null &&
    'getTypeParser' in value &&
    typeof value.getTypeParser === 'function'
  );
}

/**
 * Wraps a `pg.Pool` or `pg.PoolClient` passed into `drizzle(...)` so that Drizzle's internal
 * `NodePgPreparedQuery` (`db.execute`, `db.select`, etc.) preserves our `INT8 -> BigInt` parser
 * instead of overwriting pool `types` with a query-level fallback to global `pg.types`.
 */
function wrapPgExecutorForDrizzle<T extends pg.Pool | pg.PoolClient>(executor: T): T {
  type AnyFn = (...args: unknown[]) => unknown;
  const boundQuery = (executor.query as AnyFn).bind(executor);
  const boundConnect =
    executor instanceof pg.Pool
      ? (executor.connect as (...args: unknown[]) => Promise<pg.PoolClient>).bind(executor)
      : undefined;

  return new Proxy(executor, {
    get(target, prop) {
      if (prop === 'query') {
        return (configOrText: unknown, ...rest: unknown[]): unknown => {
          if (
            typeof configOrText === 'object' &&
            configOrText !== null &&
            'types' in configOrText
          ) {
            const cfg = configOrText as QueryConfigWithOptionalTypes;
            if (isCustomTypesConfig(cfg.types)) {
              return boundQuery(
                {
                  ...cfg,
                  types: createCloudPgTypesConfig(cfg.types),
                },
                ...rest,
              );
            }
          }
          return boundQuery(configOrText, ...rest);
        };
      }
      if (prop === 'connect' && boundConnect) {
        return (...args: unknown[]): unknown => {
          if (args.length > 0 && typeof args[0] === 'function') {
            return (target as pg.Pool & { connect: AnyFn }).connect(...args);
          }
          return boundConnect(...args).then((client) => wrapPgExecutorForDrizzle(client));
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value === 'function') {
        return (value as AnyFn).bind(target);
      }
      return value;
    },
  });
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
  const drizzlePool = wrapPgExecutorForDrizzle(pool);

  const db = schema ? drizzle(drizzlePool, { schema }) : drizzle<TSchema>(drizzlePool);

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
    const drizzleClient = wrapPgExecutorForDrizzle(client);
    const txDb = schema
      ? drizzle<TSchema, pg.PoolClient>(drizzleClient, { schema })
      : drizzle<TSchema, pg.PoolClient>(drizzleClient);
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
