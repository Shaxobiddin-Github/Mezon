import { DomainError, type UuidV7, parseUuidV7 } from '@mezon/domain';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { LocalSqliteConnection } from './connection.js';
import {
  customers,
  localCashDrawerEvents,
  localHubConfig,
  localReceiptPrints,
  shifts,
  users,
} from './schema/index.js';
import { type SqliteUnitOfWork, runConnectionReadOnly } from './uow.js';

export interface PrinterRuntimeContext {
  readonly uow: SqliteUnitOfWork;
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7;
}

export interface CreateSqlitePrinterStoreOptions {
  readonly connection: LocalSqliteConnection;
  readonly getRuntimeContext: () => PrinterRuntimeContext | null;
}

export type ReceiptPrintDocumentType = 'sale' | 'return' | 'shift_close';
export type ReceiptPrintStatus = 'printed' | 'failed' | 'disabled';
export type StoredPrinterMode = 'disabled' | 'windows_raw' | 'network_tcp';
export type StoredReceiptPrintRow = typeof localReceiptPrints.$inferSelect;
export type StoredCashDrawerEventRow = typeof localCashDrawerEvents.$inferSelect;

/** Raw printer settings persisted in `local_hub_config` (validated by the hub/drivers layer). */
export interface StoredPrinterSettings {
  readonly mode: StoredPrinterMode;
  readonly printerName: string | null;
  readonly host: string | null;
  readonly port: number;
  readonly timeoutMs: number;
  readonly paperWidthMm: 58 | 80;
  readonly encoding: 'translit' | 'cp866' | 'cp1251';
  readonly autoPrintSale: boolean;
  readonly cashDrawerAutoOpen: boolean;
  readonly receiptHeaderTitle: string;
  readonly receiptFooterText: string;
  readonly storeTimezone: string;
}

export type StoredPrinterSettingsPatch = Partial<Omit<StoredPrinterSettings, 'storeTimezone'>>;

export interface ReceiptPrintHistorySummary {
  /** Number of earlier attempts that produced paper (or the printer-less preview). */
  readonly successfulCount: number;
  readonly nextPrintSeq: number;
}

export interface RecordReceiptPrintInput {
  readonly documentType: ReceiptPrintDocumentType;
  readonly documentId: UuidV7;
  readonly clientRequestId: UuidV7;
  readonly actorUserId: UuidV7;
  readonly copyNumber: number;
  readonly isReprint: boolean;
  readonly status: ReceiptPrintStatus;
  readonly printerMode: StoredPrinterMode;
  readonly printerTarget: string | null;
  readonly bytesSent: number;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly textPreview: string;
}

export interface RecordCashDrawerEventInput {
  readonly clientRequestId: UuidV7;
  readonly shiftId: UuidV7 | null;
  readonly actorUserId: UuidV7;
  readonly overrideApprovedByUserId: UuidV7 | null;
  readonly reason: string;
  readonly status: ReceiptPrintStatus;
  readonly printerMode: StoredPrinterMode;
  readonly printerTarget: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

export interface RecordOutcome<TRow> {
  readonly row: TRow;
  readonly idempotentReplay: boolean;
}

function toSettings(row: typeof localHubConfig.$inferSelect): StoredPrinterSettings {
  return {
    mode: row.printerMode as StoredPrinterMode,
    printerName: row.printerName,
    host: row.printerHost,
    port: row.printerPort,
    timeoutMs: row.printerTimeoutMs,
    paperWidthMm: row.printerPaperWidthMm === 58 ? 58 : 80,
    encoding: row.printerEncoding as StoredPrinterSettings['encoding'],
    autoPrintSale: Boolean(row.printerAutoPrintSale),
    cashDrawerAutoOpen: Boolean(row.printerCashDrawerAutoOpen),
    receiptHeaderTitle: row.receiptHeaderTitle,
    receiptFooterText: row.receiptFooterText,
    storeTimezone: row.storeTimezone,
  };
}

/**
 * Persistence for T1.12 printing: printer settings (`local_hub_config`), receipt print audit
 * (`local_receipt_prints`) and cash drawer audit (`local_cash_drawer_events`). Both audit tables are
 * LOCAL (terminal hardware facts, never synced). Idempotency is keyed by `(organization_id, client_request_id)`.
 */
export class SqlitePrinterStore {
  private readonly connection: LocalSqliteConnection;
  private readonly getRuntimeContext: () => PrinterRuntimeContext | null;

  constructor(options: CreateSqlitePrinterStoreOptions) {
    this.connection = options.connection;
    this.getRuntimeContext = options.getRuntimeContext;
  }

  private requireContext(): PrinterRuntimeContext {
    const ctx = this.getRuntimeContext();
    if (ctx === null) {
      throw new DomainError('AUTH_UNAUTHORIZED', 'Hub setup has not been completed');
    }
    return ctx;
  }

  private readConfigRowSync(organizationId: UuidV7): typeof localHubConfig.$inferSelect {
    const row = this.connection.db
      .select()
      .from(localHubConfig)
      .where(eq(localHubConfig.organizationId, organizationId))
      .limit(1)
      .all()[0];
    if (!row) {
      throw new DomainError('AUTH_UNAUTHORIZED', 'Hub setup has not been completed');
    }
    return row;
  }

