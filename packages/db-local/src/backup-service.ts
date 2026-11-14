import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  DomainError,
  MonotonicUuidV7Generator,
  type UnixMs,
  type UuidV7,
  parseUuidV7,
  unixMsFromBigInt,
} from '@mezon/domain';
import Database from 'better-sqlite3';
import type { LocalSqliteConnection } from './connection.js';
import { localCarts, shifts } from './schema/index.js';
import {
  rebuildStockProjections,
  type RebuildStockProjectionsResult,
  type SqliteStockStore,
} from './stock-repo.js';
import { SqliteCustomerStore, type RebuildCustomerBalancesOutcome } from './customer-repo.js';
import { SqliteSupplierStore, type RebuildSupplierBalancesOutcome } from './supplier-repo.js';
import { eq, or } from 'drizzle-orm';

export interface BackupMetadata {
  readonly id: string;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly createdAtMs: UnixMs;
  readonly sha256: string;
  readonly reason: string;
  readonly actorUserId: UuidV7 | null;
  readonly salesCount: number;
  readonly totalNetSalesTiyin: bigint;
}

export interface StagedRestoreIntent {
  readonly backupId: string;
  readonly targetDbPath: string;
  readonly reason: string;
  readonly actorUserId: UuidV7;
  readonly stagedAtMs: UnixMs;
}

export interface StagedRestoreExecutionOutcome {
  readonly wasRestored: boolean;
  readonly backupId?: string;
  readonly safetyBackupPath?: string;
}

export interface PostRestoreRebuildResult {
  readonly stockResult: RebuildStockProjectionsResult | null;
  readonly customerResult: RebuildCustomerBalancesOutcome | null;
  readonly supplierResult: RebuildSupplierBalancesOutcome | null;
  readonly salesCount: number;
  readonly totalNetSalesTiyin: bigint;
}

export interface BackupServiceOptions {
  readonly connection: LocalSqliteConnection;
  readonly dbPath: string;
  readonly backupDir: string;
  readonly getActiveUserId?: () => UuidV7 | null;
}

export class SqliteBackupService {
  private readonly connection: LocalSqliteConnection;
  private readonly dbPath: string;
  private readonly backupDir: string;

