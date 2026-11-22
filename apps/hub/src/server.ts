import { HubUpdateGate, registerUpdateGate } from './update-gate.js';
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
  runInRegisterScope,
  readDemoModeSync,
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
  FakeMarkingDriver,
  FakePaymentDriver,
  type PaymentDriver,
  type MarkingDriver,
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
import { HubLicenceService } from './licence-service.js';
import { registerLicenceRoutes } from './licence-routes.js';
import { PRODUCTION_TRUSTED_LICENCE_KEYS, type TrustedLicenceKey } from '@mezon/licensing';
import { HubSyncPullService } from './sync-pull-service.js';
import { HubSyncPullWorker } from './sync-pull-worker.js';
import { registerFiscalRoutes } from './fiscal-routes.js';
import { registerAuditRoutes } from './audit-routes.js';
import { registerMarkingRoutes } from './marking-routes.js';
import {
  type LanListener,
  newLanProxySecret,
  registerLanRoutes,
  registerLanTrustHook,
  terminalIdOf,
  startLanListener,
} from './lan-server.js';
import { HubLanService } from './lan-service.js';
import { registerPaymentRoutes } from './payment-routes.js';
import { registerDemoRoutes } from './demo-routes.js';
import { HubPaymentService } from './payment-service.js';
import { HubMarkingService } from './marking-service.js';
import { registerSyncConflictRoutes } from './sync-conflicts-routes.js';
import { HubSyncConflictService } from './sync-conflicts-service.js';
import { HubCloudParkedService } from './sync-cloud-parked.js';
import { HubSyncBootstrap } from './sync-bootstrap.js';
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
  /** TEST/DI ONLY (T4.7): trusted licence public keys; production uses the built-in list. */
  readonly trustedLicenceKeys?: readonly TrustedLicenceKey[];
  /**
   * T3.3 fiscal driver (DI). Only `FakeFiscalDriver` exists until T3.5 (§3.3); the default is a fake
   * driver whose ledger lives next to the database so it survives restarts.
   */
  readonly fiscalDriver?: FiscalDriver;
  /**
   * v1 (T4.1 in the desktop app): fixed port of the HTTPS LAN listener. When set, the listener
   * starts on demand: when the owner creates a terminal pairing code, and at `listen()` if paired
   * terminals exist. Left unset (tests), the listener starts only through `listenLan`.
   */
  readonly lanPort?: number;
  /** T3.7 marking operator port; default: the Fake (no real operator until T3.0). */
  readonly markingDriver?: MarkingDriver;
  /** T3.6 QR payment provider port; default: the Fake (no real provider until T3.0). */
  readonly paymentDriver?: PaymentDriver;
  /** T3.6 QR lifetime override (tests). */
  readonly paymentQrTtlMs?: bigint;
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
  /** T4.8: closed while an update is prepared; refuses starting new receipt work. */
  readonly updateGate: HubUpdateGate;
  readonly importCache: CatalogImportCache;
  readonly cloudStore: SqliteCloudStore;
  readonly cloudService: HubCloudService;
  readonly outboxStore: SqliteOutboxSyncStore;
  readonly pushWorker: HubSyncPushWorker;
  readonly pullService: HubSyncPullService;
  readonly pullWorker: HubSyncPullWorker;
  readonly safeStorage: SafeStoragePort;
  readonly lanService: HubLanService;
  /** T4.1: starts the HTTPS LAN listener for paired terminals (default host 0.0.0.0). */
  listenLan(options: { readonly host?: string; readonly port: number }): Promise<LanListener>;
  listen(): Promise<{ readonly host: typeof DEFAULT_HUB_HOST; readonly port: number }>;
  close(): Promise<void>;
}

