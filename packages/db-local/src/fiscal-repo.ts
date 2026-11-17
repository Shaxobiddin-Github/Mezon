import {
  DomainError,
  FISCAL_DOC_UNSETTLED_STATES,
  type FiscalDocKind,
  type FiscalDocStatus,
  type UnixMs,
  type UuidV7,
  canVoidWithFiscalStatus,
  isFiscalDocStatus,
  unixMsFromBigInt,
} from '@mezon/domain';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { LocalSqliteConnection } from './connection.js';
import { fiscalDocs, localHubConfig, sales } from './schema/index.js';
import type { SqliteUnitOfWork, SqliteUnitOfWorkSession } from './uow.js';
import { insertMonotone, updateMonotone } from './writers.js';

export type FiscalGateAction = 'warn' | 'block';

const toAction = (v: string): FiscalGateAction => (v === 'block' ? 'block' : 'warn');

export interface FiscalHubConfig {
  readonly modeEnabled: boolean;
  readonly offlineWindowMs: bigint;
  /** S1: 'warn' (owner decision) or 'block' (future legal requirement only). */
  readonly offlineExpiredAction: FiscalGateAction;
  /** S4: 'warn' (owner decision) or 'block'. */
  readonly shiftNotOpenAction: FiscalGateAction;
  /** Raw JSON from configuration; validated by the hub (contracts) before printing. */
  readonly receiptFieldsJson: string;
  readonly driverId: string;
}

export interface StoredFiscalDocRecord {
  readonly id: UuidV7;
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7;
  readonly docKind: FiscalDocKind;
  readonly saleId: UuidV7 | null;
  readonly returnId: UuidV7 | null;
  readonly shiftId: UuidV7 | null;
  readonly dependsOnDocId: UuidV7 | null;
  readonly idempotencyKey: string;
  readonly status: FiscalDocStatus;
  readonly attempts: number;
  readonly nextCheckAtMs: UnixMs;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
  readonly sentAtMs: UnixMs | null;
  readonly confirmedAtMs: UnixMs | null;
  readonly cancelledAtMs: UnixMs | null;
  readonly fiscalSign: string | null;
  readonly fiscalNumber: string | null;
  readonly qrPayload: string | null;
  readonly driverId: string;
  readonly offlineDeadlineMs: UnixMs;
  readonly createdAtMs: UnixMs;
}

type FiscalDocRow = typeof fiscalDocs.$inferSelect;

function toRecord(row: FiscalDocRow): StoredFiscalDocRecord {
  if (!isFiscalDocStatus(row.status)) {
    throw new Error(`Unknown fiscal_docs.status "${row.status}"`);
  }
  return {
    id: row.id,
    organizationId: row.organizationId,
    storeId: row.storeId,
    docKind: row.docKind as FiscalDocKind,
    saleId: row.saleId,
    returnId: row.returnId,
    shiftId: row.shiftId,
    dependsOnDocId: row.dependsOnDocId,
    idempotencyKey: row.idempotencyKey,
    status: row.status,
    attempts: row.attempts,
    nextCheckAtMs: row.nextCheckAtMs,
    lastErrorCode: row.lastErrorCode,
    lastErrorMessage: row.lastErrorMessage,
    sentAtMs: row.sentAtMs,
    confirmedAtMs: row.confirmedAtMs,
    cancelledAtMs: row.cancelledAtMs,
    fiscalSign: row.fiscalSign,
    fiscalNumber: row.fiscalNumber,
    qrPayload: row.qrPayload,
    driverId: row.driverId,
    offlineDeadlineMs: row.offlineDeadlineMs,
    createdAtMs: row.createdAtMs,
  };
}

