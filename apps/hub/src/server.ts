import path from 'node:path';
import {
  type LocalSqliteConnection,
  SqliteCartStore,
  SqliteCatalogStore,
  SqliteRulesStore,
  consumeRulesHwmAfterRestore,
  SqliteTaxSettingsStore,
  SqliteCustomerStore,
  SqliteHubAuthStore,
  SqliteOrderStore,
  SqliteReturnStore,
  SqliteSaleStore,
  SqliteShiftStore,
  SqliteStockStore,
  SqliteSupplierStore,
  SqliteReportStore,
  SqliteBackupService,
  createSqliteCartStore,
  createSqliteCatalogStore,
  createSqliteRulesStore,
  SqliteFiscalStore,
  createSqliteTaxSettingsStore,
  createSqliteCustomerStore,
  createSqliteHubAuthStore,
  createSqliteOrderStore,
  createSqliteReturnStore,
  createSqliteSaleStore,
  createSqliteShiftStore,
  createSqliteStockStore,
  createSqliteSupplierStore,
  createSqliteReportStore,
  migrateLocalDatabase,
  openLocalSqliteDatabase,
  createSqlitePrinterStore,
  SqliteCloudStore,
  createSqliteCloudStore,
  SqliteOutboxSyncStore,
} from '@mezon/db-local';
import {
  type Clock,
  DomainError,
  MonotonicUuidV7Generator,
  type PinHasher,
  type RandomSource,
  parseUuidV7,
} from '@mezon/domain';
import {
  CryptoRandomSource,
  FakeFiscalDriver,
  type FiscalDriver,
  SystemClock,
  type DiscoveredWindowsPrinter,
  type PrinterConfig,
  type PrinterDriver,
} from '@mezon/drivers';
import { FileFakeFiscalLedgerStore } from '@mezon/drivers/node';
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
import { HubReportService } from './report-service.js';
import { CatalogImportCache } from './catalog-import-cache.js';
import { AesGcmSafeStorageAdapter, type SafeStoragePort } from './safe-storage-port.js';
import { HubCloudService } from './cloud-service.js';
import { HubSyncPushWorker } from './sync-push-worker.js';
import { PRODUCTION_TRUSTED_RULE_KEYS, type TrustedRuleKey } from '@mezon/rules';
import { registerRulesRoutes } from './rules-routes.js';
import { HubRulesService, nodeEd25519RulesVerifier } from './rules-service.js';
import { registerFiscalRoutes } from './fiscal-routes.js';
import { HubFiscalService } from './fiscal-service.js';
import { HubFiscalWorker, type HubFiscalWorkerOptions } from './fiscal-worker.js';

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
  readonly safeStorage?: SafeStoragePort;
  readonly cloudFetchFn?: typeof fetch;
  readonly registerExtraTestRoutes?: (app: FastifyInstance) => void;
  /**
   * TEST/DI ONLY (T3.2): trusted rules public keys. Production uses the built-in
   * `PRODUCTION_TRUSTED_RULE_KEYS`; passing this under NODE_ENV=production throws.
   */
  readonly trustedRuleKeys?: readonly TrustedRuleKey[];
  /**
   * T3.3 fiscal driver (DI). Only `FakeFiscalDriver` exists until T3.5 (§3.3); the default is a fake
   * driver whose ledger lives next to the database so it survives restarts.
   */
  readonly fiscalDriver?: FiscalDriver;
  /** TEST ONLY: fiscal worker timing / seams. */
  readonly fiscalWorkerOptions?: Pick<
    HubFiscalWorkerOptions,
    'statusRecheckMs' | 'minBackoffMs' | 'maxBackoffMs' | '__afterSentCommitted'
  >;
}

export interface HubServer {
  readonly app: FastifyInstance;
  readonly connection: LocalSqliteConnection;
  readonly store: SqliteHubAuthStore;
  readonly catalogStore: SqliteCatalogStore;
  readonly taxSettingsStore: SqliteTaxSettingsStore;
  readonly rulesStore: SqliteRulesStore;
  readonly rulesService: HubRulesService;
  readonly fiscalStore: SqliteFiscalStore;
  readonly fiscalService: HubFiscalService;
  readonly fiscalWorker: HubFiscalWorker;
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
  readonly reportStore: SqliteReportStore;
  readonly reportService: HubReportService;
  readonly backupService: SqliteBackupService;
  readonly importCache: CatalogImportCache;
  readonly cloudStore: SqliteCloudStore;
  readonly cloudService: HubCloudService;
  readonly outboxStore: SqliteOutboxSyncStore;
  readonly pushWorker: HubSyncPushWorker;
  readonly safeStorage: SafeStoragePort;
  listen(): Promise<{ readonly host: typeof DEFAULT_HUB_HOST; readonly port: number }>;
  close(): Promise<void>;
}

