import { createHash } from 'node:crypto';
import {
  type Money,
  type PaymentMethod,
  type ProductUnit,
  type Quantity,
  type SupplierDebtObligationSummary,
  type SupplierLedgerEntryForFifo,
  type SupplierLedgerEntryType,
  type SupplierLedgerFifoResult,
  type SupplierLedgerSourceType,
  type ReceivingDraftStatus,
  type UnixMs,
  type UuidV7,
  DEFAULT_STORE_TIMEZONE,
  DEFAULT_SUPPLIER_DUE_DAYS,
  DomainError,
  MAX_MONEY_TIYIN,
  ZERO_MONEY,
  allocateSupplierLedgerFifo,
  buildFtsPrefixQuery,
  canonicalizeConfirmReceivingCostRequest,
  canonicalizePostReceivingRequest,
  canonicalizeSupplierAdjustmentRequest,
  canonicalizeSupplierOpeningBalanceRequest,
  canonicalizeSupplierPaymentRequest,
  canonicalizeSupplierReturnRequest,
  computeNextSupplierBalance,
  computeProportionalCost,
  computeSupplierDueAtMs,
  computeUnitCostFromTotals,
  formatReceivingCode,
  formatSupplierReturnCode,
  isSignedInt64Money,
  moneyFromTiyin,
  moneyToTiyin,
  negateMoney,
  normalizeBatchNumber,
  normalizeMandatoryReason,
  normalizeSupplierContactPerson,
  normalizeSupplierDueDays,
  normalizeSupplierInvoiceNo,
  normalizeSupplierName,
  normalizeSupplierNote,
  normalizeSupplierPhone,
  normalizeSupplierSearchQuery,
  normalizeSupplierSearchText,
  normalizeSupplierTin,
  parsePaymentMethod,
  parseProductUnit,
  parseSupplierPaymentMethod,
  parseSupplierProviderRef,
  parseUuidV7,
  quantityFromMilli,
  quantityToMilli,
  unixMsFromBigInt,
  validatePositiveStockQuantity,
  validateReceivingLineCostInput,
} from '@mezon/domain';
import type Database from 'better-sqlite3';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { type LocalSqliteConnection } from './connection.js';
import { type StoredCashMoveRecord, toStoredCashMove } from './customer-repo.js';
import { advanceReceivingSeqSync, advanceSupplierReturnSeqSync } from './device-state.js';
import { getCashDrawerBalanceSync } from './sale-repo.js';
import {
  cashMoves,
  goodsReceivingLines,
  goodsReceivings,
  localHubConfig,
  localReceivingDraftLines,
  localReceivingDrafts,
  localSupplierBalances,
  products,
  productVariants,
  receivingCostConfirmations,
  supplierLedger,
  supplierReturnLines,
  supplierReturns,
  suppliers,
} from './schema/index.js';
import {
  type StockPoolPrefetchTarget,
  type StoredStockMoveRecord,
  applyCostConfirmationStockRevaluationSync,
  applyInboundStockMoveSync,
  applySupplierReturnStockOutboundSync,
  prefetchMutablePoolStatesSync,
  stockPoolKey,
} from './stock-repo.js';
import { resolveIntlDateKey } from './timezone.js';
import {
  type SqliteUnitOfWork,
  type SqliteUnitOfWorkSession,
  runConnectionProjectionMaintenance,
  runConnectionReadOnly,
} from './uow.js';
import { insertAttr, insertFact, tombstoneAttr, updateAttr } from './writers.js';

export interface SupplierRuntimeContext {
  readonly uow: SqliteUnitOfWork;
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7;
}

export interface CreateSqliteSupplierStoreOptions {
  readonly connection: LocalSqliteConnection;
  readonly getRuntimeContext: () => SupplierRuntimeContext | null;
}

export interface CreateSupplierInput {
  readonly name: string;
  readonly tin?: string | null;
  readonly phone?: string | null;
  readonly contactPerson?: string | null;
  readonly defaultDueDays?: number | null;
  readonly note?: string | null;
}

export interface UpdateSupplierInput {
  readonly name?: string;
  readonly tin?: string | null;
  readonly phone?: string | null;
  readonly contactPerson?: string | null;
  readonly defaultDueDays?: number | null;
  readonly note?: string | null;
  readonly isActive?: boolean;
}

export interface SupplierSummaryRecord {
  readonly id: UuidV7;
  readonly organizationId: UuidV7;
  readonly name: string;
  readonly tin: string | null;
  readonly phoneNormalized: string | null;
  readonly contactPerson: string | null;
  readonly defaultDueDays: number | null;
  readonly note: string | null;
  readonly isActive: boolean;
  /** Signed balance: `> 0` debt owed to supplier; `< 0` advance/prepayment credit. */
  readonly balance: Money;
  readonly debtBalance: Money;
  readonly advanceBalance: Money;
  readonly totalDebtAccrued: Money;
  readonly totalCredited: Money;
  readonly overdueAmount: Money;
  readonly oldestOverdueDays: number;
  readonly lastActivityAtMs: UnixMs | null;
  readonly createdAtMs: UnixMs;
  readonly updatedAtMs: UnixMs;
}

export interface SupplierDetailRecord {
  readonly supplier: SupplierSummaryRecord;
  readonly openObligations: readonly SupplierDebtObligationSummary[];
}

