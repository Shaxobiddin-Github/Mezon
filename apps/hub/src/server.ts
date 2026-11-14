import {
  type LocalSqliteConnection,
  SqliteCartStore,
  SqliteCatalogStore,
  SqliteCustomerStore,
  SqliteHubAuthStore,
  SqliteOrderStore,
  SqliteReturnStore,
  SqliteSaleStore,
  SqliteShiftStore,
  SqliteStockStore,
  SqliteSupplierStore,
  createSqliteCartStore,
  createSqliteCatalogStore,
  createSqliteCustomerStore,
  createSqliteHubAuthStore,
  createSqliteOrderStore,
  createSqliteReturnStore,
  createSqliteSaleStore,
  createSqliteShiftStore,
  createSqliteStockStore,
  createSqliteSupplierStore,
  migrateLocalDatabase,
  openLocalSqliteDatabase,
  createSqlitePrinterStore,
} from '@mezon/db-local';
import type { Clock, PinHasher, RandomSource } from '@mezon/domain';
import {
  CryptoRandomSource,
  SystemClock,
  type DiscoveredWindowsPrinter,
  type PrinterConfig,
  type PrinterDriver,
} from '@mezon/drivers';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { DestinationStream, LevelWithSilent } from 'pino';
import { Argon2PinHasher } from './argon2-pin-hasher.js';
import { HubAuthService } from './auth-service.js';
import { HubCartService } from './cart-service.js';
import { HubCatalogService } from './catalog-service.js';
import { DEFAULT_HUB_HOST, resolveHubSecurityConfig } from './config.js';
import { registerHubErrorHandlers } from './error-handler.js';
import { createHubLogger } from './logger.js';
import { registerHubRoutes } from './routes.js';
import { createHostAllowlistState, registerHubSecurityHooks } from './security.js';
import { HubSaleService } from './sale-service.js';
import { HubCustomerService } from './customer-service.js';
import { HubReturnService } from './return-service.js';
import { HubStockService } from './stock-service.js';
import { HubSupplierService } from './supplier-service.js';
import { HubShiftService } from './shift-service.js';
import { HubOrderService } from './order-service.js';
import { HubPrinterService } from './printer-service.js';

export interface CreateHubServerOptions {
  readonly dbPath: string;
  readonly host?: string;
  readonly port?: number;
  readonly allowedOrigins?: readonly string[];
  /**
   * Dev/test-only option (`U3` / `C1`): enables browser CORS headers (`Access-Control-Allow-*` & `OPTIONS` preflight)
   * strictly for loopback `http://127.0.0.1:<port>` / `http://localhost:<port>` origins listed in `allowedOrigins`.
   * Never read from `process.env`; never passed by Electron worker in production.
   */
  readonly enableDevLoopbackCors?: boolean;
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
  readonly printerDriverFactory?: (config: PrinterConfig) => PrinterDriver;
  readonly listWindowsPrintersFn?: () => Promise<readonly DiscoveredWindowsPrinter[]>;
  readonly registerExtraTestRoutes?: (app: FastifyInstance) => void;
}

export interface HubServer {
  readonly app: FastifyInstance;
  readonly connection: LocalSqliteConnection;
  readonly store: SqliteHubAuthStore;
  readonly catalogStore: SqliteCatalogStore;
  readonly stockStore: SqliteStockStore;
  readonly cartStore: SqliteCartStore;
  readonly saleStore: SqliteSaleStore;
  readonly returnStore: SqliteReturnStore;
  readonly customerStore: SqliteCustomerStore;
  readonly supplierStore: SqliteSupplierStore;
  readonly shiftStore: SqliteShiftStore;
  readonly orderStore: SqliteOrderStore;
  readonly authService: HubAuthService;
  readonly catalogService: HubCatalogService;
  readonly stockService: HubStockService;
  readonly cartService: HubCartService;
  readonly saleService: HubSaleService;
  readonly returnService: HubReturnService;
  readonly customerService: HubCustomerService;
  readonly supplierService: HubSupplierService;
  readonly shiftService: HubShiftService;
  readonly orderService: HubOrderService;
  readonly printerService: HubPrinterService;
  listen(): Promise<{ readonly host: typeof DEFAULT_HUB_HOST; readonly port: number }>;
  close(): Promise<void>;
}