  public constructor(options: BackupServiceOptions) {
    this.connection = options.connection;
    this.dbPath = options.dbPath;
    this.backupDir = options.backupDir;
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }
  }

  private sha256File(filePath: string): string {
    const fileBuffer = fs.readFileSync(filePath);
    return createHash('sha256').update(fileBuffer).digest('hex');
  }

  /**
   * Creates an online SQLite backup using better-sqlite3's non-blocking `backup()` API.
   * Safe with WAL mode: does not lock writers, does not disrupt POS sales.
   */
  public async createBackup(params?: {
    readonly reason?: string;
    readonly actorUserId?: UuidV7 | null;
  }): Promise<BackupMetadata> {
    const nowMs = BigInt(Date.now());
    const id = `backup-${nowMs}-${Math.random().toString(36).slice(2, 8)}`;
    const filename = `${id}.db`;
    const targetPath = path.join(this.backupDir, filename);
    const metaPath = path.join(this.backupDir, `${id}.meta.json`);

    // 1. Snapshot net sales summary from live DB before or during backup
    let salesCount = 0;
    let totalNetSalesTiyin = 0n;
    try {
      const summaryRow = this.connection.sqlite
        .prepare<[], { readonly count: unknown; readonly net_sales: unknown }>(
          `SELECT COUNT(DISTINCT "document_id") AS count, COALESCE(SUM("signed_final_total"), 0) AS net_sales
           FROM "v_sales_lines"`,
        )
        .get();
      if (summaryRow) {
        salesCount = Number(summaryRow.count ?? 0);
        totalNetSalesTiyin = BigInt(summaryRow.net_sales as string | number | bigint);
      }
    } catch {
      // v_sales_lines might not be queried if uninitialized
    }

    // 2. Perform SQLite online backup
    await this.connection.sqlite.backup(targetPath);

    // 3. Verify PRAGMA integrity_check on the generated backup file
    const verifyDb = new Database(targetPath, { readonly: true });
    try {
      const integrity = verifyDb.pragma('integrity_check', { simple: true }) as string;
      if (integrity !== 'ok') {
        throw new DomainError('VALIDATION_ERROR', `Backup integrity check failed: ${integrity}`);
      }
    } finally {
      verifyDb.close();
    }

    // 4. Compute SHA-256 and write metadata
    const stat = fs.statSync(targetPath);
    const sha256 = this.sha256File(targetPath);
    const meta: BackupMetadata = {
      id,
      filename,
      sizeBytes: stat.size,
      createdAtMs: unixMsFromBigInt(nowMs),
      sha256,
      reason: params?.reason ?? 'Manual backup',
      actorUserId: params?.actorUserId ?? null,
      salesCount,
      totalNetSalesTiyin,
    };

    fs.writeFileSync(
      metaPath,
      JSON.stringify(
        meta,
        (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v),
        2,
      ),
      'utf8',
    );

    // 5. Rotate backups keeping newest 10
    this.rotateBackups(10);

    return meta;
  }

  public listBackups(): readonly BackupMetadata[] {
    if (!fs.existsSync(this.backupDir)) return [];
    const files = fs.readdirSync(this.backupDir);
    const metaFiles = files.filter((f) => f.endsWith('.meta.json'));
    const result: BackupMetadata[] = [];

    for (const mf of metaFiles) {
      try {
        const content = fs.readFileSync(path.join(this.backupDir, mf), 'utf8');
        const parsed = JSON.parse(content) as Record<string, unknown>;
        result.push({
          id: String(parsed.id),
          filename: String(parsed.filename),
          sizeBytes: Number(parsed.sizeBytes),
          createdAtMs: unixMsFromBigInt(BigInt(parsed.createdAtMs as string | number)),
          sha256: String(parsed.sha256),
          reason: String(parsed.reason),
          actorUserId:
            typeof parsed.actorUserId === 'string' ? parseUuidV7(parsed.actorUserId) : null,
          salesCount: Number(parsed.salesCount ?? 0),
          totalNetSalesTiyin: BigInt((parsed.totalNetSalesTiyin as string | number) ?? 0),
        });
      } catch {
        // Skip corrupted meta file
      }
    }

    return result.sort((a, b) => (b.createdAtMs > a.createdAtMs ? 1 : -1));
  }

  public rotateBackups(maxKeep = 10): void {
    const list = this.listBackups();
    if (list.length <= maxKeep) return;
    const toRemove = list.slice(maxKeep);
    for (const b of toRemove) {
      const dbFile = path.join(this.backupDir, b.filename);
      const metaFile = path.join(this.backupDir, `${b.id}.meta.json`);
      if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
      if (fs.existsSync(metaFile)) fs.unlinkSync(metaFile);
    }
  }

  /**
   * R2: POST /backups/:id/restore records a staged restore intent.
   * Rejects with 409 CONFLICT if an active shift or active cart exists.
   */
  public stageRestore(params: {
    readonly backupId: string;
    readonly actorUserId: UuidV7;
    readonly reason?: string;
  }): { readonly staged: boolean; readonly backupId: string; readonly stagingFile: string } {
    const list = this.listBackups();
    const target = list.find((b) => b.id === params.backupId);
    if (!target) {
      throw new DomainError('VALIDATION_ERROR', `Backup "${params.backupId}" not found`);
    }

    // R2: Check active shift and active carts
    const openShift = this.connection.db
      .select({ id: shifts.id })
      .from(shifts)
      .where(eq(shifts.status, 'open'))
      .limit(1)
      .all()[0];
    if (openShift) {
      throw new DomainError(
        'SHIFT_ALREADY_OPEN',
        'Zaxiradan tiklash uchun avval ochiq smenani yoping (ochiq smena mavjud)',
      );
    }

    const openCart = this.connection.db
      .select({ id: localCarts.id })
      .from(localCarts)
      .where(or(eq(localCarts.status, 'open'), eq(localCarts.status, 'parked')))
      .limit(1)
      .all()[0];
    if (openCart) {
      throw new DomainError(
        'CART_NOT_OPEN',
        'Zaxiradan tiklash uchun avval barcha savatlarni yakunlang yoki bekor qiling',
      );
    }

    // Verify backup integrity before staging
    const backupDbPath = path.join(this.backupDir, target.filename);
    if (!fs.existsSync(backupDbPath)) {
      throw new DomainError('VALIDATION_ERROR', `Backup database file missing: ${target.filename}`);
    }
    const currentSha = this.sha256File(backupDbPath);
    if (currentSha !== target.sha256) {
      throw new DomainError(
        'VALIDATION_ERROR',
        'Backup SHA-256 hash mismatch: file may be corrupted',
      );
    }

    const intent: StagedRestoreIntent = {
      backupId: target.id,
      targetDbPath: this.dbPath,
      reason: params.reason ?? 'Restore requested by owner',
      actorUserId: params.actorUserId,
      stagedAtMs: unixMsFromBigInt(BigInt(Date.now())),
    };

    const stagingPath = path.join(this.backupDir, 'pending-restore.json');
    fs.writeFileSync(
      stagingPath,
      JSON.stringify(
        intent,
        (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v),
        2,
      ),
      'utf8',
    );

    return {
      staged: true,
      backupId: target.id,
      stagingFile: stagingPath,
    };
  }

  /**
   * R2 + R3 + B1 + B2 + B4: Executes database restore safely BEFORE main hub connections open.
   * Can be called on hub startup or in controlled lifecycle restart.
   */
  public static async executeStagedRestoreIfPending(options: {
    readonly dbPath: string;
    readonly backupDir: string;
  }): Promise<StagedRestoreExecutionOutcome> {
    const stagingPath = path.join(options.backupDir, 'pending-restore.json');
    if (!fs.existsSync(stagingPath)) {
      return { wasRestored: false };
    }

    const raw = fs.readFileSync(stagingPath, 'utf8');
    const intent = JSON.parse(raw) as { readonly backupId: string };
    const backupDbPath = path.join(options.backupDir, `${intent.backupId}.db`);
    const backupMetaPath = path.join(options.backupDir, `${intent.backupId}.meta.json`);

    if (!fs.existsSync(backupDbPath)) {
      fs.unlinkSync(stagingPath);
      throw new DomainError(
        'VALIDATION_ERROR',
        `Pending restore backup file missing: ${intent.backupId}.db`,
      );
    }

    // B2: 1. Validate backup file SHA-256 against meta.json if present
    if (fs.existsSync(backupMetaPath)) {
      try {
        const metaRaw = fs.readFileSync(backupMetaPath, 'utf8');
        const meta = JSON.parse(metaRaw) as { readonly sha256?: string };
        if (meta.sha256) {
          const backupBuf = fs.readFileSync(backupDbPath);
          const actualSha256 = createHash('sha256').update(backupBuf).digest('hex');
          if (actualSha256 !== meta.sha256) {
            fs.unlinkSync(stagingPath);
            throw new DomainError(
              'VALIDATION_ERROR',
              `Backup file checksum mismatch: expected ${meta.sha256}, got ${actualSha256}`,
            );
          }
        }
      } catch (err) {
        if (err instanceof DomainError) throw err;
        fs.unlinkSync(stagingPath);
        throw new DomainError('VALIDATION_ERROR', `Failed reading backup metadata: ${String(err)}`);
      }
    }

    // B2: 2. Validate backup file integrity_check BEFORE touching current database
    try {
      const chkDb = new Database(backupDbPath, { readonly: true });
      try {
        const rows = chkDb.pragma('integrity_check') as Array<{ integrity_check: string }>;
        if (!rows || rows.length === 0 || rows[0]?.integrity_check !== 'ok') {
          fs.unlinkSync(stagingPath);
          throw new DomainError(
            'VALIDATION_ERROR',
            `Backup file integrity check failed: ${rows?.[0]?.integrity_check ?? 'unknown'}`,
          );
        }
      } finally {
        chkDb.close();
      }
    } catch (err) {
      if (err instanceof DomainError) throw err;
      fs.unlinkSync(stagingPath);
      throw new DomainError('VALIDATION_ERROR', `Backup file corrupted: ${String(err)}`);
    }

    // B1: 3. Take safety pre-restore backup of current db with FULL WAL consistency
    let safetyBackupPath: string | undefined;
    let currentCounters: {
      last_device_seq: bigint;
      last_receipt_seq: bigint;
      last_return_seq: bigint;
      last_shift_seq: bigint;
      last_order_seq: bigint;
      last_receiving_seq: bigint;
      last_supplier_return_seq: bigint;
      last_hlc: string;
      last_uuid_ms: bigint;
    } | null = null;

    if (fs.existsSync(options.dbPath)) {
      safetyBackupPath = path.join(options.backupDir, `pre-restore-safety-${Date.now()}.db`);
      const curDb = new Database(options.dbPath);
      try {
        // B1: Checkpoint WAL so any uncheckpointed commits in -wal are flushed into main file
        curDb.pragma('wal_checkpoint(TRUNCATE)');

        // Read active monotonic counters before replacement
        const row = curDb
          .prepare<[], Record<string, unknown>>('SELECT * FROM "local_device_state" LIMIT 1')
          .get();
        if (row) {
          currentCounters = {
            last_device_seq: BigInt((row.last_device_seq as string | number) ?? 0),
            last_receipt_seq: BigInt((row.last_receipt_seq as string | number) ?? 0),
            last_return_seq: BigInt((row.last_return_seq as string | number) ?? 0),
            last_shift_seq: BigInt((row.last_shift_seq as string | number) ?? 0),
            last_order_seq: BigInt((row.last_order_seq as string | number) ?? 0),
            last_receiving_seq: BigInt((row.last_receiving_seq as string | number) ?? 0),
            last_supplier_return_seq: BigInt(
              (row.last_supplier_return_seq as string | number) ?? 0,
            ),
            last_hlc: typeof row.last_hlc === 'string' ? row.last_hlc : '',
            last_uuid_ms: BigInt((row.last_uuid_ms as string | number) ?? 0),
          };
        }

        // B1: Complete backup using better-sqlite3 backup API
        await curDb.backup(safetyBackupPath);
      } finally {
        curDb.close();
      }

      // B1: Verify safety backup integrity
      const sDb = new Database(safetyBackupPath, { readonly: true });
      try {
        const sRows = sDb.pragma('integrity_check') as Array<{ integrity_check: string }>;
        if (!sRows || sRows.length === 0 || sRows[0]?.integrity_check !== 'ok') {
          fs.unlinkSync(stagingPath);
          throw new DomainError(
            'VALIDATION_ERROR',
            `Pre-restore safety backup integrity failed: ${sRows?.[0]?.integrity_check ?? 'unknown'}`,
          );
        }
      } finally {
        sDb.close();
      }
    }

    // B2: 4. Atomic file replacement via temporary file
    const tempRestorePath = `${options.dbPath}.restore-tmp-${Date.now()}`;
    fs.copyFileSync(backupDbPath, tempRestorePath);

    // Clean up wal/shm if present before replacing db
    const walPath = `${options.dbPath}-wal`;
    const shmPath = `${options.dbPath}-shm`;
    if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
    if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);

    if (fs.existsSync(options.dbPath)) {
      fs.unlinkSync(options.dbPath);
    }
    fs.renameSync(tempRestorePath, options.dbPath);

    // B4 + R3: 5. Advance counters in restored database to max(restored, current)
    if (currentCounters) {
      const restoredDb = new Database(options.dbPath);
      try {
        const restRow = restoredDb
          .prepare<[], Record<string, unknown>>('SELECT * FROM "local_device_state" LIMIT 1')
          .get();
        if (restRow) {
          const maxDeviceSeq =
            currentCounters.last_device_seq >
            BigInt((restRow.last_device_seq as string | number) ?? 0)
              ? currentCounters.last_device_seq
              : BigInt((restRow.last_device_seq as string | number) ?? 0);
          const maxReceiptSeq =
            currentCounters.last_receipt_seq >
            BigInt((restRow.last_receipt_seq as string | number) ?? 0)
              ? currentCounters.last_receipt_seq
              : BigInt((restRow.last_receipt_seq as string | number) ?? 0);
          const maxReturnSeq =
            currentCounters.last_return_seq >
            BigInt((restRow.last_return_seq as string | number) ?? 0)
              ? currentCounters.last_return_seq
              : BigInt((restRow.last_return_seq as string | number) ?? 0);
          const maxShiftSeq =
            currentCounters.last_shift_seq >
            BigInt((restRow.last_shift_seq as string | number) ?? 0)
              ? currentCounters.last_shift_seq
              : BigInt((restRow.last_shift_seq as string | number) ?? 0);
          const maxOrderSeq =
            currentCounters.last_order_seq >
            BigInt((restRow.last_order_seq as string | number) ?? 0)
              ? currentCounters.last_order_seq
              : BigInt((restRow.last_order_seq as string | number) ?? 0);
          const maxReceivingSeq =
            currentCounters.last_receiving_seq >
            BigInt((restRow.last_receiving_seq as string | number) ?? 0)
              ? currentCounters.last_receiving_seq
              : BigInt((restRow.last_receiving_seq as string | number) ?? 0);
          const maxSupReturnSeq =
            currentCounters.last_supplier_return_seq >
            BigInt((restRow.last_supplier_return_seq as string | number) ?? 0)
              ? currentCounters.last_supplier_return_seq
              : BigInt((restRow.last_supplier_return_seq as string | number) ?? 0);

          const restHlc = typeof restRow.last_hlc === 'string' ? restRow.last_hlc : '';
          const maxHlc = currentCounters.last_hlc > restHlc ? currentCounters.last_hlc : restHlc;

          const restUuidMs = BigInt((restRow.last_uuid_ms as string | number) ?? 0);
          const maxUuidMs =
            currentCounters.last_uuid_ms > restUuidMs ? currentCounters.last_uuid_ms : restUuidMs;

          restoredDb
            .prepare(
              `UPDATE "local_device_state"
               SET "last_device_seq" = ?,
                   "last_receipt_seq" = ?,
                   "last_return_seq" = ?,
                   "last_shift_seq" = ?,
                   "last_order_seq" = ?,
                   "last_receiving_seq" = ?,
                   "last_supplier_return_seq" = ?,
                   "last_hlc" = ?,
                   "last_uuid_ms" = ?`,
            )
            .run(
              maxDeviceSeq,
              maxReceiptSeq,
              maxReturnSeq,
              maxShiftSeq,
              maxOrderSeq,
              maxReceivingSeq,
              maxSupReturnSeq,
              maxHlc,
              maxUuidMs,
            );
        }
      } finally {
        restoredDb.close();
      }
    }

    // 6. Remove staging file
    fs.unlinkSync(stagingPath);
    return {
      wasRestored: true,
      backupId: intent.backupId,
      safetyBackupPath,
    };
  }

  /**
   * B3: Rebuilds stock, customer, and supplier projections post-restore and validates parity.
   */
  public static async executePostRestoreRebuildAndVerify(options: {
    readonly connection: LocalSqliteConnection;
    readonly backupDir: string;
    readonly backupId?: string;
    readonly stockStore?: SqliteStockStore;
    readonly customerStore?: SqliteCustomerStore;
    readonly supplierStore?: SqliteSupplierStore;
    readonly logger?: {
      info: (...args: unknown[]) => void;
      warn: (...args: unknown[]) => void;
      error: (...args: unknown[]) => void;
    };
  }): Promise<PostRestoreRebuildResult> {
    let stockResult: RebuildStockProjectionsResult | null = null;
    let customerResult: RebuildCustomerBalancesOutcome | null = null;
    let supplierResult: RebuildSupplierBalancesOutcome | null = null;

    const cfg = options.connection.sqlite
      .prepare<[], { organization_id: string; store_id: string }>(
        'SELECT "organization_id", "store_id" FROM "local_hub_config" WHERE "singleton_guard" = 1',
      )
      .get();

    // 1. Rebuild stock projections
    if (options.stockStore) {
      stockResult = await options.stockStore.rebuildProjections();
    } else if (cfg) {
      const orgId = parseUuidV7(cfg.organization_id);
      const strId = parseUuidV7(cfg.store_id);
      const idGen = new MonotonicUuidV7Generator({
        clock: { now: () => unixMsFromBigInt(BigInt(Date.now())) },
        random: { nextBytes: (length) => new Uint8Array(length) },
      });
      stockResult = await rebuildStockProjections(options.connection, {
        organizationId: orgId,
        storeId: strId,
        nextId: () => idGen.nextId(),
        nowUnixMs: () => unixMsFromBigInt(BigInt(Date.now())),
      });
    }

    // 2. Rebuild customer balances
    if (options.customerStore) {
      customerResult = await options.customerStore.rebuildCustomerBalances();
    } else {
      const custStore = new SqliteCustomerStore({
        connection: options.connection,
        getRuntimeContext: () => null,
      });
      customerResult = await custStore.rebuildCustomerBalances(
        cfg ? parseUuidV7(cfg.organization_id) : undefined,
      );
    }

    // 3. Rebuild supplier balances
    if (options.supplierStore) {
      supplierResult = await options.supplierStore.rebuildSupplierBalances();
    } else {
      const supStore = new SqliteSupplierStore({
        connection: options.connection,
        getRuntimeContext: () => null,
      });
      supplierResult = await supStore.rebuildSupplierBalances(
        cfg ? parseUuidV7(cfg.organization_id) : undefined,
      );
    }

    // 4. Parity check: Verify derived projections match ledger sums
    // 4a. Customer balances: sum(amount_delta) from customer_ledger == balance in local_customer_balances
    const customerDiscrepancies = options.connection.sqlite
      .prepare<[], { customer_id: string; balance: unknown; ledger_sum: unknown }>(
        `SELECT b.customer_id, b.balance as balance, COALESCE(SUM(l.amount_delta), 0) as ledger_sum
         FROM "local_customer_balances" b
         LEFT JOIN "customer_ledger" l ON l.customer_id = b.customer_id
         GROUP BY b.customer_id
         HAVING b.balance != COALESCE(SUM(l.amount_delta), 0)`,
      )
      .all();
    if (customerDiscrepancies.length > 0) {
      options.logger?.error('Post-restore customer projection/ledger parity mismatch!', {
        discrepancies: customerDiscrepancies,
      });
      throw new DomainError(
        'VALIDATION_ERROR',
        `Post-restore customer balance parity mismatch for ${customerDiscrepancies.length} customers`,
      );
    }

    // 4b. Supplier balances: sum(amount_delta) from supplier_ledger == balance in local_supplier_balances
    const supplierDiscrepancies = options.connection.sqlite
      .prepare<[], { supplier_id: string; balance: unknown; ledger_sum: unknown }>(
        `SELECT b.supplier_id, b.balance as balance, COALESCE(SUM(l.amount_delta), 0) as ledger_sum
         FROM "local_supplier_balances" b
         LEFT JOIN "supplier_ledger" l ON l.supplier_id = b.supplier_id
         GROUP BY b.supplier_id
         HAVING b.balance != COALESCE(SUM(l.amount_delta), 0)`,
      )
      .all();
    if (supplierDiscrepancies.length > 0) {
      options.logger?.error('Post-restore supplier projection/ledger parity mismatch!', {
        discrepancies: supplierDiscrepancies,
      });
      throw new DomainError(
        'VALIDATION_ERROR',
        `Post-restore supplier balance parity mismatch for ${supplierDiscrepancies.length} suppliers`,
      );
    }

    // 4c. Stock balances: sum(qty_delta) from stock_moves == qty_on_hand in local_stock_balances
    const stockDiscrepancies = options.connection.sqlite
      .prepare<[], { product_id: string; qty_on_hand: unknown; move_sum: unknown }>(
        `SELECT b.product_id, b.qty_on_hand, COALESCE(SUM(m.qty_delta), 0) as move_sum
         FROM "local_stock_balances" b
         LEFT JOIN "stock_moves" m ON m.product_id = b.product_id
         GROUP BY b.product_id
         HAVING b.qty_on_hand != COALESCE(SUM(m.qty_delta), 0)`,
      )
      .all();
    if (stockDiscrepancies.length > 0) {
      options.logger?.error('Post-restore stock projection/ledger parity mismatch!', {
        discrepancies: stockDiscrepancies,
      });
      throw new DomainError(
        'VALIDATION_ERROR',
        `Post-restore stock balance parity mismatch for ${stockDiscrepancies.length} products`,
      );
    }

    // 5. Verify against backup metadata if present
    let salesCount = 0;
    let totalNetSalesTiyin = 0n;
    try {
      const summaryRow = options.connection.sqlite
        .prepare<[], { count: unknown; net_sales: unknown }>(
          `SELECT COUNT(DISTINCT "document_id") AS count, COALESCE(SUM("signed_final_total"), 0) AS net_sales
           FROM "v_sales_lines"`,
        )
        .get();
      if (summaryRow) {
        salesCount = Number(summaryRow.count ?? 0);
        totalNetSalesTiyin = BigInt(summaryRow.net_sales as string | number | bigint);
      }
    } catch {
      // v_sales_lines might not be queried if empty
    }

    if (options.backupId) {
      const metaPath = path.join(options.backupDir, `${options.backupId}.meta.json`);
      if (fs.existsSync(metaPath)) {
        const metaRaw = fs.readFileSync(metaPath, 'utf8');
        const meta = JSON.parse(metaRaw) as {
          readonly salesCount?: number;
          readonly totalNetSalesTiyin?: string | number;
        };
        const expectedSalesCount = Number(meta.salesCount ?? 0);
        const expectedNetSalesTiyin = BigInt(meta.totalNetSalesTiyin ?? 0);

        if (salesCount !== expectedSalesCount || totalNetSalesTiyin !== expectedNetSalesTiyin) {
          options.logger?.error('Post-restore backup metadata sales totals mismatch!', {
            expectedSalesCount,
            actualSalesCount: salesCount,
            expectedNetSalesTiyin: expectedNetSalesTiyin.toString(),
            actualNetSalesTiyin: totalNetSalesTiyin.toString(),
          });
          throw new DomainError(
            'VALIDATION_ERROR',
            `Post-restore sales total mismatch: expected ${expectedNetSalesTiyin} tiyin across ${expectedSalesCount} sales, but got ${totalNetSalesTiyin} tiyin across ${salesCount} sales`,
          );
        }
        options.logger?.info('Post-restore parity check passed against backup metadata', {
          salesCount,
          totalNetSalesTiyin: totalNetSalesTiyin.toString(),
        });
      }
    }

    return {
      stockResult,
      customerResult,
      supplierResult,
      salesCount,
      totalNetSalesTiyin,
    };
  }
}