export interface SupplierListQueryInput {
  readonly q?: string;
  readonly overdueOnly?: boolean;
  readonly advanceOnly?: boolean;
  readonly includeInactive?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

export interface SupplierListOutcome {
  readonly items: readonly SupplierSummaryRecord[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface ReceivingLineInput {
  readonly productId: UuidV7;
  readonly variantId?: UuidV7 | null;
  readonly qty: Quantity;
  readonly costUnknown: boolean;
  readonly totalCostValue: Money | null;
  readonly vatRateBp?: number | null;
  readonly vatAmount?: Money | null;
  readonly batchNumber?: string | null;
  readonly expiryDateMs?: UnixMs | null;
}

export interface CreateReceivingDraftInput {
  readonly supplierId: UuidV7;
  readonly actorUserId: UuidV7;
  readonly supplierInvoiceNo?: string | null;
  readonly dueDays?: number | null;
  readonly note?: string | null;
  readonly lines?: readonly ReceivingLineInput[];
}

export interface UpdateReceivingDraftInput {
  readonly supplierId?: UuidV7;
  readonly supplierInvoiceNo?: string | null;
  readonly dueDays?: number | null;
  readonly note?: string | null;
  readonly lines?: readonly ReceivingLineInput[];
}

export interface StoredReceivingDraftLineRecord {
  readonly id: UuidV7;
  readonly draftId: UuidV7;
  readonly sortOrder: number;
  readonly productId: UuidV7;
  readonly variantId: UuidV7 | null;
  readonly productName: string;
  readonly unit: ProductUnit;
  readonly qty: Quantity;
  readonly costUnknown: boolean;
  readonly totalCostValue: Money | null;
  readonly vatRateBp: number | null;
  readonly vatAmount: Money | null;
  readonly batchNumber: string | null;
  readonly expiryDateMs: UnixMs | null;
}

export interface StoredReceivingDraftRecord {
  readonly id: UuidV7;
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7;
  readonly supplierId: UuidV7;
  readonly supplierInvoiceNo: string | null;
  readonly dueDays: number | null;
  readonly note: string | null;
  readonly status: ReceivingDraftStatus;
  readonly createdByUserId: UuidV7;
  readonly createdAtMs: UnixMs;
  readonly updatedAtMs: UnixMs;
  readonly postedAtMs: UnixMs | null;
  readonly cancelledAtMs: UnixMs | null;
  readonly lines: readonly StoredReceivingDraftLineRecord[];
}

export interface StoredReceivingCostConfirmationRecord {
  readonly id: UuidV7;
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7;
  readonly deviceId: UuidV7;
  readonly receivingId: UuidV7;
  readonly receivingLineId: UuidV7;
  readonly supplierId: UuidV7;
  readonly productId: UuidV7;
  readonly variantId: UuidV7 | null;
  readonly batchId: UuidV7 | null;
  readonly receivedQty: Quantity;
  readonly confirmedTotalCost: Money;
  readonly dueDays: number | null;
  readonly dueAtMs: UnixMs | null;
  readonly reason: string;
  readonly confirmedByUserId: UuidV7;
  readonly clientRequestId: UuidV7;
  readonly createdAtMs: UnixMs;
}

export interface StoredReceivingLineRecord {
  readonly id: UuidV7;
  readonly receivingId: UuidV7;
  readonly sortOrder: number;
  readonly productId: UuidV7;
  readonly variantId: UuidV7 | null;
  readonly productName: string;
  readonly unit: ProductUnit;
  readonly qty: Quantity;
  readonly returnedQty: Quantity;
  readonly costUnknown: boolean;
  readonly costStatus: 'known' | 'unknown' | 'confirmed';
  readonly effectiveTotalCost: Money;
  readonly unitCostPreview: Money;
  readonly vatRateBp: number | null;
  readonly vatAmount: Money | null;
  readonly stockMoveId: UuidV7;
  readonly batchId: UuidV7 | null;
  readonly batchNumber: string | null;
  readonly expiryDateMs: UnixMs | null;
  readonly confirmation: StoredReceivingCostConfirmationRecord | null;
}

export interface StoredReceivingRecord {
  readonly id: UuidV7;
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7;
  readonly deviceId: UuidV7;
  readonly receivingNo: bigint;
  readonly receivingCode: string;
  readonly supplierId: UuidV7;
  readonly supplierInvoiceNo: string | null;
  readonly dueDays: number | null;
  readonly dueAtMs: UnixMs | null;
  readonly knownCostTotal: Money;
  readonly unknownCostLineCount: number;
  readonly note: string | null;
  readonly postedByUserId: UuidV7;
  readonly clientRequestId: UuidV7;
  readonly createdAtMs: UnixMs;
  readonly lines: readonly StoredReceivingLineRecord[];
}

export interface PostReceivingInput {
  readonly actorUserId: UuidV7;
  readonly clientRequestId: UuidV7;
}

export interface PostReceivingOutcome {
  readonly receiving: StoredReceivingRecord;
  readonly supplier: SupplierSummaryRecord;
  readonly idempotentReplay: boolean;
}

export interface ConfirmReceivingLineCostInput {
  readonly actorUserId: UuidV7;
  readonly clientRequestId: UuidV7;
  readonly confirmedTotalCost: Money;
  readonly reason: string;
  readonly dueDays?: number | null;
}

export interface ConfirmReceivingCostOutcome {
  readonly confirmation: StoredReceivingCostConfirmationRecord;
  readonly receiving: StoredReceivingRecord;
  readonly supplier: SupplierSummaryRecord;
  readonly idempotentReplay: boolean;
}

export interface ReceivingListQueryInput {
  readonly status?: ReceivingDraftStatus;
  readonly supplierId?: UuidV7;
  readonly costUnknownOnly?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

export interface ReceivingListItemRecord {
  readonly id: UuidV7;
  readonly status: ReceivingDraftStatus;
  readonly receivingNo: bigint | null;
  readonly receivingCode: string | null;
  readonly supplierId: UuidV7;
  readonly supplierInvoiceNo: string | null;
  readonly knownCostTotal: Money;
  readonly unknownCostLineCount: number;
  readonly lineCount: number;
  readonly createdAtMs: UnixMs;
  readonly postedAtMs: UnixMs | null;
}

export interface ReceivingListOutcome {
  readonly items: readonly ReceivingListItemRecord[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface SupplierReturnLineInput {
  readonly receivingLineId: UuidV7;
  readonly qty: Quantity;
}

export interface CreateSupplierReturnInput {
  readonly actorUserId: UuidV7;
  readonly clientRequestId: UuidV7;
  readonly reason: string;
  readonly items: readonly SupplierReturnLineInput[];
}

export interface StoredSupplierReturnLineRecord {
  readonly id: UuidV7;
  readonly supplierReturnId: UuidV7;
  readonly receivingLineId: UuidV7;
  readonly sortOrder: number;
  readonly productId: UuidV7;
  readonly variantId: UuidV7 | null;
  readonly batchId: UuidV7 | null;
  readonly stockMoveId: UuidV7;
  readonly qty: Quantity;
  readonly returnCostValue: Money;
}

export interface StoredSupplierReturnRecord {
  readonly id: UuidV7;
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7;
  readonly deviceId: UuidV7;
  readonly returnNo: bigint;
  readonly returnCode: string;
  readonly receivingId: UuidV7;
  readonly supplierId: UuidV7;
  readonly reason: string;
  readonly totalReturnCost: Money;
  readonly createdByUserId: UuidV7;
  readonly clientRequestId: UuidV7;
  readonly createdAtMs: UnixMs;
  readonly lines: readonly StoredSupplierReturnLineRecord[];
}

export interface CreateSupplierReturnOutcome {
  readonly supplierReturn: StoredSupplierReturnRecord;
  readonly supplier: SupplierSummaryRecord;
  readonly idempotentReplay: boolean;
}

export interface StoredSupplierLedgerEntryRecord {
  readonly id: UuidV7;
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7;
  readonly deviceId: UuidV7;
  readonly supplierId: UuidV7;
  readonly entryType: SupplierLedgerEntryType;
  readonly amountDelta: Money;
  readonly balanceAfter: Money;
  readonly sourceType: SupplierLedgerSourceType;
  readonly sourceId: UuidV7;
  readonly receivingId: UuidV7 | null;
  readonly supplierReturnId: UuidV7 | null;
  readonly paymentMethod: PaymentMethod | null;
  readonly providerRef: string | null;
  readonly cashMoveId: UuidV7 | null;
  readonly dueAtMs: UnixMs | null;
  readonly reason: string | null;
  readonly createdByUserId: UuidV7;
  readonly createdAtMs: UnixMs;
}

export interface SupplierLedgerListQueryInput {
  readonly limit?: number;
  readonly offset?: number;
  readonly order?: 'asc' | 'desc';
  readonly entryType?: SupplierLedgerEntryType;
}

export interface SupplierLedgerListOutcome {
  readonly supplierId: UuidV7;
  readonly currentBalance: Money;
  readonly items: readonly StoredSupplierLedgerEntryRecord[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface RecordSupplierOpeningBalanceInput {
  readonly supplierId: UuidV7;
  readonly actorUserId: UuidV7;
  readonly clientRequestId: UuidV7;
  readonly amount: Money;
  readonly reason: string;
  readonly dueDays?: number | null;
}

export interface RecordSupplierPaymentInput {
  readonly supplierId: UuidV7;
  readonly actorUserId: UuidV7;
  readonly clientRequestId: UuidV7;
  readonly method: PaymentMethod;
  readonly amount: Money;
  readonly providerRef?: string | null;
  readonly reason?: string | null;
}

export interface RecordSupplierAdjustmentInput {
  readonly supplierId: UuidV7;
  readonly actorUserId: UuidV7;
  readonly clientRequestId: UuidV7;
  readonly amountDelta: Money;
  readonly reason: string;
  readonly dueDays?: number | null;
}

export interface SupplierLedgerMutationOutcome {
  readonly supplier: SupplierSummaryRecord;
  readonly entry: StoredSupplierLedgerEntryRecord;
  readonly cashMove: StoredCashMoveRecord | null;
  readonly idempotentReplay: boolean;
}

export interface RebuildSupplierBalancesOutcome {
  readonly suppliersProcessed: number;
  readonly balancesUpdated: number;
}

export interface RebuildSupplierSearchIndexOutcome {
  readonly ftsIndexedCount: number;
}

function sha256Hex(canonical: string): string {
  return createHash('sha256').update(canonical).digest('hex');
}

function toBigInt(val: unknown): bigint {
  if (typeof val === 'bigint') {
    return val;
  }
  if (typeof val === 'number') {
    return BigInt(Math.trunc(val));
  }
  if (typeof val === 'string') {
    return BigInt(val);
  }
  throw new TypeError(`Expected integer-compatible value, got ${typeof val}`);
}

function toNullableUnixMs(val: unknown): UnixMs | null {
  if (val === null || val === undefined) {
    return null;
  }
  return unixMsFromBigInt(toBigInt(val));
}

function isTinUniqueConstraintError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  return (
    err.message.includes('uidx_suppliers_org_tin_active') ||
    (err.message.includes('UNIQUE constraint failed: suppliers') &&
      err.message.includes('suppliers.tin'))
  );
}

function isPhoneUniqueConstraintError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  return (
    err.message.includes('uidx_suppliers_org_phone_active') ||
    (err.message.includes('UNIQUE constraint failed: suppliers') &&
      err.message.includes('suppliers.phone_normalized'))
  );
}

function mapSupplierUniqueConstraintError(err: unknown): never {
  if (isTinUniqueConstraintError(err)) {
    throw new DomainError(
      'SUPPLIER_TIN_ALREADY_EXISTS',
      'A supplier with this TIN already exists in this organization',
    );
  }
  if (isPhoneUniqueConstraintError(err)) {
    throw new DomainError(
      'SUPPLIER_PHONE_ALREADY_EXISTS',
      'A supplier with this phone number already exists in this organization',
    );
  }
  throw err;
}

interface HubSupplierConfigSnapshot {
  readonly storeTimezone: string;
  readonly defaultSupplierDueDays: number | null;
}

function readHubSupplierConfigSync(
  db: BetterSQLite3Database,
  organizationId: UuidV7,
): HubSupplierConfigSnapshot {
  const row = db
    .select({
      storeTimezone: localHubConfig.storeTimezone,
      defaultSupplierDueDays: localHubConfig.defaultSupplierDueDays,
    })
    .from(localHubConfig)
    .where(eq(localHubConfig.organizationId, organizationId))
    .limit(1)
    .all()[0];
  return {
    storeTimezone: row?.storeTimezone ?? DEFAULT_STORE_TIMEZONE,
    defaultSupplierDueDays:
      row !== undefined ? row.defaultSupplierDueDays : DEFAULT_SUPPLIER_DUE_DAYS,
  };
}

function readActiveSupplierRowSync(
  db: BetterSQLite3Database,
  organizationId: UuidV7,
  supplierId: UuidV7,
): typeof suppliers.$inferSelect {
  const validId = parseUuidV7(supplierId);
  const row = db
    .select()
    .from(suppliers)
    .where(
      and(
        eq(suppliers.id, validId),
        eq(suppliers.organizationId, organizationId),
        isNull(suppliers.deletedAtMs),
      ),
    )
    .limit(1)
    .all()[0];
  if (!row) {
    throw new DomainError('SUPPLIER_NOT_FOUND', 'Supplier record not found');
  }
  return row;
}

interface RawSupplierLedgerFifoRow {
  readonly id: string;
  readonly hlc: string;
  readonly created_at_ms: bigint | number;
  readonly entry_type: string;
  readonly amount_delta: bigint | number;
  readonly source_type: string;
  readonly receiving_id: string | null;
  readonly payment_method: string | null;
  readonly due_at_ms: bigint | number | null;
}

const SUPPLIER_FIFO_STMT_CACHE = new WeakMap<Database.Database, Database.Statement>();

function getSupplierLedgerFifoStmt(sqlite: Database.Database): Database.Statement {
  let stmt = SUPPLIER_FIFO_STMT_CACHE.get(sqlite);
  if (!stmt) {
    stmt = sqlite
      .prepare(
        `SELECT "id", "hlc", "created_at_ms", "entry_type", "amount_delta", "source_type", "receiving_id", "payment_method", "due_at_ms"
         FROM "supplier_ledger"
         WHERE "organization_id" = ? AND "supplier_id" = ?
         ORDER BY "hlc" ASC, "id" ASC`,
      )
      .safeIntegers(true);
    SUPPLIER_FIFO_STMT_CACHE.set(sqlite, stmt);
  }
  return stmt;
}

export function readSupplierLedgerFifoSync(
  sqlite: Database.Database,
  params: {
    readonly organizationId: UuidV7;
    readonly supplierId: UuidV7;
    readonly asOfMs: UnixMs;
    readonly storeTimezone: string;
  },
): { readonly fifo: SupplierLedgerFifoResult; readonly lastActivityAtMs: UnixMs | null } {
  const rawRows = getSupplierLedgerFifoStmt(sqlite).all(
    params.organizationId,
    params.supplierId,
  ) as RawSupplierLedgerFifoRow[];

  const entries: SupplierLedgerEntryForFifo[] = [];
  let maxCreatedAt: bigint | null = null;

  for (let i = 0; i < rawRows.length; i += 1) {
    const r = rawRows[i];
    if (!r) continue;
    const createdBig = toBigInt(r.created_at_ms);
    if (maxCreatedAt === null || createdBig > maxCreatedAt) {
      maxCreatedAt = createdBig;
    }
    entries.push({
      id: r.id as UuidV7,
      hlc: r.hlc,
      createdAtMs: unixMsFromBigInt(createdBig),
      entryType: r.entry_type as SupplierLedgerEntryType,
      amountDelta: moneyFromTiyin(toBigInt(r.amount_delta)),
      sourceType: r.source_type as SupplierLedgerSourceType,
      receivingId: r.receiving_id as UuidV7 | null,
      paymentMethod: r.payment_method !== null ? parsePaymentMethod(r.payment_method) : null,
      dueAtMs: toNullableUnixMs(r.due_at_ms),
    });
  }

  const fifo = allocateSupplierLedgerFifo({
    entries,
    asOfMs: params.asOfMs,
    storeTimezone: params.storeTimezone,
    resolveTimeZoneDateKey: resolveIntlDateKey,
  });

  return {
    fifo,
    lastActivityAtMs: maxCreatedAt !== null ? unixMsFromBigInt(maxCreatedAt) : null,
  };
}

const UPSERT_SUPPLIER_BAL_STMT_CACHE = new WeakMap<Database.Database, Database.Statement>();

function upsertSupplierBalanceProjectionSync(
  session: SqliteUnitOfWorkSession,
  params: {
    readonly organizationId: UuidV7;
    readonly supplierId: UuidV7;
    readonly balanceTiyin: bigint;
    readonly totalDebtAccrued: Money;
    readonly totalCredited: Money;
    readonly earliestOpenDueAtMs: UnixMs | null;
    readonly lastActivityAtMs: UnixMs | null;
    readonly nowMs: UnixMs;
  },
): void {
  const sqlite = session.internalGetSqlite();
  let stmt = UPSERT_SUPPLIER_BAL_STMT_CACHE.get(sqlite);
  if (!stmt) {
    stmt = sqlite.prepare(
      `INSERT INTO "local_supplier_balances" (
         "id", "organization_id", "created_at_ms", "updated_at_ms",
         "supplier_id", "balance", "total_debt_accrued", "total_credited",
         "earliest_open_due_at_ms", "last_activity_at_ms"
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT("supplier_id") DO UPDATE SET
         "updated_at_ms" = excluded."updated_at_ms",
         "balance" = excluded."balance",
         "total_debt_accrued" = excluded."total_debt_accrued",
         "total_credited" = excluded."total_credited",
         "earliest_open_due_at_ms" = excluded."earliest_open_due_at_ms",
         "last_activity_at_ms" = excluded."last_activity_at_ms"`,
    );
    UPSERT_SUPPLIER_BAL_STMT_CACHE.set(sqlite, stmt);
  }

  stmt.run(
    session.nextId(),
    params.organizationId,
    BigInt(params.nowMs),
    BigInt(params.nowMs),
    params.supplierId,
    params.balanceTiyin,
    moneyToTiyin(params.totalDebtAccrued),
    moneyToTiyin(params.totalCredited),
    params.earliestOpenDueAtMs !== null ? BigInt(params.earliestOpenDueAtMs) : null,
    params.lastActivityAtMs !== null ? BigInt(params.lastActivityAtMs) : null,
  );
}

function readSupplierBalanceRowSync(
  db: BetterSQLite3Database,
  organizationId: UuidV7,
  supplierId: UuidV7,
): typeof localSupplierBalances.$inferSelect | undefined {
  return db
    .select()
    .from(localSupplierBalances)
    .where(
      and(
        eq(localSupplierBalances.organizationId, organizationId),
        eq(localSupplierBalances.supplierId, supplierId),
      ),
    )
    .limit(1)
    .all()[0];
}

function toSupplierSummary(
  row: typeof suppliers.$inferSelect,
  fifo: SupplierLedgerFifoResult,
  lastActivityAtMs: UnixMs | null,
): SupplierSummaryRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    tin: row.tin,
    phoneNormalized: row.phoneNormalized,
    contactPerson: row.contactPerson,
    defaultDueDays: row.defaultDueDays,
    note: row.note,
    isActive: row.isActive,
    balance: moneyFromTiyin(fifo.balanceTiyin),
    debtBalance: fifo.debtBalance,
    advanceBalance: fifo.advanceBalance,
    totalDebtAccrued: fifo.totalDebtAccrued,
    totalCredited: fifo.totalCredited,
    overdueAmount: fifo.overdueAmount,
    oldestOverdueDays: Number(fifo.oldestOverdueDays),
    lastActivityAtMs,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

function toStoredSupplierLedgerEntry(
  row: typeof supplierLedger.$inferSelect,
  balanceAfter: Money,
): StoredSupplierLedgerEntryRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    storeId: row.storeId,
    deviceId: row.deviceId,
    supplierId: row.supplierId,
    entryType: row.entryType as SupplierLedgerEntryType,
    amountDelta: row.amountDelta,
    balanceAfter,
    sourceType: row.sourceType as SupplierLedgerSourceType,
    sourceId: row.sourceId,
    receivingId: row.receivingId,
    supplierReturnId: row.supplierReturnId,
    paymentMethod: row.paymentMethod !== null ? parsePaymentMethod(row.paymentMethod) : null,
    providerRef: row.providerRef,
    cashMoveId: row.cashMoveId,
    dueAtMs: row.dueAtMs,
    reason: row.reason,
    createdByUserId: row.createdByUserId,
    createdAtMs: row.createdAtMs,
  };
}

function toStoredCostConfirmation(
  row: typeof receivingCostConfirmations.$inferSelect,
): StoredReceivingCostConfirmationRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    storeId: row.storeId,
    deviceId: row.deviceId,
    receivingId: row.receivingId,
    receivingLineId: row.receivingLineId,
    supplierId: row.supplierId,
    productId: row.productId,
    variantId: row.variantId,
    batchId: row.batchId,
    receivedQty: row.receivedQty,
    confirmedTotalCost: row.confirmedTotalCost,
    dueDays: row.dueDays,
    dueAtMs: row.dueAtMs,
    reason: row.reason,
    confirmedByUserId: row.confirmedByUserId,
    clientRequestId: row.clientRequestId,
    createdAtMs: row.createdAtMs,
  };
}

interface NormalizedReceivingLinePrepared {
  readonly productId: UuidV7;
  readonly variantId: UuidV7 | null;
  readonly qty: Quantity;
  readonly costUnknown: boolean;
  readonly totalCostValue: Money | null;
  readonly vatRateBp: number | null;
  readonly vatAmount: Money | null;
  readonly batchNumber: string | null;
  readonly expiryDateMs: UnixMs | null;
  readonly product: typeof products.$inferSelect;
}

function fetchProductsMapSync(
  db: BetterSQLite3Database,
  organizationId: UuidV7,
  productIds: readonly UuidV7[],
): Map<UuidV7, typeof products.$inferSelect> {
  const uniqueIds = [...new Set(productIds)];
  const map = new Map<UuidV7, typeof products.$inferSelect>();
  if (uniqueIds.length === 0) {
    return map;
  }
  const rows = db
    .select()
    .from(products)
    .where(and(eq(products.organizationId, organizationId), inArray(products.id, uniqueIds)))
    .all();
  for (const r of rows) {
    map.set(r.id, r);
  }
  return map;
}

function validateAndPrepareReceivingLinesSync(
  db: BetterSQLite3Database,
  organizationId: UuidV7,
  rawLines: readonly ReceivingLineInput[],
): readonly NormalizedReceivingLinePrepared[] {
  if (rawLines.length === 0) {
    return [];
  }

  const prodIds = rawLines.map((l) => parseUuidV7(l.productId));
  const prodMap = fetchProductsMapSync(db, organizationId, prodIds);

  const variantIds = [
    ...new Set(
      rawLines
        .map((l) =>
          l.variantId !== undefined && l.variantId !== null ? parseUuidV7(l.variantId) : null,
        )
        .filter((v): v is UuidV7 => v !== null),
    ),
  ];
  const varMap = new Map<UuidV7, typeof productVariants.$inferSelect>();
  if (variantIds.length > 0) {
    const varRows = db
      .select()
      .from(productVariants)
      .where(
        and(
          eq(productVariants.organizationId, organizationId),
          inArray(productVariants.id, variantIds),
          isNull(productVariants.deletedAtMs),
        ),
      )
      .all();
    for (const vr of varRows) {
      varMap.set(vr.id, vr);
    }
  }

  const out: NormalizedReceivingLinePrepared[] = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const line = rawLines[i];
    const productId = parseUuidV7(line.productId);
    const product = prodMap.get(productId);
    if (!product || product.deletedAtMs !== null) {
      throw new DomainError('PRODUCT_NOT_FOUND', `Product "${productId}" was not found`);
    }
    if (Boolean(product.unlimited)) {
      throw new DomainError(
        'UNLIMITED_PRODUCT_STOCK_NOT_TRACKED',
        `Unlimited product "${product.name}" cannot be received into stock`,
      );
    }

    const variantId =
      line.variantId !== undefined && line.variantId !== null ? parseUuidV7(line.variantId) : null;
    if (variantId !== null) {
      const variant = varMap.get(variantId);
      if (!variant || variant.productId !== productId) {
        throw new DomainError(
          'VARIANT_NOT_FOUND',
          `Product variant "${variantId}" was not found for product "${productId}"`,
        );
      }
    }

    const unit = parseProductUnit(product.unit);
    const qty = validatePositiveStockQuantity(unit, line.qty);
    const costUnknown = Boolean(line.costUnknown);
    const validatedCost = validateReceivingLineCostInput({
      costUnknown,
      totalCostValue: line.totalCostValue,
    });
    const totalCostValue = costUnknown ? null : validatedCost;

    let vatRateBp: number | null = null;
    if (line.vatRateBp !== undefined && line.vatRateBp !== null) {
      if (!Number.isInteger(line.vatRateBp) || line.vatRateBp < 0 || line.vatRateBp > 10000) {
        throw new DomainError(
          'VALIDATION_ERROR',
          'vatRateBp must be an integer between 0 and 10000',
        );
      }
      vatRateBp = line.vatRateBp;
    }

    let vatAmount: Money | null = null;
    if (line.vatAmount !== undefined && line.vatAmount !== null) {
      const vt = moneyToTiyin(line.vatAmount);
      if (vt < 0n || !isSignedInt64Money(vt) || vt > MAX_MONEY_TIYIN) {
        throw new DomainError('VALIDATION_ERROR', 'vatAmount must be non-negative bounded money');
      }
      vatAmount = line.vatAmount;
    }

    const batchNumber = normalizeBatchNumber(line.batchNumber);
    const expiryDateMs =
      line.expiryDateMs !== undefined && line.expiryDateMs !== null
        ? unixMsFromBigInt(BigInt(line.expiryDateMs))
        : null;

    out.push({
      productId,
      variantId,
      qty,
      costUnknown,
      totalCostValue,
      vatRateBp,
      vatAmount,
      batchNumber,
      expiryDateMs,
      product,
    });
  }