  async getPrinterSettings(): Promise<StoredPrinterSettings> {
    const ctx = this.requireContext();
    return runConnectionReadOnly(this.connection, () =>
      Promise.resolve(toSettings(this.readConfigRowSync(ctx.organizationId))),
    );
  }

  async updatePrinterSettings(patch: StoredPrinterSettingsPatch): Promise<StoredPrinterSettings> {
    const ctx = this.requireContext();
    return ctx.uow.execute((session) => {
      const current = toSettings(this.readConfigRowSync(ctx.organizationId));
      const next = { ...current, ...patch };
      session.db
        .update(localHubConfig)
        .set({
          printerMode: next.mode,
          printerName: next.printerName,
          printerHost: next.host,
          printerPort: next.port,
          printerTimeoutMs: next.timeoutMs,
          printerPaperWidthMm: next.paperWidthMm,
          printerEncoding: next.encoding,
          printerAutoPrintSale: next.autoPrintSale,
          printerCashDrawerAutoOpen: next.cashDrawerAutoOpen,
          receiptHeaderTitle: next.receiptHeaderTitle,
          receiptFooterText: next.receiptFooterText,
          updatedAtMs: session.nowUnixMs(),
        })
        .where(eq(localHubConfig.organizationId, ctx.organizationId))
        .run();
      return Promise.resolve(toSettings(this.readConfigRowSync(ctx.organizationId)));
    });
  }

  async findReceiptPrintByRequest(clientRequestId: UuidV7): Promise<StoredReceiptPrintRow | null> {
    const ctx = this.requireContext();
    const reqId = parseUuidV7(clientRequestId);
    return runConnectionReadOnly(this.connection, () =>
      Promise.resolve(
        this.connection.db
          .select()
          .from(localReceiptPrints)
          .where(
            and(
              eq(localReceiptPrints.organizationId, ctx.organizationId),
              eq(localReceiptPrints.clientRequestId, reqId),
            ),
          )
          .limit(1)
          .all()[0] ?? null,
      ),
    );
  }

  async listReceiptPrints(
    documentType: ReceiptPrintDocumentType,
    documentId: UuidV7,
  ): Promise<readonly StoredReceiptPrintRow[]> {
    const ctx = this.requireContext();
    const docId = parseUuidV7(documentId);
    return runConnectionReadOnly(this.connection, () =>
      Promise.resolve(
        this.connection.db
          .select()
          .from(localReceiptPrints)
          .where(
            and(
              eq(localReceiptPrints.organizationId, ctx.organizationId),
              eq(localReceiptPrints.storeId, ctx.storeId),
              eq(localReceiptPrints.documentType, documentType),
              eq(localReceiptPrints.documentId, docId),
            ),
          )
          .orderBy(asc(localReceiptPrints.printSeq))
          .all(),
      ),
    );
  }

  async getReceiptPrintHistorySummary(
    documentType: ReceiptPrintDocumentType,
    documentId: UuidV7,
  ): Promise<ReceiptPrintHistorySummary> {
    const rows = await this.listReceiptPrints(documentType, documentId);
    const successfulCount = rows.filter((r) => r.status !== 'failed').length;
    const lastSeq = rows.length > 0 ? rows[rows.length - 1].printSeq : 0;
    return { successfulCount, nextPrintSeq: lastSeq + 1 };
  }

  async recordReceiptPrint(
    input: RecordReceiptPrintInput,
  ): Promise<RecordOutcome<StoredReceiptPrintRow>> {
    const ctx = this.requireContext();
    const reqId = parseUuidV7(input.clientRequestId);
    const docId = parseUuidV7(input.documentId);
    return ctx.uow.execute<RecordOutcome<StoredReceiptPrintRow>>((session) => {
      const replay = session.db
        .select()
        .from(localReceiptPrints)
        .where(
          and(
            eq(localReceiptPrints.organizationId, ctx.organizationId),
            eq(localReceiptPrints.clientRequestId, reqId),
          ),
        )
        .limit(1)
        .all()[0];
      if (replay) {
        return Promise.resolve({ row: replay, idempotentReplay: true });
      }
      const last = session.db
        .select({ printSeq: localReceiptPrints.printSeq })
        .from(localReceiptPrints)
        .where(
          and(
            eq(localReceiptPrints.organizationId, ctx.organizationId),
            eq(localReceiptPrints.storeId, ctx.storeId),
            eq(localReceiptPrints.documentType, input.documentType),
            eq(localReceiptPrints.documentId, docId),
          ),
        )
        .orderBy(desc(localReceiptPrints.printSeq))
        .limit(1)
        .all()[0];
      const id = session.nextId();
      const nowMs = session.nowUnixMs();
      session.db
        .insert(localReceiptPrints)
        .values({
          id,
          organizationId: ctx.organizationId,
          storeId: ctx.storeId,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
          documentType: input.documentType,
          documentId: docId,
          printSeq: (last?.printSeq ?? 0) + 1,
          copyNumber: input.copyNumber,
          isReprint: input.isReprint,
          actorUserId: parseUuidV7(input.actorUserId),
          status: input.status,
          printerMode: input.printerMode,
          printerTarget: input.printerTarget,
          bytesSent: input.bytesSent,
          errorCode: input.errorCode,
          errorMessage: input.errorMessage,
          textPreview: input.textPreview,
          clientRequestId: reqId,
        })
        .run();
      const row = session.db
        .select()
        .from(localReceiptPrints)
        .where(eq(localReceiptPrints.id, id))
        .limit(1)
        .all()[0];
      return Promise.resolve({ row, idempotentReplay: false });
    });
  }