export function readFiscalHubConfigSync(db: BetterSQLite3Database): FiscalHubConfig {
  const row = db
    .select({
      on: localHubConfig.fiscalModeEnabled,
      window: localHubConfig.fiscalOfflineWindowMs,
      expAction: localHubConfig.fiscalOfflineExpiredAction,
      shiftAction: localHubConfig.fiscalShiftNotOpenAction,
      fields: localHubConfig.fiscalReceiptFieldsJson,
      driverId: localHubConfig.fiscalDriverId,
    })
    .from(localHubConfig)
    .limit(1)
    .all()[0];
  if (row === undefined) {
    return {
      modeEnabled: false,
      offlineWindowMs: 86_400_000n,
      offlineExpiredAction: 'warn',
      shiftNotOpenAction: 'warn',
      receiptFieldsJson: '[]',
      driverId: 'fake',
    };
  }
  return {
    modeEnabled: Boolean(row.on),
    offlineWindowMs: BigInt(row.window),
    offlineExpiredAction: toAction(row.expAction),
    shiftNotOpenAction: toAction(row.shiftAction),
    receiptFieldsJson: row.fields,
    driverId: row.driverId,
  };
}

export function getSaleFiscalDocSync(
  db: BetterSQLite3Database,
  saleId: UuidV7,
): StoredFiscalDocRecord | null {
  const row = db
    .select()
    .from(fiscalDocs)
    .where(and(eq(fiscalDocs.saleId, saleId), eq(fiscalDocs.docKind, 'sale')))
    .limit(1)
    .all()[0];
  return row ? toRecord(row) : null;
}

export function getFiscalDocByIdSync(
  db: BetterSQLite3Database,
  id: UuidV7,
): StoredFiscalDocRecord | null {
  const row = db.select().from(fiscalDocs).where(eq(fiscalDocs.id, id)).limit(1).all()[0];
  return row ? toRecord(row) : null;
}

/**
 * Offline deadline warning source (controller fix #2): the OLDEST unsettled document wins,
 * i.e. `min(offline_deadline_ms)` over every pending/sent/failed row.
 */
export function readOldestUnsettledDeadlineSync(
  db: BetterSQLite3Database,
  organizationId: UuidV7,
): UnixMs | null {
  const row = db
    .select({ min: sql<bigint | null>`min(${fiscalDocs.offlineDeadlineMs})` })
    .from(fiscalDocs)
    .where(
      and(
        eq(fiscalDocs.organizationId, organizationId),
        inArray(fiscalDocs.status, [...FISCAL_DOC_UNSETTLED_STATES]),
      ),
    )
    .all()[0];
  return row?.min === null || row?.min === undefined ? null : unixMsFromBigInt(BigInt(row.min));
}

export interface InsertFiscalDocInput {
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7;
  readonly kind: FiscalDocKind;
  readonly saleId: UuidV7 | null;
  readonly returnId: UuidV7 | null;
  readonly shiftId: UuidV7 | null;
  readonly dependsOnDocId: UuidV7 | null;
  readonly idempotencyKey: string;
}

/** Writes a `pending` document in the CALLER'S transaction (atomic with the sale/return/shift). */
export function insertFiscalDocInTxSync(
  session: SqliteUnitOfWorkSession,
  input: InsertFiscalDocInput,
): StoredFiscalDocRecord {
  const cfg = readFiscalHubConfigSync(session.db);
  const nowMs = session.nowUnixMs();
  const write = insertMonotone(session, fiscalDocs, {
    organizationId: input.organizationId,
    storeId: input.storeId,
    values: {
      docKind: input.kind,
      saleId: input.saleId,
      returnId: input.returnId,
      shiftId: input.shiftId,
      dependsOnDocId: input.dependsOnDocId,
      idempotencyKey: input.idempotencyKey,
      status: 'pending',
      attempts: 0,
      nextCheckAtMs: nowMs,
      lastErrorCode: null,
      lastErrorMessage: null,
      sentAtMs: null,
      confirmedAtMs: null,
      cancelledAtMs: null,
      fiscalSign: null,
      fiscalNumber: null,
      qrPayload: null,
      driverId: cfg.driverId,
      offlineDeadlineMs: unixMsFromBigInt(BigInt(nowMs) + cfg.offlineWindowMs),
    },
    eventType: 'fiscal_doc.created',
    schemaVersion: 1,
  });
  return toRecord(write.row);
}

