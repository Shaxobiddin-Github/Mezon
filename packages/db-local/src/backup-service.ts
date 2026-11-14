import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  DomainError,
  type UnixMs,
  type UuidV7,
  parseUuidV7,
  unixMsFromBigInt,
} from '@mezon/domain';
import Database from 'better-sqlite3';
import type { LocalSqliteConnection } from './connection.js';
import { localCarts, shifts } from './schema/index.js';
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
   * R2 + R3: Executes database restore safely BEFORE main hub connections open.
   * Can be called on hub startup or in controlled lifecycle restart.
   */
  public static executeStagedRestoreIfPending(options: {
    readonly dbPath: string;
    readonly backupDir: string;
  }): boolean {
    const stagingPath = path.join(options.backupDir, 'pending-restore.json');
    if (!fs.existsSync(stagingPath)) {
      return false;
    }

    const raw = fs.readFileSync(stagingPath, 'utf8');
    const intent = JSON.parse(raw) as { readonly backupId: string };
    const backupDbPath = path.join(options.backupDir, `${intent.backupId}.db`);
    if (!fs.existsSync(backupDbPath)) {
      fs.unlinkSync(stagingPath);
      throw new DomainError(
        'VALIDATION_ERROR',
        `Pending restore backup file missing: ${intent.backupId}.db`,
      );
    }

    // 1. Take safety pre-restore backup of current db if it exists
    if (fs.existsSync(options.dbPath)) {
      const safetyBackupPath = path.join(options.backupDir, `pre-restore-safety-${Date.now()}.db`);
      fs.copyFileSync(options.dbPath, safetyBackupPath);

      // R3: Read all monotonic sequence counters from current database
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

      try {
        const curDb = new Database(options.dbPath, { readonly: true });
        try {
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
        } finally {
          curDb.close();
        }
      } catch {
        // If current DB was corrupted or unreadable, safety backup is preserved
      }

      // 2. Overwrite main DB file with backup
      fs.copyFileSync(backupDbPath, options.dbPath);
      // Clean up wal/shm if present
      const walPath = `${options.dbPath}-wal`;
      const shmPath = `${options.dbPath}-shm`;
      if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
      if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);

      // 3. R3: In the restored database, advance counters to max(restored, current)
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

            restoredDb
              .prepare(
                `UPDATE "local_device_state"
                 SET "last_device_seq" = ?,
                     "last_receipt_seq" = ?,
                     "last_return_seq" = ?,
                     "last_shift_seq" = ?,
                     "last_order_seq" = ?,
                     "last_receiving_seq" = ?,
                     "last_supplier_return_seq" = ?`,
              )
              .run(
                maxDeviceSeq,
                maxReceiptSeq,
                maxReturnSeq,
                maxShiftSeq,
                maxOrderSeq,
                maxReceivingSeq,
                maxSupReturnSeq,
              );
          }
        } finally {
          restoredDb.close();
        }
      }
    } else {
      fs.copyFileSync(backupDbPath, options.dbPath);
    }

    // 4. Remove staging file
    fs.unlinkSync(stagingPath);
    return true;
  }
}