  return out;
}

function buildReceivingDraftRecordSync(
  db: BetterSQLite3Database,
  organizationId: UuidV7,
  storeId: UuidV7,
  draftId: UuidV7,
): StoredReceivingDraftRecord {
  const draft = db
    .select()
    .from(localReceivingDrafts)
    .where(
      and(
        eq(localReceivingDrafts.id, draftId),
        eq(localReceivingDrafts.organizationId, organizationId),
        eq(localReceivingDrafts.storeId, storeId),
      ),
    )
    .limit(1)
    .all()[0];
  if (!draft) {
    throw new DomainError('RECEIVING_NOT_FOUND', `Receiving draft "${draftId}" was not found`);
  }

  const lineRows = db
    .select()
    .from(localReceivingDraftLines)
    .where(eq(localReceivingDraftLines.draftId, draft.id))
    .orderBy(asc(localReceivingDraftLines.sortOrder))
    .all();

  const prodMap = fetchProductsMapSync(
    db,
    organizationId,
    lineRows.map((l) => l.productId),
  );

  const lines: StoredReceivingDraftLineRecord[] = lineRows.map((l) => {
    const prod = prodMap.get(l.productId);
    return {
      id: l.id,
      draftId: l.draftId,
      sortOrder: l.sortOrder,
      productId: l.productId,
      variantId: l.variantId,
      productName: prod?.name ?? 'Unknown product',
      unit: prod ? parseProductUnit(prod.unit) : 'dona',
      qty: l.qty,
      costUnknown: l.costUnknown,
      totalCostValue: l.totalCostValue,
      vatRateBp: l.vatRateBp,
      vatAmount: l.vatAmount,
      batchNumber: l.batchNumber,
      expiryDateMs: l.expiryDateMs,
    };
  });

  return {
    id: draft.id,
    organizationId: draft.organizationId,
    storeId: draft.storeId,
    supplierId: draft.supplierId,
    supplierInvoiceNo: draft.supplierInvoiceNo,
    dueDays: draft.dueDays,
    note: draft.note,
    status: draft.status as ReceivingDraftStatus,
    createdByUserId: draft.createdByUserId,
    createdAtMs: draft.createdAtMs,
    updatedAtMs: draft.updatedAtMs,
    postedAtMs: draft.postedAtMs,
    cancelledAtMs: draft.cancelledAtMs,
    lines,
  };
}

function buildPostedReceivingRecordSync(
  db: BetterSQLite3Database,
  organizationId: UuidV7,
  storeId: UuidV7,
  receivingId: UuidV7,
): StoredReceivingRecord {
  const row = db
    .select()
    .from(goodsReceivings)
    .where(
      and(
        eq(goodsReceivings.id, receivingId),
        eq(goodsReceivings.organizationId, organizationId),
        eq(goodsReceivings.storeId, storeId),
      ),
    )
    .limit(1)
    .all()[0];
  if (!row) {
    throw new DomainError('RECEIVING_NOT_FOUND', `Receiving "${receivingId}" was not found`);
  }

  const lineRows = db
    .select()
    .from(goodsReceivingLines)
    .where(eq(goodsReceivingLines.receivingId, row.id))
    .orderBy(asc(goodsReceivingLines.sortOrder))
    .all();

  const prodMap = fetchProductsMapSync(
    db,
    organizationId,
    lineRows.map((l) => l.productId),
  );

  const confirmRows = db
    .select()
    .from(receivingCostConfirmations)
    .where(eq(receivingCostConfirmations.receivingId, row.id))
    .all();
  const confirmByLineId = new Map<UuidV7, typeof receivingCostConfirmations.$inferSelect>();
  for (const cr of confirmRows) {
    confirmByLineId.set(cr.receivingLineId, cr);
  }

  const returnedQtyByLine = new Map<UuidV7, bigint>();
  if (lineRows.length > 0) {
    const retLineRows = db
      .select({
        receivingLineId: supplierReturnLines.receivingLineId,
        qty: supplierReturnLines.qty,
      })
      .from(supplierReturnLines)
      .where(
        inArray(
          supplierReturnLines.receivingLineId,
          lineRows.map((l) => l.id),
        ),
      )
      .all();
    for (const rl of retLineRows) {
      returnedQtyByLine.set(
        rl.receivingLineId,
        (returnedQtyByLine.get(rl.receivingLineId) ?? 0n) + quantityToMilli(rl.qty),
      );
    }
  }

  const lines: StoredReceivingLineRecord[] = lineRows.map((l) => {
    const prod = prodMap.get(l.productId);
    const conf = confirmByLineId.get(l.id) ?? null;
    const costStatus: 'known' | 'unknown' | 'confirmed' = !l.costUnknown
      ? 'known'
      : conf !== null
        ? 'confirmed'
        : 'unknown';
    const effectiveTotalCost = !l.costUnknown
      ? l.initialTotalCost
      : conf !== null
        ? conf.confirmedTotalCost
        : ZERO_MONEY;
    const unitCostPreview =
      moneyToTiyin(effectiveTotalCost) > 0n
        ? computeUnitCostFromTotals(effectiveTotalCost, l.qty)
        : ZERO_MONEY;
    return {
      id: l.id,
      receivingId: l.receivingId,
      sortOrder: l.sortOrder,
      productId: l.productId,
      variantId: l.variantId,
      productName: prod?.name ?? 'Unknown product',
      unit: prod ? parseProductUnit(prod.unit) : 'dona',
      qty: l.qty,
      returnedQty: quantityFromMilli(returnedQtyByLine.get(l.id) ?? 0n),
      costUnknown: l.costUnknown,
      costStatus,
      effectiveTotalCost,
      unitCostPreview,
      vatRateBp: l.vatRateBp,
      vatAmount: l.vatAmount,
      stockMoveId: l.stockMoveId,
      batchId: l.batchId,
      batchNumber: l.batchNumber,
      expiryDateMs: l.expiryDateMs,
      confirmation: conf !== null ? toStoredCostConfirmation(conf) : null,
    };
  });

  let liveKnownCostTiyin = 0n;
  let remainingUnknownCount = 0;
  for (const line of lines) {
    if (line.costStatus === 'unknown') {
      remainingUnknownCount += 1;
    } else {
      liveKnownCostTiyin += moneyToTiyin(line.effectiveTotalCost);
    }
  }

  return {
    id: row.id,
    organizationId: row.organizationId,
    storeId: row.storeId,
    deviceId: row.deviceId,
    receivingNo: row.receivingNo,
    receivingCode: row.receivingCode,
    supplierId: row.supplierId,
    supplierInvoiceNo: row.supplierInvoiceNo,
    dueDays: row.dueDays,
    dueAtMs: row.dueAtMs,
    knownCostTotal: moneyFromTiyin(liveKnownCostTiyin),
    unknownCostLineCount: remainingUnknownCount,
    note: row.note,
    postedByUserId: row.postedByUserId,
    clientRequestId: row.clientRequestId,
    createdAtMs: row.createdAtMs,
    lines,
  };
}

function buildSupplierReturnRecordSync(
  db: BetterSQLite3Database,
  organizationId: UuidV7,
  storeId: UuidV7,
  returnId: UuidV7,
): StoredSupplierReturnRecord {
  const row = db
    .select()
    .from(supplierReturns)
    .where(
      and(
        eq(supplierReturns.id, returnId),
        eq(supplierReturns.organizationId, organizationId),
        eq(supplierReturns.storeId, storeId),
      ),
    )
    .limit(1)
    .all()[0];
  if (!row) {
    throw new DomainError(
      'SUPPLIER_RETURN_NOT_FOUND',
      `Supplier return "${returnId}" was not found`,
    );
  }

  const lineRows = db
    .select()
    .from(supplierReturnLines)
    .where(eq(supplierReturnLines.supplierReturnId, row.id))
    .orderBy(asc(supplierReturnLines.sortOrder))
    .all();

  return {
    id: row.id,
    organizationId: row.organizationId,
    storeId: row.storeId,
    deviceId: row.deviceId,
    returnNo: row.returnNo,
    returnCode: row.returnCode,
    receivingId: row.receivingId,
    supplierId: row.supplierId,
    reason: row.reason,
    totalReturnCost: row.totalReturnCost,
    createdByUserId: row.createdByUserId,
    clientRequestId: row.clientRequestId,
    createdAtMs: row.createdAtMs,
    lines: lineRows.map((l) => ({
      id: l.id,
      supplierReturnId: l.supplierReturnId,
      receivingLineId: l.receivingLineId,
      sortOrder: l.sortOrder,
      productId: l.productId,
      variantId: l.variantId,
      batchId: l.batchId,
      stockMoveId: l.stockMoveId,
      qty: l.qty,
      returnCostValue: l.returnCostValue,
    })),
  };
}

export class SqliteSupplierStore {
  private readonly connection: LocalSqliteConnection;
  private readonly getRuntimeContext: () => SupplierRuntimeContext | null;

  constructor(options: CreateSqliteSupplierStoreOptions) {
    this.connection = options.connection;
    this.getRuntimeContext = options.getRuntimeContext;
  }

  private requireContext(): SupplierRuntimeContext {
    const ctx = this.getRuntimeContext();
    if (!ctx) {
      throw new DomainError('AUTH_UNAUTHORIZED', 'Hub setup has not completed yet');
    }
    return ctx;
  }

  // --- Suppliers CRUD & Search ---

  async createSupplier(input: CreateSupplierInput): Promise<SupplierSummaryRecord> {
    const ctx = this.requireContext();
    const name = normalizeSupplierName(input.name);
    const nameSearch = normalizeSupplierSearchText(name);
    const tin = normalizeSupplierTin(input.tin);
    const phone = normalizeSupplierPhone(input.phone);
    const contactPerson = normalizeSupplierContactPerson(input.contactPerson);
    const defaultDueDays = normalizeSupplierDueDays(input.defaultDueDays);
    const note = normalizeSupplierNote(input.note);

    return ctx.uow.execute((session) => {
      const nowMs = session.nowUnixMs();
      try {
        const writeRes = insertAttr(session, suppliers, {
          organizationId: ctx.organizationId,
          values: {
            name,
            nameSearch,
            tin,
            phoneNormalized: phone ? phone.phoneNormalized : null,
            phoneDigits: phone ? phone.phoneDigits : null,
            contactPerson,
            defaultDueDays,
            note,
            isActive: true,
          },
          eventType: 'supplier.created',
          schemaVersion: 1,
        });

        upsertSupplierBalanceProjectionSync(session, {
          organizationId: ctx.organizationId,
          supplierId: writeRes.entityId,
          balanceTiyin: 0n,
          totalDebtAccrued: ZERO_MONEY,
          totalCredited: ZERO_MONEY,
          earliestOpenDueAtMs: null,
          lastActivityAtMs: null,
          nowMs,
        });

        const insertedRow = readActiveSupplierRowSync(
          session.db,
          ctx.organizationId,
          writeRes.entityId,
        );
        const hubCfg = readHubSupplierConfigSync(session.db, ctx.organizationId);
        const { fifo, lastActivityAtMs } = readSupplierLedgerFifoSync(session.internalGetSqlite(), {
          organizationId: ctx.organizationId,
          supplierId: insertedRow.id,
          asOfMs: nowMs,
          storeTimezone: hubCfg.storeTimezone,
        });
        return Promise.resolve(toSupplierSummary(insertedRow, fifo, lastActivityAtMs));
      } catch (err) {
        mapSupplierUniqueConstraintError(err);
      }
    });
  }

  async updateSupplier(
    supplierId: UuidV7,
    input: UpdateSupplierInput,
  ): Promise<SupplierSummaryRecord> {
    const ctx = this.requireContext();
    const validId = parseUuidV7(supplierId);

    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) {
      const name = normalizeSupplierName(input.name);
      patch.name = name;
      patch.nameSearch = normalizeSupplierSearchText(name);
    }
    if (input.tin !== undefined) {
      patch.tin = normalizeSupplierTin(input.tin);
    }
    if (input.phone !== undefined) {
      const phone = normalizeSupplierPhone(input.phone);
      patch.phoneNormalized = phone ? phone.phoneNormalized : null;
      patch.phoneDigits = phone ? phone.phoneDigits : null;
    }
    if (input.contactPerson !== undefined) {
      patch.contactPerson = normalizeSupplierContactPerson(input.contactPerson);
    }
    if (input.defaultDueDays !== undefined) {
      patch.defaultDueDays = normalizeSupplierDueDays(input.defaultDueDays);
    }
    if (input.note !== undefined) {
      patch.note = normalizeSupplierNote(input.note);
    }
    if (input.isActive !== undefined) {
      patch.isActive = Boolean(input.isActive);
    }
    if (Object.keys(patch).length === 0) {
      throw new DomainError('VALIDATION_ERROR', 'No supplier fields provided to update');
    }

    return ctx.uow.execute((session) => {
      const nowMs = session.nowUnixMs();
      const existing = readActiveSupplierRowSync(session.db, ctx.organizationId, validId);
      try {
        updateAttr(session, suppliers, {
          id: existing.id,
          organizationId: ctx.organizationId,
          values: patch,
          eventType: 'supplier.updated',
          schemaVersion: 1,
        });
      } catch (err) {
        mapSupplierUniqueConstraintError(err);
      }

      const updated = readActiveSupplierRowSync(session.db, ctx.organizationId, validId);
      const hubCfg = readHubSupplierConfigSync(session.db, ctx.organizationId);
      const { fifo, lastActivityAtMs } = readSupplierLedgerFifoSync(session.internalGetSqlite(), {
        organizationId: ctx.organizationId,
        supplierId: updated.id,
        asOfMs: nowMs,
        storeTimezone: hubCfg.storeTimezone,
      });
      return Promise.resolve(toSupplierSummary(updated, fifo, lastActivityAtMs));
    });
  }

  async archiveSupplier(
    supplierId: UuidV7,
  ): Promise<{ readonly supplierId: UuidV7; readonly deletedAtMs: UnixMs }> {
    const ctx = this.requireContext();
    const validId = parseUuidV7(supplierId);

    return ctx.uow.execute((session) => {
      const nowMs = session.nowUnixMs();
      const row = readActiveSupplierRowSync(session.db, ctx.organizationId, validId);
      const hubCfg = readHubSupplierConfigSync(session.db, ctx.organizationId);
      const { fifo } = readSupplierLedgerFifoSync(session.internalGetSqlite(), {
        organizationId: ctx.organizationId,
        supplierId: row.id,
        asOfMs: nowMs,
        storeTimezone: hubCfg.storeTimezone,
      });

      if (fifo.balanceTiyin !== 0n) {
        throw new DomainError(
          'SUPPLIER_HAS_OPEN_BALANCE',
          'Supplier with non-zero debt or open prepayment balance cannot be archived',
        );
      }

      const deleted = tombstoneAttr(session, suppliers, {
        id: row.id,
        organizationId: ctx.organizationId,
        eventType: 'supplier.deleted',
        schemaVersion: 1,
      });

      return Promise.resolve({
        supplierId: deleted.entityId,
        deletedAtMs: deleted.row.deletedAtMs!,
      });
    });
  }

  async getSupplierDetail(supplierId: UuidV7): Promise<SupplierDetailRecord> {
    const ctx = this.requireContext();
    const validId = parseUuidV7(supplierId);
    return runConnectionReadOnly(this.connection, () => {
      const db = this.connection.db;
      const nowMs = ctx.uow.nowUnixMs();
      const row = readActiveSupplierRowSync(db, ctx.organizationId, validId);
      const hubCfg = readHubSupplierConfigSync(db, ctx.organizationId);
      const { fifo, lastActivityAtMs } = readSupplierLedgerFifoSync(this.connection.sqlite, {
        organizationId: ctx.organizationId,
        supplierId: row.id,
        asOfMs: nowMs,
        storeTimezone: hubCfg.storeTimezone,
      });
      return Promise.resolve({
        supplier: toSupplierSummary(row, fifo, lastActivityAtMs),
        openObligations: fifo.obligations.filter((o) => moneyToTiyin(o.remainingDebt) > 0n),
      });
    });
  }