export async function createHubServer(options: CreateHubServerOptions): Promise<HubServer> {
  if (options.trustedLicenceKeys !== undefined && process.env.NODE_ENV === 'production') {
    throw new Error(
      'trustedLicenceKeys is a test/DI-only option and must not be set in production',
    );
  }
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
  /** V2 demo mode (owner switch in `local_hub_config`); read on every use, never cached. */
  const isDemoMode = (): boolean => readDemoModeSync(connection.sqlite);
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
  let lanServiceRef: HubLanService | null = null;
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
      isDemoMode,
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
          ? {
              uow: ctx.uow,
              organizationId: ctx.config.organizationId,
              storeId: ctx.config.storeId,
              deviceId: ctx.config.deviceId,
            }
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
      isDemoMode,
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
      resolveTerminalPrinter: (terminalId) => lanServiceRef?.terminalPrinter(terminalId) ?? null,
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

    const licenceService = new HubLicenceService({
      cloud: cloudService,
      cachePath: path.join(path.dirname(options.dbPath), 'licence-cache.json'),
      trustedKeys: options.trustedLicenceKeys ?? PRODUCTION_TRUSTED_LICENCE_KEYS,
      verifier: nodeEd25519RulesVerifier,
      nowMs: () => BigInt(clock.now()),
      fetchFn: options.cloudFetchFn,
      logger,
    });

    const outboxStore = new SqliteOutboxSyncStore(connection);
    const pullService = new HubSyncPullService(connection, idGen);
    const pullWorker = new HubSyncPullWorker({
      pullService,
      cloudStore,
      safeStorage,
      getDeviceId,
      clock,
      idGen,
      fetchFn: options.cloudFetchFn,
    });
    const pushWorker = new HubSyncPushWorker({
      outboxStore,
      cloudStore,
      safeStorage,
      getDeviceId,
      clock,
      idGen,
      fetchFn: options.cloudFetchFn,
      pullWorker,
    });

    app = Fastify({
      loggerInstance: logger as unknown as FastifyBaseLogger,
    });

    const hostState = createHostAllowlistState(securityConfig.port);
    registerHubSecurityHooks(app, securityConfig, hostState);
    const lanProxySecret = newLanProxySecret();
    registerLanTrustHook(app, lanProxySecret);
    // T4.2 (variant B): the rest of the request runs as work of its cash register: the verified LAN
    // terminal (set by the trust hook above, never from the body) or null = the hub's own register.
    app.addHook('onRequest', (request, _reply, done) => {
      runInRegisterScope(terminalIdOf(request), done);
    });
    const lanService = new HubLanService({
      connection,
      safeStorage,
      getOrganizationId: () => store.getActiveRuntimeContext()?.config.organizationId ?? null,
      nowMs: () => clock.now(),
      nextId: () => idGen.nextId(),
      terminalLimit: () => licenceService.lanTerminalLimit(),
    });
    lanServiceRef = lanService;
    let lanListener: LanListener | null = null;
    let lanStarting: Promise<LanListener> | null = null;
    const startLan = (lanOptions: {
      readonly host?: string;
      readonly port: number;
    }): Promise<LanListener> => {
      if (lanListener !== null) return Promise.resolve(lanListener);
      lanStarting ??= startLanListener({
        mainApp: app,
        lanService,
        host: lanOptions.host ?? '0.0.0.0',
        port: lanOptions.port,
        loopbackHost: () =>
          [...hostState.getAllowedHosts()][0] ?? `127.0.0.1:${securityConfig.port}`,
        proxySecret: lanProxySecret,
      }).then(
        (l) => {
          lanListener = l;
          return l;
        },
        (err: unknown) => {
          lanStarting = null; // e.g. port busy: the next pairing-code request retries
          throw err;
        },
      );
      return lanStarting;
    };
    const lanPort = options.lanPort;
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
    const markingDriver = options.markingDriver ?? new FakeMarkingDriver();
    const paymentDriver = options.paymentDriver ?? new FakePaymentDriver();
    registerDemoRoutes(app, authService, {
      connection,
      rulesService,
      drivers: {
        fiscal: {
          driverId: fiscalService.driver.driverId,
          isTestDriver: fiscalService.driver.isTestDriver,
        },
        payment: { driverId: paymentDriver.driverId, isTestDriver: paymentDriver.isTestDriver },
        marking: { driverId: markingDriver.driverId, isTestDriver: markingDriver.isTestDriver },
      },
      getOrganizationId: () => store.getActiveRuntimeContext()?.config.organizationId ?? null,
      nowMs: () => clock.now(),
      nextId: () => idGen.nextId(),
      demoCatalog: { catalogService, stockService, customerService },
    });
    registerMarkingRoutes(
      app,
      authService,
      new HubMarkingService({
        connection,
        cartStore,
        catalogStore,
        driver: markingDriver,
        getContext: () => {
          const ctx = store.getActiveRuntimeContext();
          return ctx
            ? { organizationId: ctx.config.organizationId, storeId: ctx.config.storeId }
            : null;
        },
        nowMs: () => clock.now(),
        nextId: () => idGen.nextId(),
      }),
      cartService,
    );
    registerPaymentRoutes(
      app,
      authService,
      new HubPaymentService({
        connection,
        driver: paymentDriver,
        isDemoMode,
        getContext: () => {
          const ctx = store.getActiveRuntimeContext();
          return ctx
            ? { organizationId: ctx.config.organizationId, storeId: ctx.config.storeId }
            : null;
        },
        nowMs: () => clock.now(),
        nextId: () => idGen.nextId(),
        ...(options.paymentQrTtlMs !== undefined ? { ttlMs: options.paymentQrTtlMs } : {}),
      }),
    );
    registerLanRoutes(
      app,
      authService,
      lanService,
      lanPort === undefined
        ? undefined
        : {
            ensureListening: async () => (await startLan({ port: lanPort })).port,
            listeningPort: () => lanListener?.port ?? null,
          },
    );
    registerAuditRoutes(
      app,
      authService,
      connection,
      () => store.getActiveRuntimeContext()?.config.organizationId ?? null,
    );
    registerLicenceRoutes(app, authService, licenceService);
    const updateGate = new HubUpdateGate();
    registerUpdateGate(app, updateGate);
    registerSyncConflictRoutes(
      app,
      authService,
      new HubSyncConflictService({
        connection,
        pullService,
        getContext: () => {
          const ctx = store.getActiveRuntimeContext();
          return ctx
            ? {
                organizationId: ctx.config.organizationId,
                storeId: ctx.config.storeId,
                deviceId: ctx.config.deviceId,
              }
            : null;
        },
        nowMs: () => clock.now(),
      }),
      new HubCloudParkedService({
        connection,
        cloudStore,
        safeStorage,
        nowMs: () => clock.now(),
        fetchFn: options.cloudFetchFn,
      }),
      new HubSyncBootstrap({ connection, pullWorker, nowMs: () => clock.now() }),
    );
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
      updateGate,
      importCache,
      cloudStore,
      cloudService,
      outboxStore,
      pushWorker,
      pullService,
      pullWorker,
      safeStorage,
      lanService,
      listenLan: startLan,
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
        // R6 / T2.4: Automatically start push and pull workers when hub listens
        pushWorker.start();
        pullWorker.start();
        fiscalWorker.start();
        licenceService.start();
        if (lanPort !== undefined && lanService.hasActiveTerminals()) {
          // Paired terminals must reach the hub after a restart; a busy port must not stop the hub.
          await startLan({ port: lanPort }).catch((err: unknown) => {
            logger.error(
              { err: err instanceof Error ? err.message : String(err), port: lanPort },
              'hub_lan_listener_start_failed',
            );
          });
        }
        return {
          host: DEFAULT_HUB_HOST,
          port: boundPort ?? securityConfig.port,
        };
      },
      async close() {
        try {
          pushWorker.stop();
          pullWorker.stop();
          fiscalWorker.stop();
          if (lanListener !== null) await lanListener.close();
          licenceService.stop();
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