/**
 * Sale path (§3.2 continuity): the sale never waits for the driver. In fiscal mode a `pending`
 * document is written in the sale transaction; the S1/S4 blocks apply only when their
 * configuration flags are on (owner decision pending, controller: warn-only by default).
 */
export function assertFiscalSaleAllowedInTxSync(
  session: SqliteUnitOfWorkSession,
  input: { readonly organizationId: UuidV7; readonly shiftId: UuidV7 },
): FiscalHubConfig {
  const cfg = readFiscalHubConfigSync(session.db);
  if (!cfg.modeEnabled) return cfg;
  const nowMs = BigInt(session.nowUnixMs());
  if (cfg.offlineExpiredAction === 'block') {
    const oldest = readOldestUnsettledDeadlineSync(session.db, input.organizationId);
    if (oldest !== null && BigInt(oldest) <= nowMs) {
      throw new DomainError('FISCAL_BLOCKED', 'Fiscal offline window expired', {
        details: { reason: 'FISCAL_OFFLINE_EXPIRED', deadlineMs: oldest.toString() },
      });
    }
  }
  if (cfg.shiftNotOpenAction === 'block') {
    const open = session.db
      .select({ status: fiscalDocs.status })
      .from(fiscalDocs)
      .where(and(eq(fiscalDocs.shiftId, input.shiftId), eq(fiscalDocs.docKind, 'shift_open')))
      .limit(1)
      .all()[0];
    if (open?.status !== 'confirmed') {
      throw new DomainError('FISCAL_BLOCKED', 'Fiscal shift is not open on the driver', {
        details: { reason: 'FISCAL_SHIFT_NOT_OPEN' },
      });
    }
  }
  return cfg;
}

export function insertSaleFiscalDocIfEnabledInTxSync(
  session: SqliteUnitOfWorkSession,
  input: { readonly organizationId: UuidV7; readonly storeId: UuidV7; readonly saleId: UuidV7 },
): StoredFiscalDocRecord | null {
  if (!readFiscalHubConfigSync(session.db).modeEnabled) return null;
  return insertFiscalDocInTxSync(session, {
    organizationId: input.organizationId,
    storeId: input.storeId,
    kind: 'sale',
    saleId: input.saleId,
    returnId: null,
    shiftId: null,
    dependsOnDocId: null,
    idempotencyKey: input.saleId,
  });
}

/**
 * Void gate (controller table): pending/failed/rejected → the document becomes `cancelled` in the
 * void transaction; sent/confirmed → `FISCALIZED_SALE_CANNOT_VOID` (only a return reverses it).
 */
export function cancelSaleFiscalDocForVoidInTxSync(
  session: SqliteUnitOfWorkSession,
  saleRow: typeof sales.$inferSelect,
): void {
  const doc = getSaleFiscalDocSync(session.db, saleRow.id);
  if (doc === null) return;
  if (!canVoidWithFiscalStatus(doc.status)) {
    throw new DomainError(
      'FISCALIZED_SALE_CANNOT_VOID',
      `Sale fiscal document is ${doc.status}; use a return instead of void`,
      { details: { fiscalStatus: doc.status } },
    );
  }
  updateMonotone(session, fiscalDocs, {
    id: doc.id,
    organizationId: doc.organizationId,
    storeId: doc.storeId,
    values: { status: 'cancelled', cancelledAtMs: session.nowUnixMs() },
    eventType: 'fiscal_doc.cancelled',
    schemaVersion: 1,
  });
}

/**
 * Refund path (S3, queue variant): a return of a sale whose document is not cancelled/rejected
 * gets a `pending` refund document that DEPENDS on the sale document. The return itself is never
 * blocked by fiscal state (§3.2).
 */