  async listSuppliers(query?: SupplierListQueryInput): Promise<SupplierListOutcome> {
    const ctx = this.requireContext();
    const limit = query?.limit ?? 50;
    const offset = query?.offset ?? 0;
    const includeInactive = query?.includeInactive ?? false;
    const overdueOnly = query?.overdueOnly ?? false;
    const advanceOnly = query?.advanceOnly ?? false;
    const rawQ = query?.q?.trim() ?? '';

    return runConnectionReadOnly(this.connection, () => {
      const db = this.connection.db;
      const nowMs = ctx.uow.nowUnixMs();
      const hubCfg = readHubSupplierConfigSync(db, ctx.organizationId);

      const orderedParams: (string | number | bigint)[] = [ctx.organizationId];
      const finalWhere: string[] = ['s."organization_id" = ?', 's."deleted_at_ms" IS NULL'];

      if (!includeInactive) {
        finalWhere.push('s."is_active" = 1');
      }
      if (overdueOnly) {
        finalWhere.push(
          'b."balance" > 0 AND b."earliest_open_due_at_ms" IS NOT NULL AND b."earliest_open_due_at_ms" <= ?',
        );
        orderedParams.push(BigInt(nowMs));
      }
      if (advanceOnly) {
        finalWhere.push('b."balance" < 0');
      }

      if (rawQ.length > 0) {
        const cleanQuery = normalizeSupplierSearchQuery(rawQ);
        const digitsOnly = rawQ.replace(/\D/g, '');
        const ftsExpr = buildFtsPrefixQuery(cleanQuery);
        if (ftsExpr === null && digitsOnly.length === 0) {
          return Promise.resolve({ items: [], total: 0, limit, offset });
        }

        const unionBranches: string[] = [];
        if (ftsExpr !== null) {
          unionBranches.push(
            `SELECT "supplier_id" AS "matched_id" FROM "suppliers_fts" WHERE "organization_id" = ? AND "suppliers_fts" MATCH ?`,
          );
          orderedParams.push(ctx.organizationId, ftsExpr);
        }
        if (digitsOnly.length > 0) {
          if (digitsOnly.length >= 3) {
            unionBranches.push(
              `SELECT "id" AS "matched_id" FROM "suppliers" WHERE "organization_id" = ? AND "deleted_at_ms" IS NULL AND ("tin" = ? OR "tin" LIKE ? OR "phone_digits" LIKE ?)`,
            );
            orderedParams.push(ctx.organizationId, digitsOnly, `${digitsOnly}%`, `%${digitsOnly}%`);
          } else {
            unionBranches.push(
              `SELECT "id" AS "matched_id" FROM "suppliers" WHERE "organization_id" = ? AND "deleted_at_ms" IS NULL AND ("tin" = ? OR "tin" LIKE ?)`,
            );
            orderedParams.push(ctx.organizationId, digitsOnly, `${digitsOnly}%`);
          }
        }

        finalWhere.push(`s."id" IN (${unionBranches.join(' UNION ')})`);
      }

      orderedParams.push(limit, offset);

      const sqlQuery = `
        SELECT
          s."id",
          s."organization_id",
          s."name",
          s."tin",
          s."phone_normalized",
          s."contact_person",
          s."default_due_days",
          s."note",
          s."is_active",
          s."created_at_ms",
          s."updated_at_ms",
          COALESCE(b."balance", 0) AS "balance",
          COALESCE(b."total_debt_accrued", 0) AS "total_debt_accrued",
          COALESCE(b."total_credited", 0) AS "total_credited",
          b."earliest_open_due_at_ms" AS "earliest_open_due_at_ms",
          b."last_activity_at_ms" AS "last_activity_at_ms",
          COUNT(*) OVER() AS "total_matched"
        FROM "suppliers" s
        LEFT JOIN "local_supplier_balances" b ON b."supplier_id" = s."id"
        WHERE ${finalWhere.join(' AND ')}
        ORDER BY s."name_search" ASC, s."id" ASC
        LIMIT ? OFFSET ?
      `;

      const rows = this.connection.sqlite
        .prepare(sqlQuery)
        .safeIntegers(true)
        .all(...orderedParams) as Array<{
        readonly id: string;
        readonly organization_id: string;
        readonly name: string;
        readonly tin: string | null;
        readonly phone_normalized: string | null;
        readonly contact_person: string | null;
        readonly default_due_days: bigint | number | null;
        readonly note: string | null;
        readonly is_active: bigint | number;
        readonly created_at_ms: bigint | number;
        readonly updated_at_ms: bigint | number;
        readonly balance: bigint | number;
        readonly total_debt_accrued: bigint | number;
        readonly total_credited: bigint | number;
        readonly earliest_open_due_at_ms: bigint | number | null;
        readonly last_activity_at_ms: bigint | number | null;
        readonly total_matched: bigint | number;
      }>;

      const total = rows.length > 0 && rows[0] ? Number(rows[0].total_matched) : 0;
      const nowBig = BigInt(nowMs);
      const items: SupplierSummaryRecord[] = rows.map((r) => {
        const balanceTiyin = toBigInt(r.balance);
        const earliestDueBig =
          r.earliest_open_due_at_ms !== null ? toBigInt(r.earliest_open_due_at_ms) : null;

        let overdueAmount = ZERO_MONEY;
        let oldestOverdueDays = 0;

        if (balanceTiyin > 0n && earliestDueBig !== null && earliestDueBig <= nowBig) {
          const { fifo } = readSupplierLedgerFifoSync(this.connection.sqlite, {
            organizationId: ctx.organizationId,
            supplierId: r.id as UuidV7,
            asOfMs: nowMs,
            storeTimezone: hubCfg.storeTimezone,
          });
          overdueAmount = fifo.overdueAmount;
          oldestOverdueDays = Number(fifo.oldestOverdueDays);
        }

        return {
          id: r.id as UuidV7,
          organizationId: r.organization_id as UuidV7,
          name: r.name,
          tin: r.tin,
          phoneNormalized: r.phone_normalized,
          contactPerson: r.contact_person,
          defaultDueDays: r.default_due_days !== null ? Number(toBigInt(r.default_due_days)) : null,
          note: r.note,
          isActive: toBigInt(r.is_active) === 1n,
          balance: moneyFromTiyin(balanceTiyin),
          debtBalance: balanceTiyin > 0n ? moneyFromTiyin(balanceTiyin) : ZERO_MONEY,
          advanceBalance: balanceTiyin < 0n ? moneyFromTiyin(-balanceTiyin) : ZERO_MONEY,
          totalDebtAccrued: moneyFromTiyin(toBigInt(r.total_debt_accrued)),
          totalCredited: moneyFromTiyin(toBigInt(r.total_credited)),
          overdueAmount,
          oldestOverdueDays,
          lastActivityAtMs: toNullableUnixMs(r.last_activity_at_ms),
          createdAtMs: unixMsFromBigInt(toBigInt(r.created_at_ms)),
          updatedAtMs: unixMsFromBigInt(toBigInt(r.updated_at_ms)),
        };
      });

      return Promise.resolve({ items, total, limit, offset });
    });
  }

  async listOverdueSuppliers(query?: SupplierListQueryInput): Promise<SupplierListOutcome> {
    return this.listSuppliers({
      ...query,
      overdueOnly: true,
    });
  }

  // --- Receiving Drafts (`draft -> posted / cancelled`) ---

  async createReceivingDraft(
    input: CreateReceivingDraftInput,
  ): Promise<StoredReceivingDraftRecord> {
    const ctx = this.requireContext();
    const validSupplierId = parseUuidV7(input.supplierId);
    const validActorId = parseUuidV7(input.actorUserId);
    const supplierInvoiceNo = normalizeSupplierInvoiceNo(input.supplierInvoiceNo);
    const dueDays = normalizeSupplierDueDays(input.dueDays);
    const note = normalizeSupplierNote(input.note);
    const rawLines = input.lines ?? [];

    return ctx.uow.execute((session) => {
      const nowMs = session.nowUnixMs();
      readActiveSupplierRowSync(session.db, ctx.organizationId, validSupplierId);
      const preparedLines = validateAndPrepareReceivingLinesSync(
        session.db,
        ctx.organizationId,
        rawLines,
      );

      const draftId = session.nextId();
      session.db
        .insert(localReceivingDrafts)
        .values({
          id: draftId,
          organizationId: ctx.organizationId,
          storeId: ctx.storeId,
          supplierId: validSupplierId,
          supplierInvoiceNo,
          dueDays,
          note,
          status: 'draft',
          createdByUserId: validActorId,
          postedAtMs: null,
          cancelledAtMs: null,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
        })
        .run();

      for (let i = 0; i < preparedLines.length; i += 1) {
        const pl = preparedLines[i];
        session.db
          .insert(localReceivingDraftLines)
          .values({
            id: session.nextId(),
            organizationId: ctx.organizationId,
            storeId: ctx.storeId,
            draftId,
            sortOrder: i,
            productId: pl.productId,
            variantId: pl.variantId,
            qty: pl.qty,
            costUnknown: pl.costUnknown,
            totalCostValue: pl.totalCostValue,
            vatRateBp: pl.vatRateBp,
            vatAmount: pl.vatAmount,
            batchNumber: pl.batchNumber,
            expiryDateMs: pl.expiryDateMs,
            createdAtMs: nowMs,
            updatedAtMs: nowMs,
          })
          .run();
      }

      return Promise.resolve(
        buildReceivingDraftRecordSync(session.db, ctx.organizationId, ctx.storeId, draftId),
      );
    });
  }

  async getReceivingDraft(draftId: UuidV7): Promise<StoredReceivingDraftRecord> {
    const ctx = this.requireContext();
    const validId = parseUuidV7(draftId);
    return runConnectionReadOnly(this.connection, () =>
      Promise.resolve(
        buildReceivingDraftRecordSync(this.connection.db, ctx.organizationId, ctx.storeId, validId),
      ),
    );
  }

  async updateReceivingDraft(
    draftId: UuidV7,
    input: UpdateReceivingDraftInput,
  ): Promise<StoredReceivingDraftRecord> {
    const ctx = this.requireContext();
    const validId = parseUuidV7(draftId);

    return ctx.uow.execute((session) => {
      const nowMs = session.nowUnixMs();
      const draft = session.db
        .select()
        .from(localReceivingDrafts)
        .where(
          and(
            eq(localReceivingDrafts.id, validId),
            eq(localReceivingDrafts.organizationId, ctx.organizationId),
            eq(localReceivingDrafts.storeId, ctx.storeId),
          ),
        )
        .limit(1)
        .all()[0];
      if (!draft) {
        throw new DomainError('RECEIVING_NOT_FOUND', `Receiving draft "${validId}" was not found`);
      }
      if (draft.status !== 'draft') {
        throw new DomainError(
          'RECEIVING_NOT_DRAFT',
          `Receiving "${validId}" is already ${draft.status} and cannot be edited`,
        );
      }

      const patch: Record<string, unknown> = { updatedAtMs: nowMs };
      if (input.supplierId !== undefined) {
        const sup = readActiveSupplierRowSync(session.db, ctx.organizationId, input.supplierId);
        patch.supplierId = sup.id;
      }
      if (input.supplierInvoiceNo !== undefined) {
        patch.supplierInvoiceNo = normalizeSupplierInvoiceNo(input.supplierInvoiceNo);
      }
      if (input.dueDays !== undefined) {
        patch.dueDays = normalizeSupplierDueDays(input.dueDays);
      }
      if (input.note !== undefined) {
        patch.note = normalizeSupplierNote(input.note);
      }

      let preparedLines: readonly NormalizedReceivingLinePrepared[] | null = null;
      if (input.lines !== undefined) {
        preparedLines = validateAndPrepareReceivingLinesSync(
          session.db,
          ctx.organizationId,
          input.lines,
        );
      }

      session.db
        .update(localReceivingDrafts)
        .set(patch)
        .where(eq(localReceivingDrafts.id, draft.id))
        .run();

      if (preparedLines !== null) {
        session.db
          .delete(localReceivingDraftLines)
          .where(eq(localReceivingDraftLines.draftId, draft.id))
          .run();

        for (let i = 0; i < preparedLines.length; i += 1) {
          const pl = preparedLines[i];
          session.db
            .insert(localReceivingDraftLines)
            .values({
              id: session.nextId(),
              organizationId: ctx.organizationId,
              storeId: ctx.storeId,
              draftId: draft.id,
              sortOrder: i,
              productId: pl.productId,
              variantId: pl.variantId,
              qty: pl.qty,
              costUnknown: pl.costUnknown,
              totalCostValue: pl.totalCostValue,
              vatRateBp: pl.vatRateBp,
              vatAmount: pl.vatAmount,
              batchNumber: pl.batchNumber,
              expiryDateMs: pl.expiryDateMs,
              createdAtMs: nowMs,
              updatedAtMs: nowMs,
            })
            .run();
        }
      }

      return Promise.resolve(
        buildReceivingDraftRecordSync(session.db, ctx.organizationId, ctx.storeId, draft.id),
      );
    });
  }

  async cancelReceivingDraft(draftId: UuidV7): Promise<StoredReceivingDraftRecord> {
    const ctx = this.requireContext();
    const validId = parseUuidV7(draftId);

    return ctx.uow.execute((session) => {
      const nowMs = session.nowUnixMs();
      const draft = session.db
        .select()
        .from(localReceivingDrafts)
        .where(
          and(
            eq(localReceivingDrafts.id, validId),
            eq(localReceivingDrafts.organizationId, ctx.organizationId),
            eq(localReceivingDrafts.storeId, ctx.storeId),
          ),
        )
        .limit(1)
        .all()[0];
      if (!draft) {
        throw new DomainError('RECEIVING_NOT_FOUND', `Receiving draft "${validId}" was not found`);
      }
      if (draft.status !== 'draft') {
        throw new DomainError(
          'RECEIVING_NOT_DRAFT',
          `Receiving "${validId}" is already ${draft.status} and cannot be cancelled`,
        );
      }

      session.db
        .update(localReceivingDrafts)
        .set({
          status: 'cancelled',
          cancelledAtMs: nowMs,
          updatedAtMs: nowMs,
        })
        .where(eq(localReceivingDrafts.id, draft.id))
        .run();

      return Promise.resolve(
        buildReceivingDraftRecordSync(session.db, ctx.organizationId, ctx.storeId, draft.id),
      );
    });
  }

  // --- Atomic Posting (`postReceiving`) ---