export async function createHubServer(options: CreateHubServerOptions): Promise<HubServer> {
  const securityConfig = resolveHubSecurityConfig({
    host: options.host,
    port: options.port,
    allowedOrigins: options.allowedOrigins,
    enableDevLoopbackCors: options.enableDevLoopbackCors,
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
  let stockStore: SqliteStockStore;
  let cartStore: SqliteCartStore;
  let saleStore: SqliteSaleStore;
  let returnStore: SqliteReturnStore;
  let customerStore: SqliteCustomerStore;
  let supplierStore: SqliteSupplierStore;
  let shiftStore: SqliteShiftStore;
  let orderStore: SqliteOrderStore;
  let authService: HubAuthService;
  let catalogService: HubCatalogService;
  let stockService: HubStockService;
  let cartService: HubCartService;
  let saleService: HubSaleService;
  let returnService: HubReturnService;
  let customerService: HubCustomerService;
  let supplierService: HubSupplierService;
  let shiftService: HubShiftService;
  let orderService: HubOrderService;
  let printerService: HubPrinterService;
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
    stockStore = createSqliteStockStore({
      connection,
      getRuntimeContext: () => {
        const ctx = store.getActiveRuntimeContext();
        return ctx
          ? {
              uow: ctx.uow,
              organizationId: ctx.config.organizationId,
              storeId: ctx.config.storeId,
            }
          : null;
      },
    });
    cartStore = createSqliteCartStore({
      connection,
      getRuntimeContext: () => {
        const ctx = store.getActiveRuntimeContext();
        return ctx
          ? {
              uow: ctx.uow,
              organizationId: ctx.config.organizationId,
              storeId: ctx.config.storeId,
            }
          : null;
      },
    });
    // C1: Hub never injects `__testHooks` into SqliteSaleStore in production/server runtime
    saleStore = createSqliteSaleStore({
      connection,
      getRuntimeContext: () => {
        const ctx = store.getActiveRuntimeContext();
        return ctx
          ? {
              uow: ctx.uow,
              organizationId: ctx.config.organizationId,
              storeId: ctx.config.storeId,
            }
          : null;
      },
    });
    returnStore = createSqliteReturnStore({
      connection,
      getRuntimeContext: () => {
        const ctx = store.getActiveRuntimeContext();
        return ctx
          ? {
              uow: ctx.uow,
              organizationId: ctx.config.organizationId,
              storeId: ctx.config.storeId,
            }
          : null;
      },
    });
    customerStore = createSqliteCustomerStore({
      connection,
      getRuntimeContext: () => {
        const ctx = store.getActiveRuntimeContext();
        return ctx
          ? {
              uow: ctx.uow,
              organizationId: ctx.config.organizationId,
              storeId: ctx.config.storeId,
            }
          : null;
      },
    });
    supplierStore = createSqliteSupplierStore({
      connection,
      getRuntimeContext: () => {
        const ctx = store.getActiveRuntimeContext();
        return ctx
          ? {
              uow: ctx.uow,
              organizationId: ctx.config.organizationId,
              storeId: ctx.config.storeId,
            }
          : null;
      },
    });
    shiftStore = createSqliteShiftStore({
      connection,
      getRuntimeContext: () => {
        const ctx = store.getActiveRuntimeContext();
        return ctx
          ? {
              uow: ctx.uow,
              organizationId: ctx.config.organizationId,
              storeId: ctx.config.storeId,
            }
          : null;
      },
    });
    orderStore = createSqliteOrderStore({
      connection,
      getRuntimeContext: () => {
        const ctx = store.getActiveRuntimeContext();
        return ctx
          ? {
              uow: ctx.uow,
              organizationId: ctx.config.organizationId,
              storeId: ctx.config.storeId,
            }
          : null;
      },
    });
    authService = await HubAuthService.create({
      store,
      pinHasher,
      random,
    });
    catalogService = new HubCatalogService(catalogStore);
    stockService = new HubStockService(stockStore);
    cartService = new HubCartService(cartStore, authService);
    saleService = new HubSaleService(saleStore, authService);
    returnService = new HubReturnService(returnStore, authService);
    customerService = new HubCustomerService(customerStore);
    supplierService = new HubSupplierService(supplierStore);
    shiftService = new HubShiftService(shiftStore, authService);
    orderService = new HubOrderService(orderStore, authService);
    const printerStore = createSqlitePrinterStore({
      connection,
      getRuntimeContext: () => {
        const ctx = store.getActiveRuntimeContext();
        return ctx
          ? {
              uow: ctx.uow,
              organizationId: ctx.config.organizationId,
              storeId: ctx.config.storeId,
            }
          : null;
      },
    });
    printerService = new HubPrinterService({
      printerStore,
      authService,
      saleStore,
      returnStore,
      shiftStore,
      printerDriverFactory: options.printerDriverFactory,
      listWindowsPrintersFn: options.listWindowsPrintersFn,
    });

    app = Fastify({
      loggerInstance: logger as unknown as FastifyBaseLogger,
    });

    const hostState = createHostAllowlistState(securityConfig.port);
    registerHubSecurityHooks(app, securityConfig, hostState);
    registerHubErrorHandlers(app);
    registerHubRoutes(
      app,
      authService,
      catalogService,
      stockService,
      cartService,
      saleService,
      returnService,
      customerService,
      supplierService,
      shiftService,
      orderService,
      printerService,
    );
    options.registerExtraTestRoutes?.(app);

    let boundPort: number | null = securityConfig.port > 0 ? securityConfig.port : null;

    return {
      app,
      connection,
      store,
      catalogStore,
      stockStore,
      cartStore,
      saleStore,
      returnStore,
      customerStore,
      supplierStore,
      shiftStore,
      orderStore,
      authService,
      catalogService,
      stockService,
      cartService,
      saleService,
      returnService,
      customerService,
      supplierService,
      shiftService,
      orderService,
      printerService,
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