export function insertRefundFiscalDocIfNeededInTxSync(
  session: SqliteUnitOfWorkSession,
  input: {
    readonly organizationId: UuidV7;
    readonly storeId: UuidV7;
    readonly saleId: UuidV7;
    readonly returnId: UuidV7;
  },
): StoredFiscalDocRecord | null {
  const saleDoc = getSaleFiscalDocSync(session.db, input.saleId);
  if (saleDoc === null || saleDoc.status === 'cancelled' || saleDoc.status === 'rejected') {
    return null;
  }
  return insertFiscalDocInTxSync(session, {
    organizationId: input.organizationId,
    storeId: input.storeId,
    kind: 'refund',
    saleId: input.saleId,
    returnId: input.returnId,
    shiftId: null,
    dependsOnDocId: saleDoc.id,
    idempotencyKey: input.returnId,
  });
}

/** Fiscal shift open/close (controller fix #4): same queue, key `shift.id:open|close`. */
export function insertShiftFiscalDocIfEnabledInTxSync(
  session: SqliteUnitOfWorkSession,
  input: {
    readonly organizationId: UuidV7;
    readonly storeId: UuidV7;
    readonly shiftId: UuidV7;
    readonly op: 'open' | 'close';
  },
): StoredFiscalDocRecord | null {
  if (!readFiscalHubConfigSync(session.db).modeEnabled) return null;
  return insertFiscalDocInTxSync(session, {
    organizationId: input.organizationId,
    storeId: input.storeId,
    kind: input.op === 'open' ? 'shift_open' : 'shift_close',
    saleId: null,
    returnId: null,
    shiftId: input.shiftId,
    dependsOnDocId: null,
    idempotencyKey: `${input.shiftId}:${input.op}`,
  });
}

export interface FiscalRuntimeContext {
  readonly uow: SqliteUnitOfWork;
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7;
}

export interface FiscalDocListItem extends StoredFiscalDocRecord {
  readonly receiptCode: string | null;
}

export interface FiscalStatusSummary {
  readonly modeEnabled: boolean;
  readonly driverId: string;
  readonly counts: Readonly<Record<FiscalDocStatus, number>>;
  readonly oldestDeadlineMs: UnixMs | null;
  readonly offlineWindowMs: bigint;
  readonly offlineExpiredAction: FiscalGateAction;
  readonly shiftNotOpenAction: FiscalGateAction;
  /** S4 warning: an OPEN shift whose fiscal open is not confirmed on the driver yet. */
  readonly shiftNotOpenOnDriver: boolean;
}

/**
 * Worker/UI side of the fiscal queue. Every state change is its OWN transaction so `sent` is
 * durable (WAL, synchronous=FULL) BEFORE the driver is called.
 */
export class SqliteFiscalStore {
  private readonly connection: LocalSqliteConnection;
  private readonly getRuntimeContext: () => FiscalRuntimeContext | null;

  constructor(options: {
    readonly connection: LocalSqliteConnection;
    readonly getRuntimeContext: () => FiscalRuntimeContext | null;
  }) {
    this.connection = options.connection;
    this.getRuntimeContext = options.getRuntimeContext;
  }

  private ctx(): FiscalRuntimeContext | null {
    return this.getRuntimeContext();
  }

  private requireCtx(): FiscalRuntimeContext {
    const c = this.ctx();
    if (c === null) throw new DomainError('AUTH_UNAUTHORIZED', 'Hub setup has not been completed');
    return c;
  }

  readConfigSync(): FiscalHubConfig {
    return readFiscalHubConfigSync(this.connection.db);
  }

  getDocSync(id: UuidV7): StoredFiscalDocRecord | null {
    return getFiscalDocByIdSync(this.connection.db, id);
  }

  getSaleDocSync(saleId: UuidV7): StoredFiscalDocRecord | null {
    return getSaleFiscalDocSync(this.connection.db, saleId);
  }

  getReturnDocSync(returnId: UuidV7): StoredFiscalDocRecord | null {
    const row = this.connection.db
      .select()
      .from(fiscalDocs)
      .where(eq(fiscalDocs.returnId, returnId))
      .limit(1)
      .all()[0];
    return row ? toRecord(row) : null;
  }