export async function createHubServer(options: CreateHubServerOptions): Promise<HubServer> {
  if (options.trustedRuleKeys !== undefined && process.env.NODE_ENV === 'production') {
    throw new Error('trustedRuleKeys is a test/DI-only option and must not be set in production');
  }
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

  const backupDir = path.join(path.dirname(options.dbPath), 'backups');
  const restoreOutcome = await SqliteBackupService.executeStagedRestoreIfPending({
    dbPath: options.dbPath,
    backupDir,
  });

  const connection = openLocalSqliteDatabase(options.dbPath);
  let store: SqliteHubAuthStore;
  let catalogStore: SqliteCatalogStore;
  let taxSettingsStore: SqliteTaxSettingsStore;
  let rulesStore: SqliteRulesStore;
  let rulesService: HubRulesService;
  let fiscalStore: SqliteFiscalStore;
  let fiscalService: HubFiscalService;
  let fiscalWorker: HubFiscalWorker;
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
  let cloudStore: SqliteCloudStore;
  let cloudService: HubCloudService;
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
    taxSettingsStore = createSqliteTaxSettingsStore({
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
    rulesStore = createSqliteRulesStore({
      connection,
      getRuntimeContext: () => {
        const ctx = store.getActiveRuntimeContext();
        return ctx ? { uow: ctx.uow, organizationId: ctx.config.organizationId } : null;
      },
    });
    rulesService = new HubRulesService({
      store: rulesStore,
      trustedKeys: options.trustedRuleKeys ?? PRODUCTION_TRUSTED_RULE_KEYS,
      verifier: nodeEd25519RulesVerifier,
      getOrganizationId: () => store.getActiveRuntimeContext()?.config.organizationId ?? null,
      nowMs: () => BigInt(clock.now()),
      logger,
    });
    if (store.getActiveRuntimeContext() !== null) {
      // Rollback high-water mark is never below any stored package (also after backup restore).
      await rulesStore.recomputeMaxVersion(consumeRulesHwmAfterRestore(backupDir));
    }
    fiscalStore = new SqliteFiscalStore({
      connection,
      getRuntimeContext: () => {
        const ctx = store.getActiveRuntimeContext();
        return ctx
          ? { uow: ctx.uow, organizationId: ctx.config.organizationId, storeId: ctx.config.storeId }
          : null;
      },
    });
    const fiscalDriver =
      options.fiscalDriver ??
      new FakeFiscalDriver({
        ledgerStore: new FileFakeFiscalLedgerStore(
          path.join(path.dirname(options.dbPath), 'fake-fiscal-ledger.json'),
        ),
      });
    fiscalWorker = new HubFiscalWorker({
      store: fiscalStore,
      driver: fiscalDriver,
      nowMs: () => BigInt(clock.now()),
      logger,
      ...(options.fiscalWorkerOptions ?? {}),
    });
    fiscalService = new HubFiscalService({
      store: fiscalStore,
      connection,
      driver: fiscalDriver,
      worker: fiscalWorker,
      rulesService,
      nowMs: () => BigInt(clock.now()),
      getOrganizationId: () => store.getActiveRuntimeContext()?.config.organizationId ?? null,
      logger,
    });
    // C1: Hub never injects `__testHooks` into SqliteSaleStore in production/server runtime
    saleStore = createSqliteSaleStore({
      connection,
      rulesEvaluator: rulesService.saleEvaluator,
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
      rulesEvaluator: rulesService.saleEvaluator,
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
    if (restoreOutcome.wasRestored) {
      await SqliteBackupService.executePostRestoreRebuildAndVerify({
        connection,
        backupDir,
        backupId: restoreOutcome.backupId,
        stockStore,
        customerStore,
        supplierStore,
        logger,
      });
    }
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
      resolveFiscalBlock: (ref) => fiscalService.receiptBlock(ref),
    });
    const reportStore = createSqliteReportStore({
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
    const reportService = new HubReportService(reportStore);
    const backupService = new SqliteBackupService({
      connection,
      dbPath: options.dbPath,
      backupDir,
    });
    const importCache = new CatalogImportCache();

    const safeStorage = options.safeStorage ?? new AesGcmSafeStorageAdapter();
    const idGen = new MonotonicUuidV7Generator({ clock, random });

    cloudStore = createSqliteCloudStore(connection, () => {
      const ctx = store.getActiveRuntimeContext();
      return ctx ? ctx.uow : null;
    });

    const getDeviceId = () => {
      const ctx = store.getActiveRuntimeContext();
      if (ctx) {
        return ctx.config.deviceId;
      }
      const row = connection.sqlite
        .prepare('SELECT device_id FROM local_device_state LIMIT 1')
        .get() as { device_id: string } | undefined;
      if (row?.device_id) {
        return parseUuidV7(row.device_id);
      }
      throw new DomainError('DEVICE_NOT_INITIALIZED', 'Qurilma holati topilmadi');
    };

    cloudService = new HubCloudService({
      cloudStore,
      safeStorage,
      getDeviceId,
      clock,
      idGen,
      fetchFn: options.cloudFetchFn,
    });

    const outboxStore = new SqliteOutboxSyncStore(connection);
    const pushWorker = new HubSyncPushWorker({
      outboxStore,
      cloudStore,
      safeStorage,
      getDeviceId,
      clock,
      idGen,
      fetchFn: options.cloudFetchFn,
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
      reportService,
      backupService,
      catalogStore,
      stockStore,
      importCache,
      cloudService,
      taxSettingsStore,
    );
    registerRulesRoutes(app, authService, rulesService, cartService, () => BigInt(clock.now()));
    registerFiscalRoutes(app, authService, fiscalService);
    options.registerExtraTestRoutes?.(app);

    let boundPort: number | null = securityConfig.port > 0 ? securityConfig.port : null;

    return {
      app,
      connection,
      store,
      catalogStore,
      taxSettingsStore,
      rulesStore,
      rulesService,
      fiscalStore,
      fiscalService,
      fiscalWorker,
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
      reportStore,
      reportService,
      backupService,
      importCache,
      cloudStore,
      cloudService,
      outboxStore,
      pushWorker,
      safeStorage,
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
        // R6: Automatically start outbox push worker when hub listens
        pushWorker.start();
        fiscalWorker.start();
        return {
          host: DEFAULT_HUB_HOST,
          port: boundPort ?? securityConfig.port,
        };
      },
      async close() {
        try {
          pushWorker.stop();
          fiscalWorker.stop();
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
