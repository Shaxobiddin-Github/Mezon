import {
  type LocalSqliteConnection,
  SqliteCatalogStore,
  SqliteHubAuthStore,
  createSqliteCatalogStore,
  createSqliteHubAuthStore,
  migrateLocalDatabase,
  openLocalSqliteDatabase,
} from '@mezon/db-local';
import type { Clock, PinHasher, RandomSource } from '@mezon/domain';
import { CryptoRandomSource, SystemClock } from '@mezon/drivers';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { DestinationStream, LevelWithSilent } from 'pino';
import { Argon2PinHasher } from './argon2-pin-hasher.js';
import { HubAuthService } from './auth-service.js';
import { HubCatalogService } from './catalog-service.js';
import { DEFAULT_HUB_HOST, resolveHubSecurityConfig } from './config.js';
import { registerHubErrorHandlers } from './error-handler.js';
import { createHubLogger } from './logger.js';
import { registerHubRoutes } from './routes.js';
import { createHostAllowlistState, registerHubSecurityHooks } from './security.js';

export interface CreateHubServerOptions {
  readonly dbPath: string;
  readonly host?: string;
  readonly port?: number;
  readonly allowedOrigins?: readonly string[];
  readonly logLevel?: LevelWithSilent;
  readonly logStream?: DestinationStream;
  readonly clock?: Clock;
  readonly random?: RandomSource;
  readonly pinHasher?: PinHasher;
  readonly sessionTtlMs?: bigint;
  readonly lastSeenThrottleMs?: bigint;
  readonly userLockDurationMs?: bigint;
  readonly maxUserFailedAttempts?: number;
  readonly maxDeviceFailedAttempts?: number;
  readonly deviceFailureWindowMs?: bigint;
  readonly registerExtraTestRoutes?: (app: FastifyInstance) => void;
}

export interface HubServer {
  readonly app: FastifyInstance;
  readonly connection: LocalSqliteConnection;
  readonly store: SqliteHubAuthStore;
  readonly catalogStore: SqliteCatalogStore;
  readonly authService: HubAuthService;
  readonly catalogService: HubCatalogService;
  listen(): Promise<{ readonly host: typeof DEFAULT_HUB_HOST; readonly port: number }>;
  close(): Promise<void>;
}

export async function createHubServer(options: CreateHubServerOptions): Promise<HubServer> {
  const securityConfig = resolveHubSecurityConfig({
    host: options.host,
    port: options.port,
    allowedOrigins: options.allowedOrigins,
  });

  const clock = options.clock ?? new SystemClock();
  const random = options.random ?? new CryptoRandomSource();
  const pinHasher = options.pinHasher ?? new Argon2PinHasher();
  const logger = createHubLogger({
    level: options.logLevel,
    stream: options.logStream,
  });

  const connection = openLocalSqliteDatabase(options.dbPath);
  let store: SqliteHubAuthStore;
  let catalogStore: SqliteCatalogStore;
  let authService: HubAuthService;
  let catalogService: HubCatalogService;
  let app: FastifyInstance;

  try {
    migrateLocalDatabase(connection.db);
    store = await createSqliteHubAuthStore({
      connection,
      clock,
      random,
      sessionTtlMs: options.sessionTtlMs,
      lastSeenThrottleMs: options.lastSeenThrottleMs,
      userLockDurationMs: options.userLockDurationMs,
      maxUserFailedAttempts: options.maxUserFailedAttempts,
      maxDeviceFailedAttempts: options.maxDeviceFailedAttempts,
      deviceFailureWindowMs: options.deviceFailureWindowMs,
    });
    catalogStore = createSqliteCatalogStore({
      connection,
      getRuntimeContext: () => {
        const ctx = store.getActiveRuntimeContext();
        return ctx ? { uow: ctx.uow, organizationId: ctx.config.organizationId } : null;
      },
    });
    authService = await HubAuthService.create({
      store,
      pinHasher,
      random,
    });
    catalogService = new HubCatalogService(catalogStore);

    app = Fastify({
      loggerInstance: logger as unknown as FastifyBaseLogger,
    });

    const hostState = createHostAllowlistState(securityConfig.port);
    registerHubSecurityHooks(app, securityConfig, hostState);
    registerHubErrorHandlers(app);
    registerHubRoutes(app, authService, catalogService);
    options.registerExtraTestRoutes?.(app);

    let boundPort: number | null = securityConfig.port > 0 ? securityConfig.port : null;

    return {
      app,
      connection,
      store,
      catalogStore,
      authService,
      catalogService,
      async listen() {
        await app.listen({
          host: DEFAULT_HUB_HOST,
          port: securityConfig.port,
        });
        const addr = app.server.address();
        if (addr && typeof addr !== 'string') {
          boundPort = addr.port;
          hostState.updatePort(addr.port);
        }
        return {
          host: DEFAULT_HUB_HOST,
          port: boundPort ?? securityConfig.port,
        };
      },
      async close() {
        try {
          await app.close();
        } finally {
          connection.close();
        }
      },
    };
  } catch (err) {
    connection.close();
    throw err;
  }
}