  async postReceiving(draftId: UuidV7, input: PostReceivingInput): Promise<PostReceivingOutcome> {
    const ctx = this.requireContext();
    const validDraftId = parseUuidV7(draftId);
    const validActorId = parseUuidV7(input.actorUserId);
    const validReqId = parseUuidV7(input.clientRequestId);

    return ctx.uow.execute<PostReceivingOutcome>((session) => {
      const nowMs = session.nowUnixMs();
      const hubCfg = readHubSupplierConfigSync(session.db, ctx.organizationId);

      // Idempotency replay check by (organizationId, clientRequestId)
      const existingByReq = session.db
        .select()
        .from(goodsReceivings)
        .where(
          and(
            eq(goodsReceivings.organizationId, ctx.organizationId),
            eq(goodsReceivings.clientRequestId, validReqId),
          ),
        )
        .limit(1)
        .all()[0];

      const draft = session.db
        .select()
        .from(localReceivingDrafts)
        .where(
          and(
            eq(localReceivingDrafts.id, validDraftId),
            eq(localReceivingDrafts.organizationId, ctx.organizationId),
            eq(localReceivingDrafts.storeId, ctx.storeId),
          ),
        )
        .limit(1)
        .all()[0];

      if (existingByReq) {
        if (!draft) {
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            `clientRequestId "${validReqId}" was already used for another receiving`,
          );
        }
        const draftLinesForHash = session.db
          .select()
          .from(localReceivingDraftLines)
          .where(eq(localReceivingDraftLines.draftId, draft.id))
          .orderBy(asc(localReceivingDraftLines.sortOrder))
          .all();
        const replayHash = sha256Hex(
          canonicalizePostReceivingRequest({
            draftId: draft.id,
            supplierId: draft.supplierId,
            supplierInvoiceNo: draft.supplierInvoiceNo,
            dueDays: draft.dueDays,
            linesSnapshot: draftLinesForHash.map((l) => ({
              productId: l.productId,
              variantId: l.variantId,
              qty: l.qty,
              costUnknown: l.costUnknown,
              totalCostValue: l.costUnknown ? ZERO_MONEY : (l.totalCostValue ?? ZERO_MONEY),
            })),
          }),
        );
        if (existingByReq.requestHash !== replayHash) {
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            `clientRequestId "${validReqId}" was already used with a different receiving payload`,
          );
        }
        const sup = readActiveSupplierRowSync(
          session.db,
          ctx.organizationId,
          existingByReq.supplierId,
        );
        const { fifo, lastActivityAtMs } = readSupplierLedgerFifoSync(session.internalGetSqlite(), {
          organizationId: ctx.organizationId,
          supplierId: sup.id,
          asOfMs: nowMs,
          storeTimezone: hubCfg.storeTimezone,
        });
        return Promise.resolve({
          receiving: buildPostedReceivingRecordSync(
            session.db,
            ctx.organizationId,
            ctx.storeId,
            existingByReq.id,
          ),
          supplier: toSupplierSummary(sup, fifo, lastActivityAtMs),
          idempotentReplay: true,
        });
      }

      if (!draft) {
        throw new DomainError(
          'RECEIVING_NOT_FOUND',
          `Receiving draft "${validDraftId}" was not found`,
        );
      }
      if (draft.status !== 'draft') {
        throw new DomainError(
          'RECEIVING_NOT_DRAFT',
          `Receiving "${validDraftId}" is ${draft.status} and cannot be posted`,
        );
      }

      const rawDraftLines = session.db
        .select()
        .from(localReceivingDraftLines)
        .where(eq(localReceivingDraftLines.draftId, draft.id))
        .orderBy(asc(localReceivingDraftLines.sortOrder))
        .all();
      if (rawDraftLines.length === 0) {
        throw new DomainError('RECEIVING_EMPTY', 'Cannot post a receiving with zero lines');
      }

      const supplier = readActiveSupplierRowSync(session.db, ctx.organizationId, draft.supplierId);
      // E3: Reject new receiving for inactive supplier with 0 DB writes
      if (!supplier.isActive) {
        throw new DomainError(
          'SUPPLIER_INACTIVE',
          'Inactive supplier cannot accept new receiving documents',
        );
      }

      const preparedLines = validateAndPrepareReceivingLinesSync(
        session.db,
        ctx.organizationId,
        rawDraftLines.map((l) => ({
          productId: l.productId,
          variantId: l.variantId,
          qty: l.qty,
          costUnknown: l.costUnknown,
          totalCostValue: l.totalCostValue,
          vatRateBp: l.vatRateBp,
          vatAmount: l.vatAmount,
          batchNumber: l.batchNumber,
          expiryDateMs: l.expiryDateMs,
        })),
      );

      let knownCostTiyin = 0n;
      let unknownCostLineCount = 0;
      for (const pl of preparedLines) {
        if (pl.costUnknown) {
          unknownCostLineCount += 1;
        } else if (pl.totalCostValue !== null) {
          knownCostTiyin += moneyToTiyin(pl.totalCostValue);
        }
      }
      if (!isSignedInt64Money(knownCostTiyin) || knownCostTiyin > MAX_MONEY_TIYIN) {
        throw new DomainError('VALIDATION_ERROR', 'Receiving total exceeds bounded 64-bit limit');
      }
      const knownCostTotal = moneyFromTiyin(knownCostTiyin);

      const requestHash = sha256Hex(
        canonicalizePostReceivingRequest({
          draftId: draft.id,
          supplierId: draft.supplierId,
          supplierInvoiceNo: draft.supplierInvoiceNo,
          dueDays: draft.dueDays,
          linesSnapshot: preparedLines.map((pl) => ({
            productId: pl.productId,
            variantId: pl.variantId,
            qty: pl.qty,
            costUnknown: pl.costUnknown,
            totalCostValue: pl.costUnknown ? ZERO_MONEY : (pl.totalCostValue ?? ZERO_MONEY),
          })),
        }),
      );

      const effectiveDueDays =
        draft.dueDays ?? supplier.defaultDueDays ?? hubCfg.defaultSupplierDueDays;
      const dueAtMs =
        effectiveDueDays !== null
          ? computeSupplierDueAtMs({
              createdAtMs: nowMs,
              dueDays: effectiveDueDays,
              storeTimezone: hubCfg.storeTimezone,
              resolveTimeZoneDateKey: resolveIntlDateKey,
            })
          : null;

      // Batch prefetch all pool states BEFORE mutating anything to avoid N+1 on 100-line receivings
      const prefetchTargetsMap = new Map<string, StockPoolPrefetchTarget>();
      for (const pl of preparedLines) {
        const key = stockPoolKey(pl.productId, pl.variantId);
        if (!prefetchTargetsMap.has(key)) {
          prefetchTargetsMap.set(key, {
            productId: pl.productId,
            variantId: pl.variantId,
            trackBatches: Boolean(pl.product.trackBatches),
          });
        }
      }
      const sessionPoolCache = prefetchMutablePoolStatesSync(session, {
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        targets: [...prefetchTargetsMap.values()],
      });

      const sqlite = session.internalGetSqlite();
      const receivingNo = advanceReceivingSeqSync(sqlite, {
        deviceId: session.deviceId,
        updatedAtMs: BigInt(nowMs),
      });
      const receivingCode = formatReceivingCode(session.deviceId, receivingNo);

      // 1) Parent goods_receivings FACT row
      const rcvWrite = insertFact(session, goodsReceivings, {
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        values: {
          receivingNo,
          receivingCode,
          supplierId: supplier.id,
          supplierInvoiceNo: draft.supplierInvoiceNo,
          dueDays: effectiveDueDays,
          dueAtMs,
          knownCostTotal,
          unknownCostLineCount,
          note: draft.note,
          postedByUserId: validActorId,
          clientRequestId: validReqId,
          requestHash,
        },
        eventType: 'goods_receiving.posted',
        schemaVersion: 1,
      });
      const receivingId = rcvWrite.entityId;

      // 2) Lines: stock move + optional batch + goods_receiving_lines FACT row
      for (let i = 0; i < preparedLines.length; i += 1) {
        const pl = preparedLines[i];
        const inbound = applyInboundStockMoveSync(session, {
          organizationId: ctx.organizationId,
          storeId: ctx.storeId,
          productId: pl.productId,
          variantId: pl.variantId,
          reason: 'purchase',
          qty: pl.qty,
          totalCostValue: pl.costUnknown ? ZERO_MONEY : (pl.totalCostValue ?? ZERO_MONEY),
          batchNumber: pl.batchNumber,
          expiryDateMs: pl.expiryDateMs,
          sourceType: 'purchase',
          sourceId: receivingId,
          note: draft.note ?? `Goods receiving ${receivingCode}`,
          actorUserId: validActorId,
          supplierId: supplier.id,
          isUnknownCost: pl.costUnknown,
          prefetchedProduct: pl.product,
          sessionPoolCache,
        });

        insertFact(session, goodsReceivingLines, {
          organizationId: ctx.organizationId,
          storeId: ctx.storeId,
          values: {
            receivingId,
            sortOrder: i,
            productId: pl.productId,
            variantId: pl.variantId,
            qty: pl.qty,
            costUnknown: pl.costUnknown,
            initialTotalCost: pl.costUnknown ? ZERO_MONEY : (pl.totalCostValue ?? ZERO_MONEY),
            vatRateBp: pl.vatRateBp,
            vatAmount: pl.vatAmount,
            stockMoveId: inbound.move.id,
            batchId: inbound.batch?.id ?? null,
            batchNumber: pl.batchNumber,
            expiryDateMs: pl.expiryDateMs,
          },
          eventType: 'goods_receiving_line.created',
          schemaVersion: 1,
        });
      }

      // 3) Supplier ledger `receiving_debt` ONLY if knownCostTotal > 0n (SQLite CHECK forbids 0)
      if (knownCostTiyin > 0n) {
        const { fifo: beforeFifo } = readSupplierLedgerFifoSync(sqlite, {
          organizationId: ctx.organizationId,
          supplierId: supplier.id,
          asOfMs: nowMs,
          storeTimezone: hubCfg.storeTimezone,
        });
        computeNextSupplierBalance({
          currentBalanceTiyin: beforeFifo.balanceTiyin,
          deltaTiyin: knownCostTiyin,
          operation: 'receiving_debt',
        });

        insertFact(session, supplierLedger, {
          organizationId: ctx.organizationId,
          storeId: ctx.storeId,
          values: {
            supplierId: supplier.id,
            entryType: 'receiving_debt',
            amountDelta: knownCostTotal,
            sourceType: 'receiving',
            sourceId: receivingId,
            receivingId,
            supplierReturnId: null,
            paymentMethod: null,
            providerRef: null,
            cashMoveId: null,
            dueAtMs,
            reason: `Receiving ${receivingCode}`,
            createdByUserId: validActorId,
            clientRequestId: null,
            requestHash: null,
          },
          eventType: 'supplier_ledger.created',
          schemaVersion: 1,
        });
      }

      // 4) Recompute FIFO + update local balance projection (auto-applies any open advance!)
      const { fifo: afterFifo, lastActivityAtMs } = readSupplierLedgerFifoSync(sqlite, {
        organizationId: ctx.organizationId,
        supplierId: supplier.id,
        asOfMs: nowMs,
        storeTimezone: hubCfg.storeTimezone,
      });
      upsertSupplierBalanceProjectionSync(session, {
        organizationId: ctx.organizationId,
        supplierId: supplier.id,
        balanceTiyin: afterFifo.balanceTiyin,
        totalDebtAccrued: afterFifo.totalDebtAccrued,
        totalCredited: afterFifo.totalCredited,
        earliestOpenDueAtMs: afterFifo.earliestOpenDueAtMs,
        lastActivityAtMs,
        nowMs,
      });

      // 5) Transition draft -> posted
      session.db
        .update(localReceivingDrafts)
        .set({
          status: 'posted',
          postedAtMs: nowMs,
          updatedAtMs: nowMs,
        })
        .where(eq(localReceivingDrafts.id, draft.id))
        .run();

      return Promise.resolve({
        receiving: buildPostedReceivingRecordSync(
          session.db,
          ctx.organizationId,
          ctx.storeId,
          receivingId,
        ),
        supplier: toSupplierSummary(supplier, afterFifo, lastActivityAtMs),
        idempotentReplay: false,
      });
    });
  }

  async getReceiving(receivingId: UuidV7): Promise<StoredReceivingRecord> {
    const ctx = this.requireContext();
    const validId = parseUuidV7(receivingId);
    return runConnectionReadOnly(this.connection, () =>
      Promise.resolve(
        buildPostedReceivingRecordSync(
          this.connection.db,
          ctx.organizationId,
          ctx.storeId,
          validId,
        ),
      ),
    );
  }

  async listReceivings(query?: ReceivingListQueryInput): Promise<ReceivingListOutcome> {
    const ctx = this.requireContext();
    const limit = query?.limit ?? 50;
    const offset = query?.offset ?? 0;
    const statusFilter = query?.status;
    const supplierIdFilter = query?.supplierId !== undefined ? parseUuidV7(query.supplierId) : null;
    const costUnknownOnly = query?.costUnknownOnly ?? false;

    return runConnectionReadOnly(this.connection, () => {
      const nowSelectParts: string[] = [];
      const params: (string | number | bigint)[] = [];

      const includePosted = statusFilter === undefined || statusFilter === 'posted';
      const includeDrafts =
        statusFilter === undefined || statusFilter === 'draft' || statusFilter === 'cancelled';

      if (includePosted) {
        const postedWhere = ['r."organization_id" = ?', 'r."store_id" = ?'];
        params.push(ctx.organizationId, ctx.storeId);
        if (supplierIdFilter !== null) {
          postedWhere.push('r."supplier_id" = ?');
          params.push(supplierIdFilter);
        }
        if (costUnknownOnly) {
          postedWhere.push(
            'EXISTS (SELECT 1 FROM "goods_receiving_lines" grl LEFT JOIN "receiving_cost_confirmations" rcc ON rcc."receiving_line_id" = grl."id" WHERE grl."receiving_id" = r."id" AND grl."cost_unknown" = 1 AND rcc."id" IS NULL)',
          );
        }
        nowSelectParts.push(`
          SELECT
            r."id" AS "id",
            'posted' AS "status",
            r."receiving_no" AS "receiving_no",
            r."receiving_code" AS "receiving_code",
            r."supplier_id" AS "supplier_id",
            r."supplier_invoice_no" AS "supplier_invoice_no",
            (r."known_cost_total" + COALESCE((SELECT SUM(rcc."confirmed_total_cost") FROM "receiving_cost_confirmations" rcc WHERE rcc."receiving_id" = r."id"), 0)) AS "known_cost_total",
            (SELECT COUNT(*) FROM "goods_receiving_lines" grl LEFT JOIN "receiving_cost_confirmations" rcc ON rcc."receiving_line_id" = grl."id" WHERE grl."receiving_id" = r."id" AND grl."cost_unknown" = 1 AND rcc."id" IS NULL) AS "unknown_cost_line_count",
            (SELECT COUNT(*) FROM "goods_receiving_lines" grl WHERE grl."receiving_id" = r."id") AS "line_count",
            r."created_at_ms" AS "created_at_ms",
            r."created_at_ms" AS "posted_at_ms"
          FROM "goods_receivings" r
          WHERE ${postedWhere.join(' AND ')}
        `);
      }

      if (includeDrafts) {
        const draftWhere = ['d."organization_id" = ?', 'd."store_id" = ?'];
        params.push(ctx.organizationId, ctx.storeId);
        if (statusFilter !== undefined) {
          draftWhere.push('d."status" = ?');
          params.push(statusFilter);
        } else {
          draftWhere.push(`d."status" IN ('draft', 'cancelled')`);
        }
        if (supplierIdFilter !== null) {
          draftWhere.push('d."supplier_id" = ?');
          params.push(supplierIdFilter);
        }
        if (costUnknownOnly) {
          draftWhere.push(
            'EXISTS (SELECT 1 FROM "local_receiving_draft_lines" dl WHERE dl."draft_id" = d."id" AND dl."cost_unknown" = 1)',
          );
        }
        nowSelectParts.push(`
          SELECT
            d."id" AS "id",
            d."status" AS "status",
            NULL AS "receiving_no",
            NULL AS "receiving_code",
            d."supplier_id" AS "supplier_id",
            d."supplier_invoice_no" AS "supplier_invoice_no",
            COALESCE((SELECT SUM(dl."total_cost_value") FROM "local_receiving_draft_lines" dl WHERE dl."draft_id" = d."id" AND dl."cost_unknown" = 0), 0) AS "known_cost_total",
            (SELECT COUNT(*) FROM "local_receiving_draft_lines" dl WHERE dl."draft_id" = d."id" AND dl."cost_unknown" = 1) AS "unknown_cost_line_count",
            (SELECT COUNT(*) FROM "local_receiving_draft_lines" dl WHERE dl."draft_id" = d."id") AS "line_count",
            d."created_at_ms" AS "created_at_ms",
            d."posted_at_ms" AS "posted_at_ms"
          FROM "local_receiving_drafts" d
          WHERE ${draftWhere.join(' AND ')}
        `);
      }

      if (nowSelectParts.length === 0) {
        return Promise.resolve({ items: [], total: 0, limit, offset });
      }

      params.push(limit, offset);
      const unionSql = `
        WITH combined AS (
          ${nowSelectParts.join(' UNION ALL ')}
        )
        SELECT *, COUNT(*) OVER() AS "total_matched"
        FROM combined
        ORDER BY "created_at_ms" DESC, "id" DESC
        LIMIT ? OFFSET ?
      `;

      const rows = this.connection.sqlite
        .prepare(unionSql)
        .safeIntegers(true)
        .all(...params) as Array<{
        readonly id: string;
        readonly status: string;
        readonly receiving_no: bigint | number | null;
        readonly receiving_code: string | null;
        readonly supplier_id: string;
        readonly supplier_invoice_no: string | null;
        readonly known_cost_total: bigint | number;
        readonly unknown_cost_line_count: bigint | number;
        readonly line_count: bigint | number;
        readonly created_at_ms: bigint | number;
        readonly posted_at_ms: bigint | number | null;
        readonly total_matched: bigint | number;
      }>;

      const total = rows.length > 0 && rows[0] ? Number(rows[0].total_matched) : 0;
      const items: ReceivingListItemRecord[] = rows.map((r) => ({
        id: r.id as UuidV7,
        status: r.status as ReceivingDraftStatus,
        receivingNo: r.receiving_no !== null ? toBigInt(r.receiving_no) : null,
        receivingCode: r.receiving_code,
        supplierId: r.supplier_id as UuidV7,
        supplierInvoiceNo: r.supplier_invoice_no,
        knownCostTotal: moneyFromTiyin(toBigInt(r.known_cost_total)),
        unknownCostLineCount: Number(toBigInt(r.unknown_cost_line_count)),
        lineCount: Number(toBigInt(r.line_count)),
        createdAtMs: unixMsFromBigInt(toBigInt(r.created_at_ms)),
        postedAtMs: toNullableUnixMs(r.posted_at_ms),
      }));

      return Promise.resolve({ items, total, limit, offset });
    });
  }

  // --- E1: Confirm Cost of Unknown-Cost Receiving Line ---

  async confirmReceivingLineCost(
    receivingId: UuidV7,
    receivingLineId: UuidV7,
    input: ConfirmReceivingLineCostInput,
  ): Promise<ConfirmReceivingCostOutcome> {
    const ctx = this.requireContext();
    const validRcvId = parseUuidV7(receivingId);
    const validLineId = parseUuidV7(receivingLineId);
    const validActorId = parseUuidV7(input.actorUserId);
    const validReqId = parseUuidV7(input.clientRequestId);
    const validReason = normalizeMandatoryReason(input.reason);
    const confirmedTiyin = moneyToTiyin(input.confirmedTotalCost);
    if (
      confirmedTiyin < 0n ||
      !isSignedInt64Money(confirmedTiyin) ||
      confirmedTiyin > MAX_MONEY_TIYIN
    ) {
      throw new DomainError(
        'VALIDATION_ERROR',
        'confirmedTotalCost must be non-negative bounded money',
      );
    }
    const validDueDays =
      input.dueDays !== undefined ? normalizeSupplierDueDays(input.dueDays) : undefined;

    const requestHash = sha256Hex(
      canonicalizeConfirmReceivingCostRequest({
        receivingId: validRcvId,
        receivingLineId: validLineId,
        confirmedTotalCost: input.confirmedTotalCost,
        reason: validReason,
        dueDays: validDueDays ?? null,
      }),
    );

    return ctx.uow.execute<ConfirmReceivingCostOutcome>((session) => {
      const nowMs = session.nowUnixMs();
      const sqlite = session.internalGetSqlite();
      const hubCfg = readHubSupplierConfigSync(session.db, ctx.organizationId);

      // Idempotency replay by (organizationId, clientRequestId)
      const existingReq = session.db
        .select()
        .from(receivingCostConfirmations)
        .where(
          and(
            eq(receivingCostConfirmations.organizationId, ctx.organizationId),
            eq(receivingCostConfirmations.clientRequestId, validReqId),
          ),
        )
        .limit(1)
        .all()[0];
      if (existingReq) {
        if (existingReq.requestHash !== requestHash) {
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            `clientRequestId "${validReqId}" was already used for another cost confirmation`,
          );
        }
        const sup = readActiveSupplierRowSync(
          session.db,
          ctx.organizationId,
          existingReq.supplierId,
        );
        const { fifo, lastActivityAtMs } = readSupplierLedgerFifoSync(sqlite, {
          organizationId: ctx.organizationId,
          supplierId: sup.id,
          asOfMs: nowMs,
          storeTimezone: hubCfg.storeTimezone,
        });
        return Promise.resolve({
          confirmation: toStoredCostConfirmation(existingReq),
          receiving: buildPostedReceivingRecordSync(
            session.db,
            ctx.organizationId,
            ctx.storeId,
            existingReq.receivingId,
          ),
          supplier: toSupplierSummary(sup, fifo, lastActivityAtMs),
          idempotentReplay: true,
        });
      }

      const rcv = session.db
        .select()
        .from(goodsReceivings)
        .where(
          and(
            eq(goodsReceivings.id, validRcvId),
            eq(goodsReceivings.organizationId, ctx.organizationId),
            eq(goodsReceivings.storeId, ctx.storeId),
          ),
        )
        .limit(1)
        .all()[0];
      if (!rcv) {
        throw new DomainError('RECEIVING_NOT_FOUND', `Receiving "${validRcvId}" was not found`);
      }

      const line = session.db
        .select()
        .from(goodsReceivingLines)
        .where(
          and(eq(goodsReceivingLines.id, validLineId), eq(goodsReceivingLines.receivingId, rcv.id)),
        )
        .limit(1)
        .all()[0];
      if (!line) {
        throw new DomainError(
          'RECEIVING_LINE_NOT_FOUND',
          `Receiving line "${validLineId}" was not found on receiving "${validRcvId}"`,
        );
      }

      if (!line.costUnknown) {
        throw new DomainError(
          'RECEIVING_LINE_COST_ALREADY_CONFIRMED',
          'Receiving line already had a known cost at posting time',
        );
      }

      const existingForLine = session.db
        .select()
        .from(receivingCostConfirmations)
        .where(
          and(
            eq(receivingCostConfirmations.organizationId, ctx.organizationId),
            eq(receivingCostConfirmations.receivingLineId, line.id),
          ),
        )
        .limit(1)
        .all()[0];
      if (existingForLine) {
        throw new DomainError(
          'RECEIVING_LINE_COST_ALREADY_CONFIRMED',
          'Receiving line cost has already been confirmed',
        );
      }

      // E3 note: deliberately permits cost confirmation even if supplier.isActive === false
      const supplier = readActiveSupplierRowSync(session.db, ctx.organizationId, rcv.supplierId);
      const effectiveDueDays =
        validDueDays !== undefined
          ? validDueDays
          : (rcv.dueDays ?? supplier.defaultDueDays ?? hubCfg.defaultSupplierDueDays);
      const dueAtMs =
        effectiveDueDays !== null
          ? computeSupplierDueAtMs({
              createdAtMs: nowMs,
              dueDays: effectiveDueDays,
              storeTimezone: hubCfg.storeTimezone,
              resolveTimeZoneDateKey: resolveIntlDateKey,
            })
          : null;

      // 1) Append immutable confirmation FACT doc
      const confWrite = insertFact(session, receivingCostConfirmations, {
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        values: {
          receivingId: rcv.id,
          receivingLineId: line.id,
          supplierId: supplier.id,
          productId: line.productId,
          variantId: line.variantId,
          batchId: line.batchId,
          receivedQty: line.qty,
          confirmedTotalCost: input.confirmedTotalCost,
          dueDays: effectiveDueDays,
          dueAtMs,
          reason: validReason,
          confirmedByUserId: validActorId,
          clientRequestId: validReqId,
          requestHash,
        },
        eventType: 'receiving_cost_confirmation.created',
        schemaVersion: 1,
      });

      // 2) Revalue stock balance / batch projection & resolve UNKNOWN_COST_SURPLUS conflict (E1)
      applyCostConfirmationStockRevaluationSync(session, {
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        confirmationId: confWrite.entityId,
        hlc: confWrite.hlc,
        productId: line.productId,
        variantId: line.variantId,
        batchId: line.batchId,
        sourceStockMoveId: line.stockMoveId,
        receivedQty: line.qty,
        confirmedTotalCost: input.confirmedTotalCost,
      });

      // 3) Supplier ledger `receiving_debt` when confirmedTotalCost > 0
      if (confirmedTiyin > 0n) {
        const { fifo: beforeFifo } = readSupplierLedgerFifoSync(sqlite, {
          organizationId: ctx.organizationId,
          supplierId: supplier.id,
          asOfMs: nowMs,
          storeTimezone: hubCfg.storeTimezone,
        });
        computeNextSupplierBalance({
          currentBalanceTiyin: beforeFifo.balanceTiyin,
          deltaTiyin: confirmedTiyin,
          operation: 'receiving_debt',
        });

        insertFact(session, supplierLedger, {
          organizationId: ctx.organizationId,
          storeId: ctx.storeId,
          values: {
            supplierId: supplier.id,
            entryType: 'receiving_debt',
            amountDelta: input.confirmedTotalCost,
            sourceType: 'receiving_cost_confirm',
            sourceId: confWrite.entityId,
            receivingId: rcv.id,
            supplierReturnId: null,
            paymentMethod: null,
            providerRef: null,
            cashMoveId: null,
            dueAtMs,
            reason: validReason,
            createdByUserId: validActorId,
            clientRequestId: null,
            requestHash: null,
          },
          eventType: 'supplier_ledger.created',
          schemaVersion: 1,
        });
      }

      const { fifo: afterFifo, lastActivityAtMs } = readSupplierLedgerFifoSync(sqlite, {
        organizationId: ctx.organizationId,
        supplierId: supplier.id,
        asOfMs: nowMs,
        storeTimezone: hubCfg.storeTimezone,
      });
      upsertSupplierBalanceProjectionSync(session, {
        organizationId: ctx.organizationId,
        supplierId: supplier.id,
        balanceTiyin: afterFifo.balanceTiyin,
        totalDebtAccrued: afterFifo.totalDebtAccrued,
        totalCredited: afterFifo.totalCredited,
        earliestOpenDueAtMs: afterFifo.earliestOpenDueAtMs,
        lastActivityAtMs,
        nowMs,
      });

      return Promise.resolve({
        confirmation: toStoredCostConfirmation(confWrite.row),
        receiving: buildPostedReceivingRecordSync(
          session.db,
          ctx.organizationId,
          ctx.storeId,
          rcv.id,
        ),
        supplier: toSupplierSummary(supplier, afterFifo, lastActivityAtMs),
        idempotentReplay: false,
      });
    });
  }

  // --- E2: Supplier Returns (`createSupplierReturn`) ---

  async createSupplierReturn(
    receivingId: UuidV7,
    input: CreateSupplierReturnInput,
  ): Promise<CreateSupplierReturnOutcome> {
    const ctx = this.requireContext();
    const validRcvId = parseUuidV7(receivingId);
    const validActorId = parseUuidV7(input.actorUserId);
    const validReqId = parseUuidV7(input.clientRequestId);
    const validReason = normalizeMandatoryReason(input.reason);
    if (input.items.length === 0) {
      throw new DomainError('VALIDATION_ERROR', 'Supplier return must contain at least one item');
    }

    const seenLineIds = new Set<string>();
    const normalizedItems: Array<{ readonly receivingLineId: UuidV7; readonly qty: Quantity }> = [];
    for (const item of input.items) {
      const lineId = parseUuidV7(item.receivingLineId);
      if (seenLineIds.has(lineId)) {
        throw new DomainError(
          'VALIDATION_ERROR',
          `Duplicate receivingLineId "${lineId}" in supplier return request`,
        );
      }
      seenLineIds.add(lineId);
      if (quantityToMilli(item.qty) <= 0n) {
        throw new DomainError('VALIDATION_ERROR', 'Return quantity must be positive');
      }
      normalizedItems.push({ receivingLineId: lineId, qty: item.qty });
    }

    const requestHash = sha256Hex(
      canonicalizeSupplierReturnRequest({
        receivingId: validRcvId,
        reason: validReason,
        items: normalizedItems,
      }),
    );

    return ctx.uow.execute<CreateSupplierReturnOutcome>((session) => {
      const nowMs = session.nowUnixMs();
      const sqlite = session.internalGetSqlite();
      const hubCfg = readHubSupplierConfigSync(session.db, ctx.organizationId);

      // Idempotency replay by (organizationId, clientRequestId)
      const existingReq = session.db
        .select()
        .from(supplierReturns)
        .where(
          and(
            eq(supplierReturns.organizationId, ctx.organizationId),
            eq(supplierReturns.clientRequestId, validReqId),
          ),
        )
        .limit(1)
        .all()[0];
      if (existingReq) {
        if (existingReq.requestHash !== requestHash) {
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            `clientRequestId "${validReqId}" was already used for another supplier return`,
          );
        }
        const sup = readActiveSupplierRowSync(
          session.db,
          ctx.organizationId,
          existingReq.supplierId,
        );
        const { fifo, lastActivityAtMs } = readSupplierLedgerFifoSync(sqlite, {
          organizationId: ctx.organizationId,
          supplierId: sup.id,
          asOfMs: nowMs,
          storeTimezone: hubCfg.storeTimezone,
        });
        return Promise.resolve({
          supplierReturn: buildSupplierReturnRecordSync(
            session.db,
            ctx.organizationId,
            ctx.storeId,
            existingReq.id,
          ),
          supplier: toSupplierSummary(sup, fifo, lastActivityAtMs),
          idempotentReplay: true,
        });
      }

      const rcv = session.db
        .select()
        .from(goodsReceivings)
        .where(
          and(
            eq(goodsReceivings.id, validRcvId),
            eq(goodsReceivings.organizationId, ctx.organizationId),
            eq(goodsReceivings.storeId, ctx.storeId),
          ),
        )
        .limit(1)
        .all()[0];
      if (!rcv) {
        throw new DomainError('RECEIVING_NOT_FOUND', `Receiving "${validRcvId}" was not found`);
      }

      // E3: Supplier return succeeds even if supplier is now inactive
      const supplier = readActiveSupplierRowSync(session.db, ctx.organizationId, rcv.supplierId);

      const lineRows = session.db
        .select()
        .from(goodsReceivingLines)
        .where(eq(goodsReceivingLines.receivingId, rcv.id))
        .all();
      const lineById = new Map<UuidV7, typeof goodsReceivingLines.$inferSelect>();
      for (const lr of lineRows) {
        lineById.set(lr.id, lr);
      }

      const prodMap = fetchProductsMapSync(
        session.db,
        ctx.organizationId,
        lineRows.map((l) => l.productId),
      );

      const confRows = session.db
        .select()
        .from(receivingCostConfirmations)
        .where(eq(receivingCostConfirmations.receivingId, rcv.id))
        .all();
      const confByLineId = new Map<UuidV7, typeof receivingCostConfirmations.$inferSelect>();
      for (const cr of confRows) {
        confByLineId.set(cr.receivingLineId, cr);
      }

      const priorRetQty = new Map<UuidV7, bigint>();
      const priorRetCost = new Map<UuidV7, bigint>();
      if (lineRows.length > 0) {
        const prevRetRows = session.db
          .select({
            receivingLineId: supplierReturnLines.receivingLineId,
            qty: supplierReturnLines.qty,
            returnCostValue: supplierReturnLines.returnCostValue,
          })
          .from(supplierReturnLines)
          .where(
            inArray(
              supplierReturnLines.receivingLineId,
              lineRows.map((l) => l.id),
            ),
          )
          .all();
        for (const pr of prevRetRows) {
          priorRetQty.set(
            pr.receivingLineId,
            (priorRetQty.get(pr.receivingLineId) ?? 0n) + quantityToMilli(pr.qty),
          );
          priorRetCost.set(
            pr.receivingLineId,
            (priorRetCost.get(pr.receivingLineId) ?? 0n) + moneyToTiyin(pr.returnCostValue),
          );
        }
      }

      interface PlannedReturnLine {
        readonly rcvLine: typeof goodsReceivingLines.$inferSelect;
        readonly product: typeof products.$inferSelect;
        readonly qty: Quantity;
        readonly returnCostValue: Money;
      }
      const planned: PlannedReturnLine[] = [];
      let totalReturnCostTiyin = 0n;

      for (const item of normalizedItems) {
        const rcvLine = lineById.get(item.receivingLineId);
        if (!rcvLine) {
          throw new DomainError(
            'RECEIVING_LINE_NOT_FOUND',
            `Receiving line "${item.receivingLineId}" was not found on receiving "${validRcvId}"`,
          );
        }
        const product = prodMap.get(rcvLine.productId);
        if (!product) {
          throw new DomainError(
            'PRODUCT_NOT_FOUND',
            `Product "${rcvLine.productId}" was not found`,
          );
        }

        const unit = parseProductUnit(product.unit);
        const validQty = validatePositiveStockQuantity(unit, item.qty);

        // Unknown-cost check: cannot return unconfirmed cost_unknown line to supplier
        const conf = confByLineId.get(rcvLine.id) ?? null;
        if (rcvLine.costUnknown && !conf) {
          throw new DomainError(
            'RECEIVING_LINE_COST_UNKNOWN',
            'Receiving line cost must be confirmed before returning goods to supplier',
          );
        }

        const effectiveTotalCost = rcvLine.costUnknown
          ? conf!.confirmedTotalCost
          : rcvLine.initialTotalCost;

        const prevQtyMilli = priorRetQty.get(rcvLine.id) ?? 0n;
        const maxRemainingMilli = quantityToMilli(rcvLine.qty) - prevQtyMilli;
        if (quantityToMilli(validQty) > maxRemainingMilli) {
          throw new DomainError(
            'SUPPLIER_RETURN_QTY_EXCEEDED',
            'Requested return quantity exceeds remaining unreturned received quantity',
          );
        }

        // Exact cumulative rounding so partial returns always sum to exact effectiveTotalCost
        const prevCostTiyin = priorRetCost.get(rcvLine.id) ?? 0n;
        const cumAfterQty = quantityFromMilli(prevQtyMilli + quantityToMilli(validQty));
        const cumTargetCost = computeProportionalCost(effectiveTotalCost, rcvLine.qty, cumAfterQty);
        const deltaTiyin = moneyToTiyin(cumTargetCost) - prevCostTiyin;
        const lineReturnCost = deltaTiyin > 0n ? moneyFromTiyin(deltaTiyin) : ZERO_MONEY;

        totalReturnCostTiyin += moneyToTiyin(lineReturnCost);
        planned.push({
          rcvLine,
          product,
          qty: validQty,
          returnCostValue: lineReturnCost,
        });
      }

      if (!isSignedInt64Money(totalReturnCostTiyin) || totalReturnCostTiyin > MAX_MONEY_TIYIN) {
        throw new DomainError(
          'VALIDATION_ERROR',
          'Supplier return total exceeds bounded 64-bit limit',
        );
      }
      const totalReturnCost = moneyFromTiyin(totalReturnCostTiyin);

      const prefetchTargetsMap = new Map<string, StockPoolPrefetchTarget>();
      for (const p of planned) {
        const key = stockPoolKey(p.rcvLine.productId, p.rcvLine.variantId);
        if (!prefetchTargetsMap.has(key)) {
          prefetchTargetsMap.set(key, {
            productId: p.rcvLine.productId,
            variantId: p.rcvLine.variantId,
            trackBatches: Boolean(p.product.trackBatches),
          });
        }
      }
      const sessionPoolCache = prefetchMutablePoolStatesSync(session, {
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        targets: [...prefetchTargetsMap.values()],
      });

      const returnNo = advanceSupplierReturnSeqSync(sqlite, {
        deviceId: session.deviceId,
        updatedAtMs: BigInt(nowMs),
      });
      const returnCode = formatSupplierReturnCode(session.deviceId, returnNo);

      // 1) Parent supplier_returns FACT row
      const retWrite = insertFact(session, supplierReturns, {
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        values: {
          returnNo,
          returnCode,
          receivingId: rcv.id,
          supplierId: supplier.id,
          reason: validReason,
          totalReturnCost,
          createdByUserId: validActorId,
          clientRequestId: validReqId,
          requestHash,
        },
        eventType: 'supplier_return.created',
        schemaVersion: 1,
      });
      const supplierReturnId = retWrite.entityId;

      // 2) Outbound stock moves & supplier_return_lines (E2)
      for (let i = 0; i < planned.length; i += 1) {
        const pl = planned[i];
        const move: StoredStockMoveRecord = applySupplierReturnStockOutboundSync(session, {
          organizationId: ctx.organizationId,
          storeId: ctx.storeId,
          productId: pl.rcvLine.productId,
          variantId: pl.rcvLine.variantId,
          batchId: pl.rcvLine.batchId,
          returnQty: pl.qty,
          returnCostValue: pl.returnCostValue,
          supplierReturnId,
          note: validReason,
          actorUserId: validActorId,
          prefetchedProduct: pl.product,
          sessionPoolCache,
        });

        insertFact(session, supplierReturnLines, {
          organizationId: ctx.organizationId,
          storeId: ctx.storeId,
          values: {
            supplierReturnId,
            receivingLineId: pl.rcvLine.id,
            sortOrder: i,
            productId: pl.rcvLine.productId,
            variantId: pl.rcvLine.variantId,
            batchId: pl.rcvLine.batchId,
            stockMoveId: move.id,
            qty: pl.qty,
            returnCostValue: pl.returnCostValue,
          },
          eventType: 'supplier_return_line.created',
          schemaVersion: 1,
        });
      }

      // 3) Supplier ledger `supplier_return` credit (-totalReturnCost, E2 full cost deducted even if avg pool capped!)
      if (totalReturnCostTiyin > 0n) {
        const { fifo: beforeFifo } = readSupplierLedgerFifoSync(sqlite, {
          organizationId: ctx.organizationId,
          supplierId: supplier.id,
          asOfMs: nowMs,
          storeTimezone: hubCfg.storeTimezone,
        });
        computeNextSupplierBalance({
          currentBalanceTiyin: beforeFifo.balanceTiyin,
          deltaTiyin: -totalReturnCostTiyin,
          operation: 'supplier_return',
        });

        insertFact(session, supplierLedger, {
          organizationId: ctx.organizationId,
          storeId: ctx.storeId,
          values: {
            supplierId: supplier.id,
            entryType: 'supplier_return',
            amountDelta: negateMoney(totalReturnCost),
            sourceType: 'supplier_return',
            sourceId: supplierReturnId,
            receivingId: rcv.id,
            supplierReturnId,
            paymentMethod: null,
            providerRef: null,
            cashMoveId: null,
            dueAtMs: null,
            reason: validReason,
            createdByUserId: validActorId,
            clientRequestId: null,
            requestHash: null,
          },
          eventType: 'supplier_ledger.created',
          schemaVersion: 1,
        });
      }

      const { fifo: afterFifo, lastActivityAtMs } = readSupplierLedgerFifoSync(sqlite, {
        organizationId: ctx.organizationId,
        supplierId: supplier.id,
        asOfMs: nowMs,
        storeTimezone: hubCfg.storeTimezone,
      });
      upsertSupplierBalanceProjectionSync(session, {
        organizationId: ctx.organizationId,
        supplierId: supplier.id,
        balanceTiyin: afterFifo.balanceTiyin,
        totalDebtAccrued: afterFifo.totalDebtAccrued,
        totalCredited: afterFifo.totalCredited,
        earliestOpenDueAtMs: afterFifo.earliestOpenDueAtMs,
        lastActivityAtMs,
        nowMs,
      });

      return Promise.resolve({
        supplierReturn: buildSupplierReturnRecordSync(
          session.db,
          ctx.organizationId,
          ctx.storeId,
          supplierReturnId,
        ),
        supplier: toSupplierSummary(supplier, afterFifo, lastActivityAtMs),
        idempotentReplay: false,
      });
    });
  }

  async listReturnsForReceiving(
    receivingId: UuidV7,
  ): Promise<readonly StoredSupplierReturnRecord[]> {
    const ctx = this.requireContext();
    const validRcvId = parseUuidV7(receivingId);
    return runConnectionReadOnly(this.connection, () => {
      const db = this.connection.db;
      const rcv = db
        .select({ id: goodsReceivings.id })
        .from(goodsReceivings)
        .where(
          and(
            eq(goodsReceivings.id, validRcvId),
            eq(goodsReceivings.organizationId, ctx.organizationId),
            eq(goodsReceivings.storeId, ctx.storeId),
          ),
        )
        .limit(1)
        .all()[0];
      if (!rcv) {
        throw new DomainError('RECEIVING_NOT_FOUND', `Receiving "${validRcvId}" was not found`);
      }

      const rows = db
        .select({ id: supplierReturns.id })
        .from(supplierReturns)
        .where(
          and(
            eq(supplierReturns.receivingId, rcv.id),
            eq(supplierReturns.organizationId, ctx.organizationId),
            eq(supplierReturns.storeId, ctx.storeId),
          ),
        )
        .orderBy(desc(supplierReturns.createdAtMs), desc(supplierReturns.id))
        .all();
      return Promise.resolve(
        rows.map((r) => buildSupplierReturnRecordSync(db, ctx.organizationId, ctx.storeId, r.id)),
      );
    });
  }

  async getSupplierReturn(returnId: UuidV7): Promise<StoredSupplierReturnRecord> {
    const ctx = this.requireContext();
    const validId = parseUuidV7(returnId);
    return runConnectionReadOnly(this.connection, () =>
      Promise.resolve(
        buildSupplierReturnRecordSync(this.connection.db, ctx.organizationId, ctx.storeId, validId),
      ),
    );
  }

  // --- Supplier Ledger: List, Opening Balance, Payments, Adjustments ---

  async listSupplierLedger(
    supplierId: UuidV7,
    query?: SupplierLedgerListQueryInput,
  ): Promise<SupplierLedgerListOutcome> {
    const ctx = this.requireContext();
    const validId = parseUuidV7(supplierId);
    const limit = query?.limit ?? 50;
    const offset = query?.offset ?? 0;
    const orderDir = query?.order === 'asc' ? 'ASC' : 'DESC';

    return runConnectionReadOnly(this.connection, () => {
      const db = this.connection.db;
      const sup = readActiveSupplierRowSync(db, ctx.organizationId, validId);
      const balRow = readSupplierBalanceRowSync(db, ctx.organizationId, sup.id);

      const sqlite = this.connection.sqlite;
      const whereParts: string[] = [];
      const sqlParams: (string | number | bigint)[] = [ctx.organizationId, validId];
      if (query?.entryType !== undefined) {
        whereParts.push('"entry_type" = ?');
        sqlParams.push(query.entryType);
      }
      sqlParams.push(limit, offset);
      const filterClause = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

      const rawRows = sqlite
        .prepare(
          `WITH numbered AS (
             SELECT
               "id", "organization_id", "store_id", "device_id", "supplier_id",
               "entry_type", "amount_delta", "source_type", "source_id",
               "receiving_id", "supplier_return_id", "payment_method", "provider_ref",
               "cash_move_id", "due_at_ms", "reason", "created_by_user_id",
               "created_at_ms", "hlc",
               SUM("amount_delta") OVER (
                 PARTITION BY "organization_id", "supplier_id"
                 ORDER BY "hlc" ASC, "id" ASC
                 ROWS UNBOUNDED PRECEDING
               ) AS "balance_after"
             FROM "supplier_ledger"
             WHERE "organization_id" = ? AND "supplier_id" = ?
           )
           SELECT *, COUNT(*) OVER() AS "total_filtered"
           FROM numbered
           ${filterClause}
           ORDER BY "hlc" ${orderDir}, "id" ${orderDir}
           LIMIT ? OFFSET ?`,
        )
        .safeIntegers(true)
        .all(...sqlParams) as Array<{
        readonly id: string;
        readonly organization_id: string;
        readonly store_id: string;
        readonly device_id: string;
        readonly supplier_id: string;
        readonly entry_type: string;
        readonly amount_delta: bigint | number;
        readonly source_type: string;
        readonly source_id: string;
        readonly receiving_id: string | null;
        readonly supplier_return_id: string | null;
        readonly payment_method: string | null;
        readonly provider_ref: string | null;
        readonly cash_move_id: string | null;
        readonly due_at_ms: bigint | number | null;
        readonly reason: string | null;
        readonly created_by_user_id: string;
        readonly created_at_ms: bigint | number;
        readonly balance_after: bigint | number;
        readonly total_filtered: bigint | number;
      }>;

      const total = rawRows.length > 0 && rawRows[0] ? Number(rawRows[0].total_filtered) : 0;
      const items: StoredSupplierLedgerEntryRecord[] = rawRows.map((r) => ({
        id: r.id as UuidV7,
        organizationId: r.organization_id as UuidV7,
        storeId: r.store_id as UuidV7,
        deviceId: r.device_id as UuidV7,
        supplierId: r.supplier_id as UuidV7,
        entryType: r.entry_type as SupplierLedgerEntryType,
        amountDelta: moneyFromTiyin(toBigInt(r.amount_delta)),
        balanceAfter: moneyFromTiyin(toBigInt(r.balance_after)),
        sourceType: r.source_type as SupplierLedgerSourceType,
        sourceId: r.source_id as UuidV7,
        receivingId: r.receiving_id as UuidV7 | null,
        supplierReturnId: r.supplier_return_id as UuidV7 | null,
        paymentMethod: r.payment_method !== null ? parsePaymentMethod(r.payment_method) : null,
        providerRef: r.provider_ref,
        cashMoveId: r.cash_move_id as UuidV7 | null,
        dueAtMs: toNullableUnixMs(r.due_at_ms),
        reason: r.reason,
        createdByUserId: r.created_by_user_id as UuidV7,
        createdAtMs: unixMsFromBigInt(toBigInt(r.created_at_ms)),
      }));

      let currentBalance = balRow ? balRow.balance : null;
      if (currentBalance === null) {
        const { fifo } = readSupplierLedgerFifoSync(sqlite, {
          organizationId: ctx.organizationId,
          supplierId: validId,
          asOfMs: ctx.uow.nowUnixMs(),
          storeTimezone: readHubSupplierConfigSync(db, ctx.organizationId).storeTimezone,
        });
        currentBalance = moneyFromTiyin(fifo.balanceTiyin);
      }

      return Promise.resolve({
        supplierId: validId,
        currentBalance,
        items,
        total,
        limit,
        offset,
      });
    });
  }

  async recordOpeningBalance(
    input: RecordSupplierOpeningBalanceInput,
  ): Promise<SupplierLedgerMutationOutcome> {
    const ctx = this.requireContext();
    const validSupplierId = parseUuidV7(input.supplierId);
    const validActorId = parseUuidV7(input.actorUserId);
    const validReqId = parseUuidV7(input.clientRequestId);
    const validReason = normalizeMandatoryReason(input.reason);
    const dueDaysOpt =
      input.dueDays !== undefined ? normalizeSupplierDueDays(input.dueDays) : undefined;
    const amtTiyin = moneyToTiyin(input.amount);
    if (amtTiyin <= 0n || !isSignedInt64Money(amtTiyin) || amtTiyin > MAX_MONEY_TIYIN) {
      throw new DomainError('VALIDATION_ERROR', 'Opening balance must be positive bounded money');
    }

    const requestHash = sha256Hex(
      canonicalizeSupplierOpeningBalanceRequest({
        supplierId: validSupplierId,
        amount: input.amount,
        reason: validReason,
        dueDays: dueDaysOpt ?? null,
      }),
    );

    return ctx.uow.execute((session) => {
      const nowMs = session.nowUnixMs();
      const replay = this.checkLedgerIdempotencyReplaySync(
        session,
        ctx.organizationId,
        validReqId,
        requestHash,
        nowMs,
      );
      if (replay) {
        return Promise.resolve(replay);
      }

      const sup = readActiveSupplierRowSync(session.db, ctx.organizationId, validSupplierId);
      const existingOpening = session.db
        .select({ id: supplierLedger.id })
        .from(supplierLedger)
        .where(
          and(
            eq(supplierLedger.organizationId, ctx.organizationId),
            eq(supplierLedger.supplierId, sup.id),
            eq(supplierLedger.entryType, 'opening_balance'),
          ),
        )
        .limit(1)
        .all()[0];
      if (existingOpening) {
        throw new DomainError(
          'OPENING_BALANCE_ALREADY_EXISTS',
          'Supplier opening balance has already been recorded',
        );
      }

      const sqlite = session.internalGetSqlite();
      const hubCfg = readHubSupplierConfigSync(session.db, ctx.organizationId);
      const { fifo: beforeFifo } = readSupplierLedgerFifoSync(sqlite, {
        organizationId: ctx.organizationId,
        supplierId: sup.id,
        asOfMs: nowMs,
        storeTimezone: hubCfg.storeTimezone,
      });

      computeNextSupplierBalance({
        currentBalanceTiyin: beforeFifo.balanceTiyin,
        deltaTiyin: amtTiyin,
        operation: 'opening_balance',
      });

      const effectiveDueDays =
        dueDaysOpt !== undefined
          ? dueDaysOpt
          : (sup.defaultDueDays ?? hubCfg.defaultSupplierDueDays);
      const dueAtMs =
        effectiveDueDays !== null
          ? computeSupplierDueAtMs({
              createdAtMs: nowMs,
              dueDays: effectiveDueDays,
              storeTimezone: hubCfg.storeTimezone,
              resolveTimeZoneDateKey: resolveIntlDateKey,
            })
          : null;

      const writeRes = insertFact(session, supplierLedger, {
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        values: {
          supplierId: sup.id,
          entryType: 'opening_balance',
          amountDelta: input.amount,
          sourceType: 'opening_balance',
          sourceId: sup.id,
          receivingId: null,
          supplierReturnId: null,
          paymentMethod: null,
          providerRef: null,
          cashMoveId: null,
          dueAtMs,
          reason: validReason,
          createdByUserId: validActorId,
          clientRequestId: validReqId,
          requestHash,
        },
        eventType: 'supplier_ledger.created',
        schemaVersion: 1,
      });

      const { fifo: afterFifo, lastActivityAtMs } = readSupplierLedgerFifoSync(sqlite, {
        organizationId: ctx.organizationId,
        supplierId: sup.id,
        asOfMs: nowMs,
        storeTimezone: hubCfg.storeTimezone,
      });
      upsertSupplierBalanceProjectionSync(session, {
        organizationId: ctx.organizationId,
        supplierId: sup.id,
        balanceTiyin: afterFifo.balanceTiyin,
        totalDebtAccrued: afterFifo.totalDebtAccrued,
        totalCredited: afterFifo.totalCredited,
        earliestOpenDueAtMs: afterFifo.earliestOpenDueAtMs,
        lastActivityAtMs,
        nowMs,
      });

      return Promise.resolve({
        supplier: toSupplierSummary(sup, afterFifo, lastActivityAtMs),
        entry: toStoredSupplierLedgerEntry(writeRes.row, moneyFromTiyin(afterFifo.balanceTiyin)),
        cashMove: null,
        idempotentReplay: false,
      });
    });
  }

  async recordPayment(input: RecordSupplierPaymentInput): Promise<SupplierLedgerMutationOutcome> {
    const ctx = this.requireContext();
    const validSupplierId = parseUuidV7(input.supplierId);
    const validActorId = parseUuidV7(input.actorUserId);
    const validReqId = parseUuidV7(input.clientRequestId);
    const method = parseSupplierPaymentMethod(input.method);
    const providerRef = parseSupplierProviderRef(method, input.providerRef);
    const reasonOpt =
      input.reason !== undefined && input.reason !== null && input.reason.trim().length > 0
        ? normalizeMandatoryReason(input.reason)
        : null;

    const amtTiyin = moneyToTiyin(input.amount);
    if (amtTiyin <= 0n || !isSignedInt64Money(amtTiyin) || amtTiyin > MAX_MONEY_TIYIN) {
      throw new DomainError(
        'VALIDATION_ERROR',
        'Supplier payment amount must be positive bounded money',
      );
    }

    const requestHash = sha256Hex(
      canonicalizeSupplierPaymentRequest({
        supplierId: validSupplierId,
        method,
        amount: input.amount,
        providerRef,
        reason: reasonOpt,
      }),
    );

    return ctx.uow.execute((session) => {
      const nowMs = session.nowUnixMs();
      const replay = this.checkLedgerIdempotencyReplaySync(
        session,
        ctx.organizationId,
        validReqId,
        requestHash,
        nowMs,
      );
      if (replay) {
        return Promise.resolve(replay);
      }

      // E3: Payment is allowed even when supplier.isActive === false
      const sup = readActiveSupplierRowSync(session.db, ctx.organizationId, validSupplierId);
      const sqlite = session.internalGetSqlite();
      const hubCfg = readHubSupplierConfigSync(session.db, ctx.organizationId);
      const { fifo: beforeFifo } = readSupplierLedgerFifoSync(sqlite, {
        organizationId: ctx.organizationId,
        supplierId: sup.id,
        asOfMs: nowMs,
        storeTimezone: hubCfg.storeTimezone,
      });

      computeNextSupplierBalance({
        currentBalanceTiyin: beforeFifo.balanceTiyin,
        deltaTiyin: -amtTiyin,
        operation: 'supplier_payment',
      });

      let cashMoveRecord: StoredCashMoveRecord | null = null;
      if (method === 'cash') {
        const drawerBalance = getCashDrawerBalanceSync(session.db, {
          organizationId: ctx.organizationId,
          storeId: ctx.storeId,
          deviceId: session.deviceId,
        });
        if (moneyToTiyin(drawerBalance) < amtTiyin) {
          throw new DomainError(
            'INSUFFICIENT_CASH_IN_DRAWER',
            `Terminal cash drawer balance (${moneyToTiyin(drawerBalance).toString()} tiyin) is insufficient for supplier cash payment (${amtTiyin.toString()} tiyin)`,
            {
              details: {
                drawerBalance: moneyToTiyin(drawerBalance).toString(),
                requiredCashPayment: amtTiyin.toString(),
              },
            },
          );
        }

        const cashWrite = insertFact(session, cashMoves, {
          organizationId: ctx.organizationId,
          storeId: ctx.storeId,
          values: {
            shiftId: null,
            type: 'supplier_payment_out',
            amountDelta: negateMoney(input.amount),
            sourceType: 'supplier_payment',
            sourceId: sup.id,
            paymentId: null,
            reason: reasonOpt ?? 'Supplier cash payment',
            createdByUserId: validActorId,
          },
          eventType: 'cash_move.created',
          schemaVersion: 1,
        });
        cashMoveRecord = toStoredCashMove(cashWrite.row);
      }

      const ledgerWrite = insertFact(session, supplierLedger, {
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        values: {
          supplierId: sup.id,
          entryType: 'supplier_payment',
          amountDelta: negateMoney(input.amount),
          sourceType: 'supplier_payment',
          sourceId: sup.id,
          receivingId: null,
          supplierReturnId: null,
          paymentMethod: method,
          providerRef,
          cashMoveId: cashMoveRecord !== null ? cashMoveRecord.id : null,
          dueAtMs: null,
          reason: reasonOpt,
          createdByUserId: validActorId,
          clientRequestId: validReqId,
          requestHash,
        },
        eventType: 'supplier_ledger.created',
        schemaVersion: 1,
      });

      const { fifo: afterFifo, lastActivityAtMs } = readSupplierLedgerFifoSync(sqlite, {
        organizationId: ctx.organizationId,
        supplierId: sup.id,
        asOfMs: nowMs,
        storeTimezone: hubCfg.storeTimezone,
      });
      upsertSupplierBalanceProjectionSync(session, {
        organizationId: ctx.organizationId,
        supplierId: sup.id,
        balanceTiyin: afterFifo.balanceTiyin,
        totalDebtAccrued: afterFifo.totalDebtAccrued,
        totalCredited: afterFifo.totalCredited,
        earliestOpenDueAtMs: afterFifo.earliestOpenDueAtMs,
        lastActivityAtMs,
        nowMs,
      });

      return Promise.resolve({
        supplier: toSupplierSummary(sup, afterFifo, lastActivityAtMs),
        entry: toStoredSupplierLedgerEntry(ledgerWrite.row, moneyFromTiyin(afterFifo.balanceTiyin)),
        cashMove: cashMoveRecord,
        idempotentReplay: false,
      });
    });
  }

  async recordAdjustment(
    input: RecordSupplierAdjustmentInput,
  ): Promise<SupplierLedgerMutationOutcome> {
    const ctx = this.requireContext();
    const validSupplierId = parseUuidV7(input.supplierId);
    const validActorId = parseUuidV7(input.actorUserId);
    const validReqId = parseUuidV7(input.clientRequestId);
    const validReason = normalizeMandatoryReason(input.reason);
    const deltaTiyin = moneyToTiyin(input.amountDelta);
    if (deltaTiyin === 0n || !isSignedInt64Money(deltaTiyin) || deltaTiyin > MAX_MONEY_TIYIN) {
      throw new DomainError(
        'VALIDATION_ERROR',
        'Adjustment amountDelta must be non-zero bounded money',
      );
    }

    const validDueDays =
      deltaTiyin > 0n && input.dueDays !== undefined
        ? normalizeSupplierDueDays(input.dueDays)
        : null;

    const requestHash = sha256Hex(
      canonicalizeSupplierAdjustmentRequest({
        supplierId: validSupplierId,
        amountDeltaTiyin: deltaTiyin,
        reason: validReason,
        dueDays: validDueDays,
      }),
    );

    return ctx.uow.execute((session) => {
      const nowMs = session.nowUnixMs();
      const replay = this.checkLedgerIdempotencyReplaySync(
        session,
        ctx.organizationId,
        validReqId,
        requestHash,
        nowMs,
      );
      if (replay) {
        return Promise.resolve(replay);
      }

      const sup = readActiveSupplierRowSync(session.db, ctx.organizationId, validSupplierId);
      const sqlite = session.internalGetSqlite();
      const hubCfg = readHubSupplierConfigSync(session.db, ctx.organizationId);
      const { fifo: beforeFifo } = readSupplierLedgerFifoSync(sqlite, {
        organizationId: ctx.organizationId,
        supplierId: sup.id,
        asOfMs: nowMs,
        storeTimezone: hubCfg.storeTimezone,
      });

      computeNextSupplierBalance({
        currentBalanceTiyin: beforeFifo.balanceTiyin,
        deltaTiyin,
        operation: 'adjustment',
      });

      const dueAtMs =
        validDueDays !== null
          ? computeSupplierDueAtMs({
              createdAtMs: nowMs,
              dueDays: validDueDays,
              storeTimezone: hubCfg.storeTimezone,
              resolveTimeZoneDateKey: resolveIntlDateKey,
            })
          : null;

      const ledgerWrite = insertFact(session, supplierLedger, {
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        values: {
          supplierId: sup.id,
          entryType: 'adjustment',
          amountDelta: input.amountDelta,
          sourceType: 'adjustment',
          sourceId: sup.id,
          receivingId: null,
          supplierReturnId: null,
          paymentMethod: null,
          providerRef: null,
          cashMoveId: null,
          dueAtMs,
          reason: validReason,
          createdByUserId: validActorId,
          clientRequestId: validReqId,
          requestHash,
        },
        eventType: 'supplier_ledger.created',
        schemaVersion: 1,
      });

      const { fifo: afterFifo, lastActivityAtMs } = readSupplierLedgerFifoSync(sqlite, {
        organizationId: ctx.organizationId,
        supplierId: sup.id,
        asOfMs: nowMs,
        storeTimezone: hubCfg.storeTimezone,
      });
      upsertSupplierBalanceProjectionSync(session, {
        organizationId: ctx.organizationId,
        supplierId: sup.id,
        balanceTiyin: afterFifo.balanceTiyin,
        totalDebtAccrued: afterFifo.totalDebtAccrued,
        totalCredited: afterFifo.totalCredited,
        earliestOpenDueAtMs: afterFifo.earliestOpenDueAtMs,
        lastActivityAtMs,
        nowMs,
      });

      return Promise.resolve({
        supplier: toSupplierSummary(sup, afterFifo, lastActivityAtMs),
        entry: toStoredSupplierLedgerEntry(ledgerWrite.row, moneyFromTiyin(afterFifo.balanceTiyin)),
        cashMove: null,
        idempotentReplay: false,
      });
    });
  }

  private checkLedgerIdempotencyReplaySync(
    session: SqliteUnitOfWorkSession,
    organizationId: UuidV7,
    clientRequestId: UuidV7,
    requestHash: string,
    nowMs: UnixMs,
  ): SupplierLedgerMutationOutcome | null {
    const existing = session.db
      .select()
      .from(supplierLedger)
      .where(
        and(
          eq(supplierLedger.organizationId, organizationId),
          eq(supplierLedger.clientRequestId, clientRequestId),
        ),
      )
      .limit(1)
      .all()[0];
    if (!existing) {
      return null;
    }
    if (existing.requestHash !== requestHash) {
      throw new DomainError(
        'IDEMPOTENCY_CONFLICT',
        `clientRequestId "${clientRequestId}" was already used for a different supplier ledger payload`,
      );
    }

    const sup = session.db
      .select()
      .from(suppliers)
      .where(eq(suppliers.id, existing.supplierId))
      .limit(1)
      .all()[0];
    if (!sup) {
      throw new DomainError('SUPPLIER_NOT_FOUND', 'Supplier record not found');
    }

    const hubCfg = readHubSupplierConfigSync(session.db, organizationId);
    const { fifo, lastActivityAtMs } = readSupplierLedgerFifoSync(session.internalGetSqlite(), {
      organizationId,
      supplierId: sup.id,
      asOfMs: nowMs,
      storeTimezone: hubCfg.storeTimezone,
    });

    const cashMove =
      existing.cashMoveId !== null
        ? (session.db
            .select()
            .from(cashMoves)
            .where(eq(cashMoves.id, existing.cashMoveId))
            .limit(1)
            .all()[0] ?? null)
        : null;

    return {
      supplier: toSupplierSummary(sup, fifo, lastActivityAtMs),
      entry: toStoredSupplierLedgerEntry(existing, moneyFromTiyin(fifo.balanceTiyin)),
      cashMove: cashMove !== null ? toStoredCashMove(cashMove) : null,
      idempotentReplay: true,
    };
  }

  // --- Rebuild Maintenance (`rebuildSupplierBalances`, `rebuildSupplierSearchIndex`) ---

  async rebuildSupplierBalances(organizationId?: UuidV7): Promise<RebuildSupplierBalancesOutcome> {
    const validOrgId = organizationId !== undefined ? parseUuidV7(organizationId) : null;
    const ctx = this.getRuntimeContext();
    const nowMs = ctx ? ctx.uow.nowUnixMs() : unixMsFromBigInt(0n);

    return runConnectionProjectionMaintenance(this.connection, (sqlite, db) => {
      const allSuppliers =
        validOrgId !== null
          ? db
              .select({ id: suppliers.id, organizationId: suppliers.organizationId })
              .from(suppliers)
              .where(eq(suppliers.organizationId, validOrgId))
              .all()
          : db
              .select({ id: suppliers.id, organizationId: suppliers.organizationId })
              .from(suppliers)
              .all();

      const orgTimezones = new Map<string, string>();
      const getTz = (orgId: UuidV7): string => {
        const cached = orgTimezones.get(orgId);
        if (cached) return cached;
        const tz = readHubSupplierConfigSync(db, orgId).storeTimezone;
        orgTimezones.set(orgId, tz);
        return tz;
      };

      const insertStmt = sqlite.prepare(
        `INSERT INTO "local_supplier_balances" (
           "id", "organization_id", "created_at_ms", "updated_at_ms",
           "supplier_id", "balance", "total_debt_accrued", "total_credited",
           "earliest_open_due_at_ms", "last_activity_at_ms"
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      let balancesUpdated = 0;
      if (validOrgId !== null) {
        sqlite
          .prepare('DELETE FROM "local_supplier_balances" WHERE "organization_id" = ?')
          .run(validOrgId);
      } else {
        sqlite.prepare('DELETE FROM "local_supplier_balances"').run();
      }

      for (let i = 0; i < allSuppliers.length; i += 1) {
        const s = allSuppliers[i];
        if (!s) continue;
        const tz = getTz(s.organizationId);
        const { fifo, lastActivityAtMs } = readSupplierLedgerFifoSync(sqlite, {
          organizationId: s.organizationId,
          supplierId: s.id,
          asOfMs: nowMs,
          storeTimezone: tz,
        });
        // Deterministic synthetic UUIDv7 row ID derived without outbox mutation
        const rowId = parseUuidV7(
          `01978888-${(i + 1).toString().padStart(4, '0').slice(-4)}-7000-8000-${(i + 1).toString().padStart(12, '0')}`,
        );
        insertStmt.run(
          rowId,
          s.organizationId,
          BigInt(nowMs),
          BigInt(nowMs),
          s.id,
          fifo.balanceTiyin,
          moneyToTiyin(fifo.totalDebtAccrued),
          moneyToTiyin(fifo.totalCredited),
          fifo.earliestOpenDueAtMs !== null ? BigInt(fifo.earliestOpenDueAtMs) : null,
          lastActivityAtMs !== null ? BigInt(lastActivityAtMs) : null,
        );
        balancesUpdated += 1;
      }

      return {
        suppliersProcessed: allSuppliers.length,
        balancesUpdated,
      };
    });
  }

  async rebuildSupplierSearchIndex(
    organizationId?: UuidV7,
  ): Promise<RebuildSupplierSearchIndexOutcome> {
    const validOrgId = organizationId !== undefined ? parseUuidV7(organizationId) : null;
    return runConnectionProjectionMaintenance(this.connection, (sqlite) => {
      if (validOrgId !== null) {
        sqlite.prepare('DELETE FROM "suppliers_fts" WHERE "organization_id" = ?').run(validOrgId);
        const info = sqlite
          .prepare(
            `INSERT INTO "suppliers_fts" ("supplier_id", "organization_id", "name_search", "phone_digits")
             SELECT "id", "organization_id", "name_search", COALESCE("phone_digits", '')
             FROM "suppliers"
             WHERE "organization_id" = ? AND "deleted_at_ms" IS NULL`,
          )
          .run(validOrgId);
        return { ftsIndexedCount: Number(info.changes) };
      }

      sqlite.prepare('DELETE FROM "suppliers_fts"').run();
      const info = sqlite
        .prepare(
          `INSERT INTO "suppliers_fts" ("supplier_id", "organization_id", "name_search", "phone_digits")
           SELECT "id", "organization_id", "name_search", COALESCE("phone_digits", '')
           FROM "suppliers"
           WHERE "deleted_at_ms" IS NULL`,
        )
        .run();
      return { ftsIndexedCount: Number(info.changes) };
    });
  }
}

export function createSqliteSupplierStore(
  options: CreateSqliteSupplierStoreOptions,
): SqliteSupplierStore {
  return new SqliteSupplierStore(options);
}