  async findCashDrawerEventByRequest(
    clientRequestId: UuidV7,
  ): Promise<StoredCashDrawerEventRow | null> {
    const ctx = this.requireContext();
    const reqId = parseUuidV7(clientRequestId);
    return runConnectionReadOnly(this.connection, () =>
      Promise.resolve(
        this.connection.db
          .select()
          .from(localCashDrawerEvents)
          .where(
            and(
              eq(localCashDrawerEvents.organizationId, ctx.organizationId),
              eq(localCashDrawerEvents.clientRequestId, reqId),
            ),
          )
          .limit(1)
          .all()[0] ?? null,
      ),
    );
  }

  async recordCashDrawerEvent(
    input: RecordCashDrawerEventInput,
  ): Promise<RecordOutcome<StoredCashDrawerEventRow>> {
    const ctx = this.requireContext();
    const reqId = parseUuidV7(input.clientRequestId);
    const reason = input.reason.trim();
    if (reason.length === 0) {
      throw new DomainError('VALIDATION_ERROR', 'Cash drawer opening reason is required');
    }
    return ctx.uow.execute<RecordOutcome<StoredCashDrawerEventRow>>((session) => {
      const replay = session.db
        .select()
        .from(localCashDrawerEvents)
        .where(
          and(
            eq(localCashDrawerEvents.organizationId, ctx.organizationId),
            eq(localCashDrawerEvents.clientRequestId, reqId),
          ),
        )
        .limit(1)
        .all()[0];
      if (replay) {
        return Promise.resolve({ row: replay, idempotentReplay: true });
      }
      const id = session.nextId();
      const nowMs = session.nowUnixMs();
      session.db
        .insert(localCashDrawerEvents)
        .values({
          id,
          organizationId: ctx.organizationId,
          storeId: ctx.storeId,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
          shiftId: input.shiftId,
          actorUserId: parseUuidV7(input.actorUserId),
          overrideApprovedByUserId: input.overrideApprovedByUserId,
          reason,
          status: input.status,
          printerMode: input.printerMode,
          printerTarget: input.printerTarget,
          errorCode: input.errorCode,
          errorMessage: input.errorMessage,
          clientRequestId: reqId,
        })
        .run();
      const row = session.db
        .select()
        .from(localCashDrawerEvents)
        .where(eq(localCashDrawerEvents.id, id))
        .limit(1)
        .all()[0];
      return Promise.resolve({ row, idempotentReplay: false });
    });
  }

  /** Display names for receipts: users by id, optional customer, optional shift code. */
  async getReceiptLabels(params: {
    readonly userIds: readonly UuidV7[];
    readonly customerId: UuidV7 | null;
    readonly shiftId: UuidV7 | null;
  }): Promise<{
    readonly userNames: ReadonlyMap<string, string>;
    readonly customerName: string | null;
    readonly shiftCode: string | null;
  }> {
    const ctx = this.requireContext();
    return runConnectionReadOnly(this.connection, () => {
      const ids = [...new Set(params.userIds)];
      const userRows =
        ids.length > 0
          ? this.connection.db
              .select({ id: users.id, fullName: users.fullName })
              .from(users)
              .where(and(eq(users.organizationId, ctx.organizationId), inArray(users.id, ids)))
              .all()
          : [];
      const customerRow =
        params.customerId !== null
          ? this.connection.db
              .select({ fullName: customers.fullName })
              .from(customers)
              .where(
                and(
                  eq(customers.organizationId, ctx.organizationId),
                  eq(customers.id, params.customerId),
                ),
              )
              .limit(1)
              .all()[0]
          : undefined;
      const shiftRow =
        params.shiftId !== null
          ? this.connection.db
              .select({ shiftCode: shifts.shiftCode })
              .from(shifts)
              .where(
                and(eq(shifts.organizationId, ctx.organizationId), eq(shifts.id, params.shiftId)),
              )
              .limit(1)
              .all()[0]
          : undefined;
      return Promise.resolve({
        userNames: new Map(userRows.map((u) => [u.id as string, u.fullName])),
        customerName: customerRow?.fullName ?? null,
        shiftCode: shiftRow?.shiftCode ?? null,
      });
    });
  }
}

export function createSqlitePrinterStore(
  options: CreateSqlitePrinterStoreOptions,
): SqlitePrinterStore {
  return new SqlitePrinterStore(options);
}