  /**
   * Head of the fiscal queue: the OLDEST unsettled document (pending / sent / failed), strictly in
   * creation order (S4: shift open → receipts → shift close; S3: sale → refund). `null` when empty
   * or before setup.
   */
  headUnsettledSync(): StoredFiscalDocRecord | null {
    const c = this.ctx();
    if (c === null) return null;
    const row = this.connection.db
      .select()
      .from(fiscalDocs)
      .where(
        and(
          eq(fiscalDocs.organizationId, c.organizationId),
          inArray(fiscalDocs.status, ['pending', 'sent', 'failed']),
        ),
      )
      .orderBy(asc(fiscalDocs.createdAtMs), asc(fiscalDocs.id))
      .limit(1)
      .all()[0];
    return row ? toRecord(row) : null;
  }

  private update(
    doc: StoredFiscalDocRecord,
    values: Partial<typeof fiscalDocs.$inferInsert>,
    eventType: string,
  ): Promise<StoredFiscalDocRecord> {
    const { uow } = this.requireCtx();
    return uow.execute((session) => {
      const w = updateMonotone(session, fiscalDocs, {
        id: doc.id,
        organizationId: doc.organizationId,
        storeId: doc.storeId,
        values,
        eventType,
        schemaVersion: 1,
      });
      return Promise.resolve(toRecord(w.row));
    });
  }

  /** pending|failed → sent, committed BEFORE the driver call. `nextCheckAtMs` = when to ask status(). */
  markSent(doc: StoredFiscalDocRecord, nowMs: bigint, nextCheckAtMs: bigint) {
    return this.update(
      doc,
      {
        status: 'sent',
        attempts: doc.attempts + 1,
        sentAtMs: unixMsFromBigInt(nowMs),
        nextCheckAtMs: unixMsFromBigInt(nextCheckAtMs),
        lastErrorCode: null,
        lastErrorMessage: null,
      },
      'fiscal_doc.sent',
    );
  }

  markConfirmed(
    doc: StoredFiscalDocRecord,
    nowMs: bigint,
    c: { readonly fiscalSign: string; readonly fiscalNumber: string; readonly qrPayload: string },
  ) {
    return this.update(
      doc,
      {
        status: 'confirmed',
        confirmedAtMs: unixMsFromBigInt(nowMs),
        fiscalSign: c.fiscalSign,
        fiscalNumber: c.fiscalNumber,
        qrPayload: c.qrPayload,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
      'fiscal_doc.confirmed',
    );
  }

  markRejected(doc: StoredFiscalDocRecord, code: string, message: string) {
    return this.update(
      doc,
      { status: 'rejected', lastErrorCode: code, lastErrorMessage: message },
      'fiscal_doc.rejected',
    );
  }

  /** ONLY for a definitely-not-fiscalized outcome (controller F-A). */
  markFailed(doc: StoredFiscalDocRecord, code: string, message: string, nextCheckAtMs: bigint) {
    return this.update(
      doc,
      {
        status: 'failed',
        lastErrorCode: code,
        lastErrorMessage: message,
        nextCheckAtMs: unixMsFromBigInt(nextCheckAtMs),
      },
      'fiscal_doc.failed',
    );
  }

  /** Bookkeeping in place (outcome unknown stays `sent`; a waiting refund stays `pending`). */
  reschedule(doc: StoredFiscalDocRecord, nextCheckAtMs: bigint, code: string, message: string) {
    return this.update(
      doc,
      {
        nextCheckAtMs: unixMsFromBigInt(nextCheckAtMs),
        lastErrorCode: code,
        lastErrorMessage: message,
      },
      'fiscal_doc.rescheduled',
    );
  }

  cancel(doc: StoredFiscalDocRecord, nowMs: bigint) {
    return this.update(
      doc,
      { status: 'cancelled', cancelledAtMs: unixMsFromBigInt(nowMs) },
      'fiscal_doc.cancelled',
    );
  }

  /**
   * Manager "retry": puts a `failed` document at the head of the queue. It NEVER calls the driver,
   * so a double click cannot submit twice (controller fix #3).
   */
  async requeueFailed(id: UuidV7): Promise<StoredFiscalDocRecord> {
    const doc = this.getDocSync(id);
    if (doc === null) throw new DomainError('FISCAL_DOC_NOT_FOUND', 'Fiscal document not found');
    if (doc.status !== 'failed') {
      throw new DomainError('FISCAL_DOC_INVALID_STATE', `Only failed documents can be retried`, {
        details: { status: doc.status },
      });
    }
    const { uow } = this.requireCtx();
    return uow.execute((session) => {
      const w = updateMonotone(session, fiscalDocs, {
        id: doc.id,
        organizationId: doc.organizationId,
        storeId: doc.storeId,
        values: { nextCheckAtMs: unixMsFromBigInt(0n) },
        eventType: 'fiscal_doc.requeued',
        schemaVersion: 1,
      });
      return Promise.resolve(toRecord(w.row));
    });
  }

  listUnsettled(): readonly FiscalDocListItem[] {
    const c = this.ctx();
    if (c === null) return [];
    return this.connection.db
      .select({ doc: fiscalDocs, receiptCode: sales.receiptCode })
      .from(fiscalDocs)
      .leftJoin(sales, eq(sales.id, fiscalDocs.saleId))
      .where(
        and(
          eq(fiscalDocs.organizationId, c.organizationId),
          inArray(fiscalDocs.status, ['pending', 'sent', 'failed', 'rejected']),
        ),
      )
      .orderBy(asc(fiscalDocs.offlineDeadlineMs), asc(fiscalDocs.createdAtMs))
      .all()
      .map((r) => ({ ...toRecord(r.doc), receiptCode: r.receiptCode }));
  }

  summarySync(): FiscalStatusSummary {
    const cfg = this.readConfigSync();
    const counts: Record<FiscalDocStatus, number> = {
      pending: 0,
      sent: 0,
      confirmed: 0,
      failed: 0,
      rejected: 0,
      cancelled: 0,
    };
    const c = this.ctx();
    let oldest: UnixMs | null = null;
    let shiftNotOpenOnDriver = false;
    if (c !== null) {
      const rows = this.connection.db
        .select({ status: fiscalDocs.status, n: sql<bigint>`count(*)` })
        .from(fiscalDocs)
        .where(eq(fiscalDocs.organizationId, c.organizationId))
        .groupBy(fiscalDocs.status)
        .all();
      for (const r of rows) {
        if (isFiscalDocStatus(r.status)) counts[r.status] = Number(r.n);
      }
      oldest = readOldestUnsettledDeadlineSync(this.connection.db, c.organizationId);
      shiftNotOpenOnDriver =
        (
          this.connection.sqlite
            .prepare(
              `SELECT count(*) AS n FROM fiscal_docs fd JOIN shifts s ON s.id = fd.shift_id
               WHERE fd.organization_id = ? AND fd.doc_kind = 'shift_open' AND s.status = 'open'
                 AND fd.status IN ('pending', 'sent', 'failed')`,
            )
            .get(c.organizationId) as { n: bigint }
        ).n > 0n;
    }
    return {
      modeEnabled: cfg.modeEnabled,
      driverId: cfg.driverId,
      counts,
      oldestDeadlineMs: oldest,
      offlineWindowMs: cfg.offlineWindowMs,
      offlineExpiredAction: cfg.offlineExpiredAction,
      shiftNotOpenAction: cfg.shiftNotOpenAction,
      shiftNotOpenOnDriver,
    };
  }

  /** Owner fiscal-mode switch (preconditions are checked by the hub service). */
  async setModeEnabled(on: boolean): Promise<void> {
    const { uow } = this.requireCtx();
    await uow.execute((session) => {
      session.db.update(localHubConfig).set({ fiscalModeEnabled: on }).run();
      return Promise.resolve();
    });
  }
}
