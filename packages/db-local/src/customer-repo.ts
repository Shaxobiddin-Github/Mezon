import { createHash } from 'node:crypto';
import {
  type CashMoveType,
  type CustomerDebtObligationSummary,
  type CustomerLedgerEntryType,
  type CustomerLedgerFifoResult,
  type CustomerLedgerSourceType,
  DEFAULT_CUSTOMER_DUE_DAYS,
  DEFAULT_STORE_TIMEZONE,
  DomainError,
  type LedgerEntryForFifo,
  type Money,
  type PaymentMethod,
  type UnixMs,
  type UuidV7,
  ZERO_MONEY,
  allocateCustomerLedgerFifo,
  assertCreditLimitForSale,
  assertValidCreditLimit,
  buildFtsPrefixQuery,
  canonicalizeDebtAdjustmentRequest,
  canonicalizeDebtPaymentRequest,
  canonicalizeOpeningBalanceRequest,
  computeDebtDueAtMs,
  computeNextCustomerBalance,
  moneyFromTiyin,
  moneyToTiyin,
  negateMoney,
  normalizeCustomerDueDays,
  normalizeCustomerFullName,
  normalizeCustomerNote,
  normalizeCustomerPhone,
  normalizeCustomerSearchQuery,
  normalizeCustomerSearchText,
  normalizeMandatoryReason,
  normalizePaymentProviderRef,
  parsePaymentMethod,
  parseUuidV7,
  unixMsFromBigInt,
} from '@mezon/domain';
import type Database from 'better-sqlite3';
import { and, eq, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { type LocalSqliteConnection } from './connection.js';
import {
  cashMoves,
  customerLedger,
  customers,
  localCustomerBalances,
  localHubConfig,
} from './schema/index.js';
import { resolveIntlDateKey } from './timezone.js';
import {
  type SqliteUnitOfWork,
  type SqliteUnitOfWorkSession,
  runConnectionProjectionMaintenance,
  runConnectionReadOnly,
} from './uow.js';
import { insertFact, insertAttr, tombstoneAttr, updateAttr } from './writers.js';

export interface StoredCashMoveRecord {
  readonly id: UuidV7;
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7;
  readonly deviceId: UuidV7;
  readonly shiftId: UuidV7 | null;
  readonly type: CashMoveType;
  readonly amountDelta: Money;
  readonly sourceType: string;
  readonly sourceId: UuidV7;
  readonly paymentId: UuidV7 | null;
  readonly reason: string | null;
  readonly createdByUserId: UuidV7;
  readonly createdAtMs: UnixMs;
}

export interface CustomerRuntimeContext {
  readonly uow: SqliteUnitOfWork;
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7;
}

export interface CreateSqliteCustomerStoreOptions {
  readonly connection: LocalSqliteConnection;
  readonly getRuntimeContext: () => CustomerRuntimeContext | null;
}

export interface CreateCustomerInput {
  readonly fullName: string;
  readonly phone?: string | null;
  readonly creditLimit?: Money | null;
  readonly defaultDueDays?: number | null;
  readonly note?: string | null;
}

export interface UpdateCustomerInput {
  readonly fullName?: string;
  readonly phone?: string | null;
  readonly creditLimit?: Money | null;
  readonly defaultDueDays?: number | null;
  readonly note?: string | null;
  readonly isActive?: boolean;
}

export interface CustomerSummaryRecord {
  readonly id: UuidV7;
  readonly organizationId: UuidV7;
  readonly fullName: string;
  readonly phoneNormalized: string | null;
  readonly creditLimit: Money | null;
  readonly defaultDueDays: number | null;
  readonly note: string | null;
  readonly isActive: boolean;
  readonly balance: Money;
  readonly totalDebtAccrued: Money;
  readonly totalSettled: Money;
  readonly overdueAmount: Money;
  readonly oldestOverdueDays: number;
  readonly lastActivityAtMs: UnixMs | null;
  readonly createdAtMs: UnixMs;
  readonly updatedAtMs: UnixMs;
}

export interface CustomerDetailRecord {
  readonly customer: CustomerSummaryRecord;
  readonly openObligations: readonly CustomerDebtObligationSummary[];
}

export interface CustomerListQueryInput {
  readonly q?: string;
  readonly overdueOnly?: boolean;
  readonly includeInactive?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

export interface CustomerListOutcome {
  readonly items: readonly CustomerSummaryRecord[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface StoredCustomerLedgerEntryRecord {
  readonly id: UuidV7;
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7;
  readonly deviceId: UuidV7;
  readonly customerId: UuidV7;
  readonly entryType: CustomerLedgerEntryType;
  readonly amountDelta: Money;
  readonly balanceAfter: Money;
  readonly sourceType: CustomerLedgerSourceType;
  readonly sourceId: UuidV7;
  readonly saleId: UuidV7 | null;
  readonly paymentMethod: PaymentMethod | null;
  readonly providerRef: string | null;
  readonly cashMoveId: UuidV7 | null;
  readonly dueAtMs: UnixMs | null;
  readonly reason: string | null;
  readonly createdByUserId: UuidV7;
  readonly overrideApprovedByUserId: UuidV7 | null;
  readonly createdAtMs: UnixMs;
}

export interface RecordOpeningBalanceInput {
  readonly customerId: UuidV7;
  readonly actorUserId: UuidV7;
  readonly clientRequestId: UuidV7;
  readonly amount: Money;
  readonly reason: string;
  readonly dueDays?: number | null;
}

export interface RecordDebtPaymentInput {
  readonly customerId: UuidV7;
  readonly actorUserId: UuidV7;
  readonly clientRequestId: UuidV7;
  readonly method: PaymentMethod;
  readonly amount: Money;
  readonly providerRef?: string | null;
  readonly reason?: string | null;
}

export interface RecordDebtAdjustmentInput {
  readonly customerId: UuidV7;
  readonly actorUserId: UuidV7;
  readonly clientRequestId: UuidV7;
  readonly amountDelta: Money;
  readonly reason: string;
  readonly dueDays?: number | null;
}

export interface CustomerLedgerMutationOutcome {
  readonly customer: CustomerSummaryRecord;
  readonly entry: StoredCustomerLedgerEntryRecord;
  readonly cashMove: StoredCashMoveRecord | null;
  readonly idempotentReplay: boolean;
}

export interface CustomerLedgerListQueryInput {
  readonly limit?: number;
  readonly offset?: number;
  readonly order?: 'asc' | 'desc';
  readonly entryType?: CustomerLedgerEntryType;
}

export interface CustomerLedgerListOutcome {
  readonly customerId: UuidV7;
  readonly currentBalance: Money;
  readonly items: readonly StoredCustomerLedgerEntryRecord[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface RebuildCustomerBalancesOutcome {
  readonly customersProcessed: number;
  readonly balancesUpdated: number;
}

export interface RebuildCustomerSearchIndexOutcome {
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

function isPhoneUniqueConstraintError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const msg = err.message;
  return (
    msg.includes('uidx_customers_org_phone_active') ||
    msg.includes('UNIQUE constraint failed: customers')
  );
}

interface HubCustomerConfigSnapshot {
  readonly storeTimezone: string;
  readonly defaultCustomerDueDays: number | null;
}

function readHubCustomerConfigSync(
  db: BetterSQLite3Database,
  organizationId: UuidV7,
): HubCustomerConfigSnapshot {
  const row = db
    .select({
      storeTimezone: localHubConfig.storeTimezone,
      defaultCustomerDueDays: localHubConfig.defaultCustomerDueDays,
    })
    .from(localHubConfig)
    .where(eq(localHubConfig.organizationId, organizationId))
    .limit(1)
    .all()[0];
  return {
    storeTimezone: row?.storeTimezone ?? DEFAULT_STORE_TIMEZONE,
    defaultCustomerDueDays:
      row !== undefined ? row.defaultCustomerDueDays : DEFAULT_CUSTOMER_DUE_DAYS,
  };
}

function readActiveCustomerRowSync(
  db: BetterSQLite3Database,
  organizationId: UuidV7,
  customerId: UuidV7,
): typeof customers.$inferSelect {
  const validId = parseUuidV7(customerId);
  const row = db
    .select()
    .from(customers)
    .where(
      and(
        eq(customers.id, validId),
        eq(customers.organizationId, organizationId),
        isNull(customers.deletedAtMs),
      ),
    )
    .limit(1)
    .all()[0];

  if (!row) {
    throw new DomainError('CUSTOMER_NOT_FOUND', 'Customer record not found');
  }
  return row;
}

interface RawLedgerFifoRow {
  readonly id: string;
  readonly hlc: string;
  readonly created_at_ms: bigint | number;
  readonly entry_type: string;
  readonly amount_delta: bigint | number;
  readonly source_type: string;
  readonly sale_id: string | null;
  readonly payment_method: string | null;
  readonly due_at_ms: bigint | number | null;
}

const FIFO_STMT_CACHE = new WeakMap<Database.Database, Database.Statement>();

function getLedgerFifoStatement(sqlite: Database.Database): Database.Statement {
  let stmt = FIFO_STMT_CACHE.get(sqlite);
  if (!stmt) {
    stmt = sqlite
      .prepare(
        `SELECT "id", "hlc", "created_at_ms", "entry_type", "amount_delta", "source_type", "sale_id", "payment_method", "due_at_ms"
         FROM "customer_ledger"
         WHERE "organization_id" = ? AND "customer_id" = ?
         ORDER BY "hlc" ASC, "id" ASC`,
      )
      .safeIntegers(true);
    FIFO_STMT_CACHE.set(sqlite, stmt);
  }
  return stmt;
}

/**
 * Replays all `customer_ledger` rows for a customer in deterministic `(hlc ASC, id ASC)` order (D2).
 * Uses a cached raw `better-sqlite3` statement (`safeIntegers(true)`) so 5,000+ rows replay in <15ms (D4).
 */
export function readCustomerLedgerFifoSync(
  sqlite: Database.Database,
  params: {
    readonly organizationId: UuidV7;
    readonly customerId: UuidV7;
    readonly asOfMs: UnixMs;
    readonly storeTimezone: string;
  },
): { readonly fifo: CustomerLedgerFifoResult; readonly lastActivityAtMs: UnixMs | null } {
  const rawRows = getLedgerFifoStatement(sqlite).all(
    params.organizationId,
    params.customerId,
  ) as RawLedgerFifoRow[];

  const entries: LedgerEntryForFifo[] = [];
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
      entryType: r.entry_type as CustomerLedgerEntryType,
      amountDelta: moneyFromTiyin(toBigInt(r.amount_delta)),
      sourceType: r.source_type as CustomerLedgerSourceType,
      saleId: r.sale_id as UuidV7 | null,
      paymentMethod: r.payment_method !== null ? parsePaymentMethod(r.payment_method) : null,
      dueAtMs: toNullableUnixMs(r.due_at_ms),
    });
  }

  const fifo = allocateCustomerLedgerFifo({
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

const UPSERT_BAL_STMT_CACHE = new WeakMap<Database.Database, Database.Statement>();

function upsertCustomerBalanceProjectionSync(
  session: SqliteUnitOfWorkSession,
  params: {
    readonly organizationId: UuidV7;
    readonly customerId: UuidV7;
    readonly balance: Money;
    readonly totalDebtAccrued: Money;
    readonly totalSettled: Money;
    readonly earliestOpenDueAtMs: UnixMs | null;
    readonly lastActivityAtMs: UnixMs | null;
    readonly nowMs: UnixMs;
  },
): void {
  const sqlite = session.internalGetSqlite();
  let stmt = UPSERT_BAL_STMT_CACHE.get(sqlite);
  if (!stmt) {
    stmt = sqlite.prepare(
      `INSERT INTO "local_customer_balances" (
         "id", "organization_id", "created_at_ms", "updated_at_ms",
         "customer_id", "balance", "total_debt_accrued", "total_settled",
         "earliest_open_due_at_ms", "last_activity_at_ms"
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT("customer_id") DO UPDATE SET
         "updated_at_ms" = excluded."updated_at_ms",
         "balance" = excluded."balance",
         "total_debt_accrued" = excluded."total_debt_accrued",
         "total_settled" = excluded."total_settled",
         "earliest_open_due_at_ms" = excluded."earliest_open_due_at_ms",
         "last_activity_at_ms" = excluded."last_activity_at_ms"`,
    );
    UPSERT_BAL_STMT_CACHE.set(sqlite, stmt);
  }

  stmt.run(
    session.nextId(),
    params.organizationId,
    BigInt(params.nowMs),
    BigInt(params.nowMs),
    params.customerId,
    moneyToTiyin(params.balance),
    moneyToTiyin(params.totalDebtAccrued),
    moneyToTiyin(params.totalSettled),
    params.earliestOpenDueAtMs !== null ? BigInt(params.earliestOpenDueAtMs) : null,
    params.lastActivityAtMs !== null ? BigInt(params.lastActivityAtMs) : null,
  );
}

function readBalanceProjectionRowSync(
  db: BetterSQLite3Database,
  organizationId: UuidV7,
  customerId: UuidV7,
): typeof localCustomerBalances.$inferSelect | undefined {
  return db
    .select()
    .from(localCustomerBalances)
    .where(
      and(
        eq(localCustomerBalances.organizationId, organizationId),
        eq(localCustomerBalances.customerId, customerId),
      ),
    )
    .limit(1)
    .all()[0];
}

function toCustomerSummary(
  row: typeof customers.$inferSelect,
  fifo: CustomerLedgerFifoResult,
  lastActivityAtMs: UnixMs | null,
): CustomerSummaryRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    fullName: row.fullName,
    phoneNormalized: row.phoneNormalized,
    creditLimit: row.creditLimit,
    defaultDueDays: row.defaultDueDays,
    note: row.note,
    isActive: row.isActive,
    balance: fifo.balance,
    totalDebtAccrued: fifo.totalDebtAccrued,
    totalSettled: fifo.totalSettled,
    overdueAmount: fifo.overdueAmount,
    oldestOverdueDays: Number(fifo.oldestOverdueDays),
    lastActivityAtMs,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

function toStoredLedgerEntry(
  row: typeof customerLedger.$inferSelect,
  balanceAfter: Money,
): StoredCustomerLedgerEntryRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    storeId: row.storeId,
    deviceId: row.deviceId,
    customerId: row.customerId,
    entryType: row.entryType as CustomerLedgerEntryType,
    amountDelta: row.amountDelta,
    balanceAfter,
    sourceType: row.sourceType as CustomerLedgerSourceType,
    sourceId: row.sourceId,
    saleId: row.saleId,
    paymentMethod: row.paymentMethod !== null ? parsePaymentMethod(row.paymentMethod) : null,
    providerRef: row.providerRef,
    cashMoveId: row.cashMoveId,
    dueAtMs: row.dueAtMs,
    reason: row.reason,
    createdByUserId: row.createdByUserId,
    overrideApprovedByUserId: row.overrideApprovedByUserId,
    createdAtMs: row.createdAtMs,
  };
}

function toStoredCashMove(row: typeof cashMoves.$inferSelect): StoredCashMoveRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    storeId: row.storeId,
    deviceId: row.deviceId,
    shiftId: row.shiftId,
    type: row.type as StoredCashMoveRecord['type'],
    amountDelta: row.amountDelta,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    paymentId: row.paymentId,
    reason: row.reason,
    createdByUserId: row.createdByUserId,
    createdAtMs: row.createdAtMs,
  };
}

/**
 * Validates customer existence, active status & credit limit during `completeSale`.
 * Returns customer context before `sales` row insert so failure rolls back zero writes.
 */
export function prepareCustomerForSaleInTxSync(
  session: SqliteUnitOfWorkSession,
  params: {
    readonly organizationId: UuidV7;
    readonly customerId: UuidV7;
    readonly debtAmount: Money;
    readonly dueDays?: number | null;
    readonly creditOverrideApprovedByUserId?: UuidV7 | null;
    readonly saleCreatedAtMs: UnixMs;
  },
): {
  readonly customer: typeof customers.$inferSelect;
  readonly currentBalance: Money;
  readonly dueAtMs: UnixMs | null;
} {
  const customer = readActiveCustomerRowSync(session.db, params.organizationId, params.customerId);
  if (!customer.isActive) {
    throw new DomainError(
      'CUSTOMER_INACTIVE',
      'Inactive customers cannot be attached to new sales or credit',
    );
  }

  const debtTiyin = moneyToTiyin(params.debtAmount);
  if (debtTiyin === 0n) {
    return {
      customer,
      currentBalance: ZERO_MONEY,
      dueAtMs: null,
    };
  }

  const hubCfg = readHubCustomerConfigSync(session.db, params.organizationId);
  const { fifo } = readCustomerLedgerFifoSync(session.internalGetSqlite(), {
    organizationId: params.organizationId,
    customerId: customer.id,
    asOfMs: params.saleCreatedAtMs,
    storeTimezone: hubCfg.storeTimezone,
  });

  // D1 guard + Credit limit enforcement
  computeNextCustomerBalance({
    currentBalance: fifo.balance,
    delta: params.debtAmount,
    operation: 'sale_debt',
  });
  assertCreditLimitForSale({
    currentBalance: fifo.balance,
    newDebtAmount: params.debtAmount,
    creditLimit: customer.creditLimit,
    creditOverrideAuthorized:
      params.creditOverrideApprovedByUserId !== undefined &&
      params.creditOverrideApprovedByUserId !== null,
  });

  const effectiveDueDays =
    params.dueDays !== undefined
      ? normalizeCustomerDueDays(params.dueDays)
      : (customer.defaultDueDays ?? hubCfg.defaultCustomerDueDays);
  const dueAtMs = computeDebtDueAtMs({
    createdAtMs: params.saleCreatedAtMs,
    dueDays: effectiveDueDays,
    storeTimezone: hubCfg.storeTimezone,
    resolveTimeZoneDateKey: resolveIntlDateKey,
  });

  return {
    customer,
    currentBalance: fifo.balance,
    dueAtMs,
  };
}

/**
 * Atomically records `sale_debt` in `customer_ledger` and updates `local_customer_balances` inside
 * `completeSale` AFTER the parent `sales` row has been inserted.
 */
export function recordSaleDebtInTxSync(
  session: SqliteUnitOfWorkSession,
  params: {
    readonly organizationId: UuidV7;
    readonly storeId: UuidV7;
    readonly customerId: UuidV7;
    readonly saleId: UuidV7;
    readonly debtAmount: Money;
    readonly dueAtMs: UnixMs | null;
    readonly actorUserId: UuidV7;
    readonly overrideApprovedByUserId: UuidV7 | null;
    readonly nowMs: UnixMs;
  },
): void {
  const hubCfg = readHubCustomerConfigSync(session.db, params.organizationId);
  const { fifo: beforeFifo } = readCustomerLedgerFifoSync(session.internalGetSqlite(), {
    organizationId: params.organizationId,
    customerId: params.customerId,
    asOfMs: params.nowMs,
    storeTimezone: hubCfg.storeTimezone,
  });

  // D1 balance guard
  const nextBalance = computeNextCustomerBalance({
    currentBalance: beforeFifo.balance,
    delta: params.debtAmount,
    operation: 'sale_debt',
  });

  insertFact(session, customerLedger, {
    organizationId: params.organizationId,
    storeId: params.storeId,
    values: {
      customerId: params.customerId,
      entryType: 'sale_debt',
      amountDelta: params.debtAmount,
      sourceType: 'sale',
      sourceId: params.saleId,
      saleId: params.saleId,
      paymentMethod: null,
      providerRef: null,
      cashMoveId: null,
      dueAtMs: params.dueAtMs,
      reason: null,
      createdByUserId: params.actorUserId,
      overrideApprovedByUserId: params.overrideApprovedByUserId,
      clientRequestId: null,
      requestHash: null,
    },
    eventType: 'customer_ledger.created',
    schemaVersion: 1,
  });

  const newDue = params.dueAtMs;
  const prevEarliest = beforeFifo.earliestOpenDueAtMs;
  const nextEarliest =
    newDue !== null && (prevEarliest === null || BigInt(newDue) < BigInt(prevEarliest))
      ? newDue
      : prevEarliest;

  upsertCustomerBalanceProjectionSync(session, {
    organizationId: params.organizationId,
    customerId: params.customerId,
    balance: nextBalance,
    totalDebtAccrued: moneyFromTiyin(
      moneyToTiyin(beforeFifo.totalDebtAccrued) + moneyToTiyin(params.debtAmount),
    ),
    totalSettled: beforeFifo.totalSettled,
    earliestOpenDueAtMs: nextEarliest,
    lastActivityAtMs: params.nowMs,
    nowMs: params.nowMs,
  });
}

/**
 * Loads FIFO remaining debt & paid-toward-debt breakdown for a sale during `createReturn`.
 */
export function prepareReturnSaleDebtContextInTxSync(
  session: SqliteUnitOfWorkSession,
  params: {
    readonly organizationId: UuidV7;
    readonly customerId: UuidV7 | null;
    readonly saleId: UuidV7;
    readonly saleDebtAmount: Money;
    readonly nowMs: UnixMs;
  },
): {
  readonly currentBalance: Money;
  readonly remainingSaleDebt: Money;
  readonly paidTowardDebtByMethod: Readonly<Record<PaymentMethod, Money>>;
} | null {
  if (moneyToTiyin(params.saleDebtAmount) === 0n) {
    return null;
  }
  if (params.customerId === null) {
    throw new DomainError(
      'CUSTOMER_REQUIRED',
      'Debt sale has no attached customerId and cannot be returned without customer ledger',
    );
  }
  const hubCfg = readHubCustomerConfigSync(session.db, params.organizationId);
  const { fifo } = readCustomerLedgerFifoSync(session.internalGetSqlite(), {
    organizationId: params.organizationId,
    customerId: params.customerId,
    asOfMs: params.nowMs,
    storeTimezone: hubCfg.storeTimezone,
  });
  const ob = fifo.bySaleId.get(params.saleId);
  if (!ob) {
    throw new DomainError(
      'VALIDATION_ERROR',
      `Missing customer_ledger sale_debt row for sale "${params.saleId}"`,
    );
  }
  return {
    currentBalance: fifo.balance,
    remainingSaleDebt: ob.remainingDebt,
    paidTowardDebtByMethod: ob.fifoPaidByMethod,
  };
}

/**
 * Applies `return_offset` to `customer_ledger` & updates `local_customer_balances` atomically inside `createReturn`.
 */
export function applyReturnDebtOffsetInTxSync(
  session: SqliteUnitOfWorkSession,
  params: {
    readonly organizationId: UuidV7;
    readonly storeId: UuidV7;
    readonly customerId: UuidV7;
    readonly saleId: UuidV7;
    readonly returnId: UuidV7;
    readonly debtOffsetAmount: Money;
    readonly currentBalance: Money;
    readonly remainingSaleDebt: Money;
    readonly reason: string;
    readonly actorUserId: UuidV7;
    readonly nowMs: UnixMs;
  },
): void {
  if (moneyToTiyin(params.debtOffsetAmount) === 0n) {
    return;
  }
  const delta = negateMoney(params.debtOffsetAmount);

  // D1 guard
  computeNextCustomerBalance({
    currentBalance: params.currentBalance,
    delta,
    operation: 'return_offset',
    saleRemainingDebt: params.remainingSaleDebt,
  });

  insertFact(session, customerLedger, {
    organizationId: params.organizationId,
    storeId: params.storeId,
    values: {
      customerId: params.customerId,
      entryType: 'return_offset',
      amountDelta: delta,
      sourceType: 'return',
      sourceId: params.returnId,
      saleId: params.saleId,
      paymentMethod: null,
      providerRef: null,
      cashMoveId: null,
      dueAtMs: null,
      reason: params.reason,
      createdByUserId: params.actorUserId,
      overrideApprovedByUserId: null,
      clientRequestId: null,
      requestHash: null,
    },
    eventType: 'customer_ledger.created',
    schemaVersion: 1,
  });

  const hubCfg = readHubCustomerConfigSync(session.db, params.organizationId);
  const { fifo: afterFifo } = readCustomerLedgerFifoSync(session.internalGetSqlite(), {
    organizationId: params.organizationId,
    customerId: params.customerId,
    asOfMs: params.nowMs,
    storeTimezone: hubCfg.storeTimezone,
  });

  upsertCustomerBalanceProjectionSync(session, {
    organizationId: params.organizationId,
    customerId: params.customerId,
    balance: afterFifo.balance,
    totalDebtAccrued: afterFifo.totalDebtAccrued,
    totalSettled: afterFifo.totalSettled,
    earliestOpenDueAtMs: afterFifo.earliestOpenDueAtMs,
    lastActivityAtMs: params.nowMs,
    nowMs: params.nowMs,
  });
}

/**
 * Validates and reverses a debt sale inside `voidSale`:
 * Rejects with `SALE_DEBT_HAS_PAYMENTS` (409) if any FIFO payment or adjustment already reduced
 * this sale's debt (or customer balance is below `saleDebtAmount`) to uphold D1 (`balance >= 0`).
 */
export function reverseSaleDebtOnVoidInTxSync(
  session: SqliteUnitOfWorkSession,
  params: {
    readonly organizationId: UuidV7;
    readonly storeId: UuidV7;
    readonly customerId: UuidV7 | null;
    readonly saleId: UuidV7;
    readonly saleDebtAmount: Money;
    readonly reason: string;
    readonly actorUserId: UuidV7;
    readonly nowMs: UnixMs;
  },
): void {
  const debtTiyin = moneyToTiyin(params.saleDebtAmount);
  if (debtTiyin === 0n) {
    return;
  }
  if (params.customerId === null) {
    throw new DomainError(
      'CUSTOMER_REQUIRED',
      'Debt sale has no attached customerId and cannot be voided',
    );
  }

  const hubCfg = readHubCustomerConfigSync(session.db, params.organizationId);
  const { fifo } = readCustomerLedgerFifoSync(session.internalGetSqlite(), {
    organizationId: params.organizationId,
    customerId: params.customerId,
    asOfMs: params.nowMs,
    storeTimezone: hubCfg.storeTimezone,
  });
  const ob = fifo.bySaleId.get(params.saleId);
  if (!ob) {
    throw new DomainError(
      'VALIDATION_ERROR',
      `Missing customer_ledger sale_debt row for sale "${params.saleId}"`,
    );
  }
  if (moneyToTiyin(ob.fifoPaidTotal) > 0n || moneyToTiyin(ob.fifoWaivedTotal) > 0n) {
    throw new DomainError(
      'SALE_DEBT_HAS_PAYMENTS',
      'Cannot void debt sale that already has applied payments or adjustments; use createReturn instead',
    );
  }

  const delta = negateMoney(params.saleDebtAmount);
  // D1 guard
  computeNextCustomerBalance({
    currentBalance: fifo.balance,
    delta,
    operation: 'sale_void',
    saleRemainingDebt: ob.remainingDebt,
  });

  insertFact(session, customerLedger, {
    organizationId: params.organizationId,
    storeId: params.storeId,
    values: {
      customerId: params.customerId,
      entryType: 'return_offset',
      amountDelta: delta,
      sourceType: 'sale_void',
      sourceId: params.saleId,
      saleId: params.saleId,
      paymentMethod: null,
      providerRef: null,
      cashMoveId: null,
      dueAtMs: null,
      reason: params.reason,
      createdByUserId: params.actorUserId,
      overrideApprovedByUserId: null,
      clientRequestId: null,
      requestHash: null,
    },
    eventType: 'customer_ledger.created',
    schemaVersion: 1,
  });

  const { fifo: afterFifo } = readCustomerLedgerFifoSync(session.internalGetSqlite(), {
    organizationId: params.organizationId,
    customerId: params.customerId,
    asOfMs: params.nowMs,
    storeTimezone: hubCfg.storeTimezone,
  });

  upsertCustomerBalanceProjectionSync(session, {
    organizationId: params.organizationId,
    customerId: params.customerId,
    balance: afterFifo.balance,
    totalDebtAccrued: afterFifo.totalDebtAccrued,
    totalSettled: afterFifo.totalSettled,
    earliestOpenDueAtMs: afterFifo.earliestOpenDueAtMs,
    lastActivityAtMs: params.nowMs,
    nowMs: params.nowMs,
  });
}

export class SqliteCustomerStore {
  private readonly connection: LocalSqliteConnection;
  private readonly getRuntimeContext: () => CustomerRuntimeContext | null;

  constructor(options: CreateSqliteCustomerStoreOptions) {
    this.connection = options.connection;
    this.getRuntimeContext = options.getRuntimeContext;
  }

  private requireContext(): CustomerRuntimeContext {
    const ctx = this.getRuntimeContext();
    if (!ctx) {
      throw new DomainError('AUTH_UNAUTHORIZED', 'Hub setup has not completed yet');
    }
    return ctx;
  }

  async createCustomer(input: CreateCustomerInput): Promise<CustomerSummaryRecord> {
    const ctx = this.requireContext();
    const fullName = normalizeCustomerFullName(input.fullName);
    const nameSearch = normalizeCustomerSearchText(fullName);
    const phone = normalizeCustomerPhone(input.phone);
    const creditLimit = assertValidCreditLimit(input.creditLimit);
    const defaultDueDays = normalizeCustomerDueDays(input.defaultDueDays);
    const note = normalizeCustomerNote(input.note);

    return ctx.uow.execute((session) => {
      const nowMs = session.nowUnixMs();
      try {
        const writeRes = insertAttr(session, customers, {
          organizationId: ctx.organizationId,
          values: {
            fullName,
            nameSearch,
            phoneNormalized: phone ? phone.phoneNormalized : null,
            phoneDigits: phone ? phone.phoneDigits : null,
            creditLimit,
            defaultDueDays,
            note,
            isActive: true,
          },
          eventType: 'customer.created',
          schemaVersion: 1,
        });

        upsertCustomerBalanceProjectionSync(session, {
          organizationId: ctx.organizationId,
          customerId: writeRes.entityId,
          balance: ZERO_MONEY,
          totalDebtAccrued: ZERO_MONEY,
          totalSettled: ZERO_MONEY,
          earliestOpenDueAtMs: null,
          lastActivityAtMs: null,
          nowMs,
        });

        const insertedRow = readActiveCustomerRowSync(
          session.db,
          ctx.organizationId,
          writeRes.entityId,
        );
        const hubCfg = readHubCustomerConfigSync(session.db, ctx.organizationId);
        const { fifo, lastActivityAtMs } = readCustomerLedgerFifoSync(session.internalGetSqlite(), {
          organizationId: ctx.organizationId,
          customerId: insertedRow.id,
          asOfMs: nowMs,
          storeTimezone: hubCfg.storeTimezone,
        });
        return Promise.resolve(toCustomerSummary(insertedRow, fifo, lastActivityAtMs));
      } catch (err) {
        if (isPhoneUniqueConstraintError(err)) {
          throw new DomainError(
            'CUSTOMER_PHONE_ALREADY_EXISTS',
            'A customer with this phone number already exists',
          );
        }
        throw err;
      }
    });
  }

  async updateCustomer(
    customerId: UuidV7,
    input: UpdateCustomerInput,
  ): Promise<CustomerSummaryRecord> {
    const ctx = this.requireContext();
    const validId = parseUuidV7(customerId);

    return ctx.uow.execute((session) => {
      const nowMs = session.nowUnixMs();
      const existing = readActiveCustomerRowSync(session.db, ctx.organizationId, validId);

      const nextFullName =
        input.fullName !== undefined
          ? normalizeCustomerFullName(input.fullName)
          : existing.fullName;
      const nextNameSearch =
        input.fullName !== undefined
          ? normalizeCustomerSearchText(nextFullName)
          : existing.nameSearch;
      const nextPhone = input.phone !== undefined ? normalizeCustomerPhone(input.phone) : undefined;
      const nextCreditLimit =
        input.creditLimit !== undefined
          ? assertValidCreditLimit(input.creditLimit)
          : existing.creditLimit;
      const nextDueDays =
        input.defaultDueDays !== undefined
          ? normalizeCustomerDueDays(input.defaultDueDays)
          : existing.defaultDueDays;
      const nextNote = input.note !== undefined ? normalizeCustomerNote(input.note) : existing.note;
      const nextIsActive = input.isActive !== undefined ? input.isActive : existing.isActive;

      try {
        updateAttr(session, customers, {
          id: validId,
          organizationId: ctx.organizationId,
          values: {
            fullName: nextFullName,
            nameSearch: nextNameSearch,
            ...(nextPhone !== undefined
              ? {
                  phoneNormalized: nextPhone ? nextPhone.phoneNormalized : null,
                  phoneDigits: nextPhone ? nextPhone.phoneDigits : null,
                }
              : {}),
            creditLimit: nextCreditLimit,
            defaultDueDays: nextDueDays,
            note: nextNote,
            isActive: nextIsActive,
          },
          eventType: 'customer.updated',
          schemaVersion: 1,
        });
      } catch (err) {
        if (isPhoneUniqueConstraintError(err)) {
          throw new DomainError(
            'CUSTOMER_PHONE_ALREADY_EXISTS',
            'A customer with this phone number already exists',
          );
        }
        throw err;
      }

      const updated = readActiveCustomerRowSync(session.db, ctx.organizationId, validId);
      const hubCfg = readHubCustomerConfigSync(session.db, ctx.organizationId);
      const { fifo, lastActivityAtMs } = readCustomerLedgerFifoSync(session.internalGetSqlite(), {
        organizationId: ctx.organizationId,
        customerId: updated.id,
        asOfMs: nowMs,
        storeTimezone: hubCfg.storeTimezone,
      });
      return Promise.resolve(toCustomerSummary(updated, fifo, lastActivityAtMs));
    });
  }

  async archiveCustomer(
    customerId: UuidV7,
  ): Promise<{ readonly customerId: UuidV7; readonly deletedAtMs: UnixMs }> {
    const ctx = this.requireContext();
    const validId = parseUuidV7(customerId);

    return ctx.uow.execute((session) => {
      const nowMs = session.nowUnixMs();
      const row = readActiveCustomerRowSync(session.db, ctx.organizationId, validId);
      const hubCfg = readHubCustomerConfigSync(session.db, ctx.organizationId);
      const { fifo } = readCustomerLedgerFifoSync(session.internalGetSqlite(), {
        organizationId: ctx.organizationId,
        customerId: row.id,
        asOfMs: nowMs,
        storeTimezone: hubCfg.storeTimezone,
      });

      if (moneyToTiyin(fifo.balance) !== 0n) {
        throw new DomainError(
          'CUSTOMER_HAS_OPEN_DEBT',
          'Customer with non-zero debt balance cannot be archived',
        );
      }

      const deleted = tombstoneAttr(session, customers, {
        id: row.id,
        organizationId: ctx.organizationId,
        eventType: 'customer.deleted',
        schemaVersion: 1,
      });

      return Promise.resolve({
        customerId: deleted.entityId,
        deletedAtMs: deleted.row.deletedAtMs!,
      });
    });
  }

  async getCustomerDetail(customerId: UuidV7): Promise<CustomerDetailRecord> {
    const ctx = this.requireContext();
    const validId = parseUuidV7(customerId);
    return runConnectionReadOnly(this.connection, () => {
      const db = this.connection.db;
      const nowMs = ctx.uow.nowUnixMs();
      const row = readActiveCustomerRowSync(db, ctx.organizationId, validId);
      const hubCfg = readHubCustomerConfigSync(db, ctx.organizationId);
      const { fifo, lastActivityAtMs } = readCustomerLedgerFifoSync(this.connection.sqlite, {
        organizationId: ctx.organizationId,
        customerId: row.id,
        asOfMs: nowMs,
        storeTimezone: hubCfg.storeTimezone,
      });
      return Promise.resolve({
        customer: toCustomerSummary(row, fifo, lastActivityAtMs),
        openObligations: fifo.obligations.filter((o) => moneyToTiyin(o.remainingDebt) > 0n),
      });
    });
  }

  async listCustomers(query?: CustomerListQueryInput): Promise<CustomerListOutcome> {
    const ctx = this.requireContext();
    const limit = query?.limit ?? 50;
    const offset = query?.offset ?? 0;
    const includeInactive = query?.includeInactive ?? false;
    const overdueOnly = query?.overdueOnly ?? false;
    const rawQ = query?.q?.trim() ?? '';

    return runConnectionReadOnly(this.connection, () => {
      const db = this.connection.db;
      const nowMs = ctx.uow.nowUnixMs();
      const hubCfg = readHubCustomerConfigSync(db, ctx.organizationId);

      const orderedParams: (string | number | bigint)[] = [];
      let finalFrom = `"customers" c LEFT JOIN "local_customer_balances" b ON b."customer_id" = c."id"`;
      const finalWhere: string[] = ['c."organization_id" = ?', 'c."deleted_at_ms" IS NULL'];
      let orderClause = 'ORDER BY c."name_search" ASC, c."id" ASC';
      orderedParams.push(ctx.organizationId);

      if (!includeInactive) {
        finalWhere.push('c."is_active" = 1');
      }
      if (overdueOnly) {
        finalWhere.push(
          'b."balance" > 0 AND b."earliest_open_due_at_ms" IS NOT NULL AND b."earliest_open_due_at_ms" <= ?',
        );
        orderedParams.push(BigInt(nowMs));
        orderClause = 'ORDER BY b."earliest_open_due_at_ms" ASC, b."balance" DESC, c."id" ASC';
      }
      if (rawQ.length > 0) {
        const isNumericSearch = /^[\d\s\-().+]+$/.test(rawQ);
        const { digitsOnly } = normalizeCustomerSearchQuery(rawQ);
        if (isNumericSearch && digitsOnly.length >= 2) {
          const uzPrefix =
            digitsOnly.length <= 9 && !digitsOnly.startsWith('998')
              ? `998${digitsOnly}%`
              : `${digitsOnly}%`;
          finalWhere.push('(c."phone_digits" LIKE ? OR c."phone_digits" LIKE ?)');
          orderedParams.push(uzPrefix, `%${digitsOnly}%`);
        } else {
          const ftsExpr = buildFtsPrefixQuery(rawQ);
          if (ftsExpr !== null) {
            finalFrom = `"customers_fts" f INNER JOIN "customers" c ON c."id" = f."customer_id" LEFT JOIN "local_customer_balances" b ON b."customer_id" = c."id"`;
            finalWhere.push('f."customers_fts" MATCH ? AND f."organization_id" = ?');
            orderedParams.push(ftsExpr, ctx.organizationId);
            if (!overdueOnly) {
              orderClause = 'ORDER BY f.rank ASC, c."id" ASC';
            }
          }
        }
      }
      orderedParams.push(limit, offset);

      const fullSql = `
        SELECT
          c."id", c."organization_id", c."full_name", c."phone_normalized",
          c."credit_limit", c."default_due_days", c."note", c."is_active",
          c."created_at_ms", c."updated_at_ms",
          COALESCE(b."balance", 0) AS "balance",
          COALESCE(b."total_debt_accrued", 0) AS "total_debt_accrued",
          COALESCE(b."total_settled", 0) AS "total_settled",
          b."earliest_open_due_at_ms" AS "earliest_open_due_at_ms",
          b."last_activity_at_ms" AS "last_activity_at_ms",
          COUNT(*) OVER() AS "total_matched"
        FROM ${finalFrom}
        WHERE ${finalWhere.join(' AND ')}
        ${orderClause}
        LIMIT ? OFFSET ?
      `;

      const rows = this.connection.sqlite
        .prepare(fullSql)
        .safeIntegers(true)
        .all(...orderedParams) as Array<{
        readonly id: string;
        readonly organization_id: string;
        readonly full_name: string;
        readonly phone_normalized: string | null;
        readonly credit_limit: bigint | number | null;
        readonly default_due_days: bigint | number | null;
        readonly note: string | null;
        readonly is_active: bigint | number;
        readonly created_at_ms: bigint | number;
        readonly updated_at_ms: bigint | number;
        readonly balance: bigint | number;
        readonly total_debt_accrued: bigint | number;
        readonly total_settled: bigint | number;
        readonly earliest_open_due_at_ms: bigint | number | null;
        readonly last_activity_at_ms: bigint | number | null;
        readonly total_matched: bigint | number;
      }>;

      const total = rows.length > 0 && rows[0] ? Number(rows[0].total_matched) : 0;
      const nowBig = BigInt(nowMs);
      const items: CustomerSummaryRecord[] = rows.map((r) => {
        const balanceTiyin = toBigInt(r.balance);
        const earliestDueBig =
          r.earliest_open_due_at_ms !== null ? toBigInt(r.earliest_open_due_at_ms) : null;

        let overdueAmount = ZERO_MONEY;
        let oldestOverdueDays = 0;

        // Only replay FIFO for customers on this page whose projection shows open overdue items
        if (balanceTiyin > 0n && earliestDueBig !== null && earliestDueBig <= nowBig) {
          const { fifo } = readCustomerLedgerFifoSync(this.connection.sqlite, {
            organizationId: ctx.organizationId,
            customerId: r.id as UuidV7,
            asOfMs: nowMs,
            storeTimezone: hubCfg.storeTimezone,
          });
          overdueAmount = fifo.overdueAmount;
          oldestOverdueDays = Number(fifo.oldestOverdueDays);
        }

        return {
          id: r.id as UuidV7,
          organizationId: r.organization_id as UuidV7,
          fullName: r.full_name,
          phoneNormalized: r.phone_normalized,
          creditLimit: r.credit_limit !== null ? moneyFromTiyin(toBigInt(r.credit_limit)) : null,
          defaultDueDays: r.default_due_days !== null ? Number(toBigInt(r.default_due_days)) : null,
          note: r.note,
          isActive: toBigInt(r.is_active) === 1n,
          balance: moneyFromTiyin(balanceTiyin),
          totalDebtAccrued: moneyFromTiyin(toBigInt(r.total_debt_accrued)),
          totalSettled: moneyFromTiyin(toBigInt(r.total_settled)),
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

  async listOverdueCustomers(query?: CustomerListQueryInput): Promise<CustomerListOutcome> {
    return this.listCustomers({
      ...query,
      overdueOnly: true,
    });
  }

  async listCustomerLedger(
    customerId: UuidV7,
    query?: CustomerLedgerListQueryInput,
  ): Promise<CustomerLedgerListOutcome> {
    const ctx = this.requireContext();
    const validId = parseUuidV7(customerId);
    const limit = query?.limit ?? 50;
    const offset = query?.offset ?? 0;
    const orderDir = query?.order === 'asc' ? 'ASC' : 'DESC';

    return runConnectionReadOnly(this.connection, () => {
      const db = this.connection.db;
      const cust = readActiveCustomerRowSync(db, ctx.organizationId, validId);
      const balRow = readBalanceProjectionRowSync(db, ctx.organizationId, cust.id);

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
               "id", "organization_id", "store_id", "device_id", "customer_id",
               "entry_type", "amount_delta", "source_type", "source_id", "sale_id",
               "payment_method", "provider_ref", "cash_move_id", "due_at_ms",
               "reason", "created_by_user_id", "override_approved_by_user_id",
               "created_at_ms", "hlc",
               SUM("amount_delta") OVER (
                 PARTITION BY "organization_id", "customer_id"
                 ORDER BY "hlc" ASC, "id" ASC
                 ROWS UNBOUNDED PRECEDING
               ) AS "balance_after"
             FROM "customer_ledger"
             WHERE "organization_id" = ? AND "customer_id" = ?
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
        readonly customer_id: string;
        readonly entry_type: string;
        readonly amount_delta: bigint | number;
        readonly source_type: string;
        readonly source_id: string;
        readonly sale_id: string | null;
        readonly payment_method: string | null;
        readonly provider_ref: string | null;
        readonly cash_move_id: string | null;
        readonly due_at_ms: bigint | number | null;
        readonly reason: string | null;
        readonly created_by_user_id: string;
        readonly override_approved_by_user_id: string | null;
        readonly created_at_ms: bigint | number;
        readonly balance_after: bigint | number;
        readonly total_filtered: bigint | number;
      }>;

      const total = rawRows.length > 0 && rawRows[0] ? Number(rawRows[0].total_filtered) : 0;
      const items: StoredCustomerLedgerEntryRecord[] = rawRows.map((r) => ({
        id: r.id as UuidV7,
        organizationId: r.organization_id as UuidV7,
        storeId: r.store_id as UuidV7,
        deviceId: r.device_id as UuidV7,
        customerId: r.customer_id as UuidV7,
        entryType: r.entry_type as CustomerLedgerEntryType,
        amountDelta: moneyFromTiyin(toBigInt(r.amount_delta)),
        balanceAfter: moneyFromTiyin(toBigInt(r.balance_after)),
        sourceType: r.source_type as CustomerLedgerSourceType,
        sourceId: r.source_id as UuidV7,
        saleId: r.sale_id as UuidV7 | null,
        paymentMethod: r.payment_method !== null ? parsePaymentMethod(r.payment_method) : null,
        providerRef: r.provider_ref,
        cashMoveId: r.cash_move_id as UuidV7 | null,
        dueAtMs: toNullableUnixMs(r.due_at_ms),
        reason: r.reason,
        createdByUserId: r.created_by_user_id as UuidV7,
        overrideApprovedByUserId: r.override_approved_by_user_id as UuidV7 | null,
        createdAtMs: unixMsFromBigInt(toBigInt(r.created_at_ms)),
      }));

      let currentBalance = balRow ? balRow.balance : null;
      if (currentBalance === null) {
        const { fifo } = readCustomerLedgerFifoSync(sqlite, {
          organizationId: ctx.organizationId,
          customerId: validId,
          asOfMs: ctx.uow.nowUnixMs(),
          storeTimezone: readHubCustomerConfigSync(db, ctx.organizationId).storeTimezone,
        });
        currentBalance = fifo.balance;
      }

      return Promise.resolve({
        customerId: validId,
        currentBalance,
        items,
        total,
        limit,
        offset,
      });
    });
  }

  async recordOpeningBalance(
    input: RecordOpeningBalanceInput,
  ): Promise<CustomerLedgerMutationOutcome> {
    const ctx = this.requireContext();
    const validCustomerId = parseUuidV7(input.customerId);
    const validActorId = parseUuidV7(input.actorUserId);
    const validReqId = parseUuidV7(input.clientRequestId);
    const validReason = normalizeMandatoryReason(input.reason);
    const dueDaysOpt =
      input.dueDays !== undefined ? normalizeCustomerDueDays(input.dueDays) : undefined;

    const requestHash = sha256Hex(
      canonicalizeOpeningBalanceRequest({
        customerId: validCustomerId,
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

      const cust = readActiveCustomerRowSync(session.db, ctx.organizationId, validCustomerId);
      const hubCfg = readHubCustomerConfigSync(session.db, ctx.organizationId);
      const effDueDays =
        dueDaysOpt !== undefined
          ? dueDaysOpt
          : (cust.defaultDueDays ?? hubCfg.defaultCustomerDueDays);
      const dueAtMs = computeDebtDueAtMs({
        createdAtMs: nowMs,
        dueDays: effDueDays,
        storeTimezone: hubCfg.storeTimezone,
        resolveTimeZoneDateKey: resolveIntlDateKey,
      });

      const existingOpening = session.db
        .select({ id: customerLedger.id })
        .from(customerLedger)
        .where(
          and(
            eq(customerLedger.organizationId, ctx.organizationId),
            eq(customerLedger.customerId, cust.id),
            eq(customerLedger.entryType, 'opening_balance'),
          ),
        )
        .limit(1)
        .all()[0];
      if (existingOpening) {
        throw new DomainError(
          'OPENING_BALANCE_ALREADY_EXISTS',
          'Customer opening balance has already been recorded',
        );
      }

      const { fifo: beforeFifo } = readCustomerLedgerFifoSync(session.internalGetSqlite(), {
        organizationId: ctx.organizationId,
        customerId: cust.id,
        asOfMs: nowMs,
        storeTimezone: hubCfg.storeTimezone,
      });

      // D1 guard
      computeNextCustomerBalance({
        currentBalance: beforeFifo.balance,
        delta: input.amount,
        operation: 'opening_balance',
      });

      const writeRes = insertFact(session, customerLedger, {
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        values: {
          customerId: cust.id,
          entryType: 'opening_balance',
          amountDelta: input.amount,
          sourceType: 'opening_balance',
          sourceId: cust.id,
          saleId: null,
          paymentMethod: null,
          providerRef: null,
          cashMoveId: null,
          dueAtMs,
          reason: validReason,
          createdByUserId: validActorId,
          overrideApprovedByUserId: null,
          clientRequestId: validReqId,
          requestHash,
        },
        eventType: 'customer_ledger.created',
        schemaVersion: 1,
      });

      const { fifo: afterFifo, lastActivityAtMs } = readCustomerLedgerFifoSync(
        session.internalGetSqlite(),
        {
          organizationId: ctx.organizationId,
          customerId: cust.id,
          asOfMs: nowMs,
          storeTimezone: hubCfg.storeTimezone,
        },
      );

      upsertCustomerBalanceProjectionSync(session, {
        organizationId: ctx.organizationId,
        customerId: cust.id,
        balance: afterFifo.balance,
        totalDebtAccrued: afterFifo.totalDebtAccrued,
        totalSettled: afterFifo.totalSettled,
        earliestOpenDueAtMs: afterFifo.earliestOpenDueAtMs,
        lastActivityAtMs,
        nowMs,
      });

      return Promise.resolve({
        customer: toCustomerSummary(cust, afterFifo, lastActivityAtMs),
        entry: toStoredLedgerEntry(writeRes.row, afterFifo.balance),
        cashMove: null,
        idempotentReplay: false,
      });
    });
  }

  async recordDebtPayment(input: RecordDebtPaymentInput): Promise<CustomerLedgerMutationOutcome> {
    const ctx = this.requireContext();
    const validCustomerId = parseUuidV7(input.customerId);
    const validActorId = parseUuidV7(input.actorUserId);
    const validReqId = parseUuidV7(input.clientRequestId);
    const method = parsePaymentMethod(input.method);
    const providerRef = method === 'cash' ? null : normalizePaymentProviderRef(input.providerRef);
    const reasonOpt =
      input.reason !== undefined && input.reason !== null && input.reason.trim().length > 0
        ? normalizeMandatoryReason(input.reason)
        : null;

    const requestHash = sha256Hex(
      canonicalizeDebtPaymentRequest({
        customerId: validCustomerId,
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

      const cust = readActiveCustomerRowSync(session.db, ctx.organizationId, validCustomerId);
      const hubCfg = readHubCustomerConfigSync(session.db, ctx.organizationId);
      const { fifo: beforeFifo } = readCustomerLedgerFifoSync(session.internalGetSqlite(), {
        organizationId: ctx.organizationId,
        customerId: cust.id,
        asOfMs: nowMs,
        storeTimezone: hubCfg.storeTimezone,
      });

      const delta = negateMoney(input.amount);
      // D1 guard: rejects amount > balance (OVERPAYMENT_NOT_ALLOWED)
      computeNextCustomerBalance({
        currentBalance: beforeFifo.balance,
        delta,
        operation: 'debt_payment',
      });

      let cashMoveRecord: StoredCashMoveRecord | null = null;
      if (method === 'cash') {
        const cashWrite = insertFact(session, cashMoves, {
          organizationId: ctx.organizationId,
          storeId: ctx.storeId,
          values: {
            shiftId: null,
            type: 'debt_payment_in',
            amountDelta: input.amount,
            sourceType: 'debt_payment',
            sourceId: cust.id,
            paymentId: null,
            reason: reasonOpt ?? 'Customer debt payment',
            createdByUserId: validActorId,
          },
          eventType: 'cash_move.created',
          schemaVersion: 1,
        });
        cashMoveRecord = toStoredCashMove(cashWrite.row);
      }

      const ledgerWrite = insertFact(session, customerLedger, {
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        values: {
          customerId: cust.id,
          entryType: 'debt_payment',
          amountDelta: delta,
          sourceType: 'debt_payment',
          sourceId: cust.id,
          saleId: null,
          paymentMethod: method,
          providerRef,
          cashMoveId: cashMoveRecord !== null ? cashMoveRecord.id : null,
          dueAtMs: null,
          reason: reasonOpt,
          createdByUserId: validActorId,
          overrideApprovedByUserId: null,
          clientRequestId: validReqId,
          requestHash,
        },
        eventType: 'customer_ledger.created',
        schemaVersion: 1,
      });

      const { fifo: afterFifo, lastActivityAtMs } = readCustomerLedgerFifoSync(
        session.internalGetSqlite(),
        {
          organizationId: ctx.organizationId,
          customerId: cust.id,
          asOfMs: nowMs,
          storeTimezone: hubCfg.storeTimezone,
        },
      );

      upsertCustomerBalanceProjectionSync(session, {
        organizationId: ctx.organizationId,
        customerId: cust.id,
        balance: afterFifo.balance,
        totalDebtAccrued: afterFifo.totalDebtAccrued,
        totalSettled: afterFifo.totalSettled,
        earliestOpenDueAtMs: afterFifo.earliestOpenDueAtMs,
        lastActivityAtMs,
        nowMs,
      });

      return Promise.resolve({
        customer: toCustomerSummary(cust, afterFifo, lastActivityAtMs),
        entry: toStoredLedgerEntry(ledgerWrite.row, afterFifo.balance),
        cashMove: cashMoveRecord,
        idempotentReplay: false,
      });
    });
  }

  async recordDebtAdjustment(
    input: RecordDebtAdjustmentInput,
  ): Promise<CustomerLedgerMutationOutcome> {
    const ctx = this.requireContext();
    const validCustomerId = parseUuidV7(input.customerId);
    const validActorId = parseUuidV7(input.actorUserId);
    const validReqId = parseUuidV7(input.clientRequestId);
    const validReason = normalizeMandatoryReason(input.reason);
    const deltaTiyin = moneyToTiyin(input.amountDelta);
    // D3: positive adjustment carries optional dueDays ONLY if explicitly specified; negative carries no due date
    const validDueDays =
      deltaTiyin > 0n && input.dueDays !== undefined
        ? normalizeCustomerDueDays(input.dueDays)
        : null;

    const requestHash = sha256Hex(
      canonicalizeDebtAdjustmentRequest({
        customerId: validCustomerId,
        amountDelta: input.amountDelta,
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

      const cust = readActiveCustomerRowSync(session.db, ctx.organizationId, validCustomerId);
      const hubCfg = readHubCustomerConfigSync(session.db, ctx.organizationId);
      const { fifo: beforeFifo } = readCustomerLedgerFifoSync(session.internalGetSqlite(), {
        organizationId: ctx.organizationId,
        customerId: cust.id,
        asOfMs: nowMs,
        storeTimezone: hubCfg.storeTimezone,
      });

      // D1 guard
      computeNextCustomerBalance({
        currentBalance: beforeFifo.balance,
        delta: input.amountDelta,
        operation: 'adjustment',
      });

      const dueAtMs =
        validDueDays !== null
          ? computeDebtDueAtMs({
              createdAtMs: nowMs,
              dueDays: validDueDays,
              storeTimezone: hubCfg.storeTimezone,
              resolveTimeZoneDateKey: resolveIntlDateKey,
            })
          : null;

      const ledgerWrite = insertFact(session, customerLedger, {
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        values: {
          customerId: cust.id,
          entryType: 'adjustment',
          amountDelta: input.amountDelta,
          sourceType: 'adjustment',
          sourceId: cust.id,
          saleId: null,
          paymentMethod: null,
          providerRef: null,
          cashMoveId: null,
          dueAtMs,
          reason: validReason,
          createdByUserId: validActorId,
          overrideApprovedByUserId: null,
          clientRequestId: validReqId,
          requestHash,
        },
        eventType: 'customer_ledger.created',
        schemaVersion: 1,
      });

      const { fifo: afterFifo, lastActivityAtMs } = readCustomerLedgerFifoSync(
        session.internalGetSqlite(),
        {
          organizationId: ctx.organizationId,
          customerId: cust.id,
          asOfMs: nowMs,
          storeTimezone: hubCfg.storeTimezone,
        },
      );

      upsertCustomerBalanceProjectionSync(session, {
        organizationId: ctx.organizationId,
        customerId: cust.id,
        balance: afterFifo.balance,
        totalDebtAccrued: afterFifo.totalDebtAccrued,
        totalSettled: afterFifo.totalSettled,
        earliestOpenDueAtMs: afterFifo.earliestOpenDueAtMs,
        lastActivityAtMs,
        nowMs,
      });

      return Promise.resolve({
        customer: toCustomerSummary(cust, afterFifo, lastActivityAtMs),
        entry: toStoredLedgerEntry(ledgerWrite.row, afterFifo.balance),
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
  ): CustomerLedgerMutationOutcome | null {
    const existing = session.db
      .select()
      .from(customerLedger)
      .where(
        and(
          eq(customerLedger.organizationId, organizationId),
          eq(customerLedger.clientRequestId, clientRequestId),
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
        `clientRequestId "${clientRequestId}" was already used for a different customer ledger payload`,
      );
    }

    const cust = session.db
      .select()
      .from(customers)
      .where(eq(customers.id, existing.customerId))
      .limit(1)
      .all()[0];
    if (!cust) {
      throw new DomainError('CUSTOMER_NOT_FOUND', 'Customer record not found');
    }

    const hubCfg = readHubCustomerConfigSync(session.db, organizationId);
    const { fifo, lastActivityAtMs } = readCustomerLedgerFifoSync(session.internalGetSqlite(), {
      organizationId,
      customerId: cust.id,
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
      customer: toCustomerSummary(cust, fifo, lastActivityAtMs),
      entry: toStoredLedgerEntry(existing, fifo.balance),
      cashMove: cashMove !== null ? toStoredCashMove(cashMove) : null,
      idempotentReplay: true,
    };
  }

  async rebuildCustomerBalances(organizationId?: UuidV7): Promise<RebuildCustomerBalancesOutcome> {
    const validOrgId = organizationId !== undefined ? parseUuidV7(organizationId) : null;
    const ctx = this.getRuntimeContext();
    const nowMs = ctx ? ctx.uow.nowUnixMs() : unixMsFromBigInt(0n);

    return runConnectionProjectionMaintenance(this.connection, (sqlite, db) => {
      const allCustomers =
        validOrgId !== null
          ? db
              .select({ id: customers.id, organizationId: customers.organizationId })
              .from(customers)
              .where(eq(customers.organizationId, validOrgId))
              .all()
          : db
              .select({ id: customers.id, organizationId: customers.organizationId })
              .from(customers)
              .all();

      const orgTimezones = new Map<string, string>();
      const getTz = (orgId: UuidV7): string => {
        const cached = orgTimezones.get(orgId);
        if (cached) return cached;
        const tz = readHubCustomerConfigSync(db, orgId).storeTimezone;
        orgTimezones.set(orgId, tz);
        return tz;
      };

      const insertStmt = sqlite.prepare(
        `INSERT INTO "local_customer_balances" (
           "id", "organization_id", "created_at_ms", "updated_at_ms",
           "customer_id", "balance", "total_debt_accrued", "total_settled",
           "earliest_open_due_at_ms", "last_activity_at_ms"
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      let balancesUpdated = 0;
      if (validOrgId !== null) {
        sqlite
          .prepare('DELETE FROM "local_customer_balances" WHERE "organization_id" = ?')
          .run(validOrgId);
      } else {
        sqlite.prepare('DELETE FROM "local_customer_balances"').run();
      }

      for (let i = 0; i < allCustomers.length; i += 1) {
        const c = allCustomers[i];
        if (!c) continue;
        const tz = getTz(c.organizationId);
        const { fifo, lastActivityAtMs } = readCustomerLedgerFifoSync(sqlite, {
          organizationId: c.organizationId,
          customerId: c.id,
          asOfMs: nowMs,
          storeTimezone: tz,
        });
        // Deterministic synthetic row ID derived without outbox mutation
        const rowId = parseUuidV7(
          `01979999-${(i + 1).toString().padStart(4, '0').slice(-4)}-7000-8000-${(i + 1).toString().padStart(12, '0')}`,
        );
        insertStmt.run(
          rowId,
          c.organizationId,
          BigInt(nowMs),
          BigInt(nowMs),
          c.id,
          moneyToTiyin(fifo.balance),
          moneyToTiyin(fifo.totalDebtAccrued),
          moneyToTiyin(fifo.totalSettled),
          fifo.earliestOpenDueAtMs !== null ? BigInt(fifo.earliestOpenDueAtMs) : null,
          lastActivityAtMs !== null ? BigInt(lastActivityAtMs) : null,
        );
        balancesUpdated += 1;
      }

      return {
        customersProcessed: allCustomers.length,
        balancesUpdated,
      };
    });
  }

  async rebuildCustomerSearchIndex(
    organizationId?: UuidV7,
  ): Promise<RebuildCustomerSearchIndexOutcome> {
    const validOrgId = organizationId !== undefined ? parseUuidV7(organizationId) : null;
    return runConnectionProjectionMaintenance(this.connection, (sqlite) => {
      if (validOrgId !== null) {
        sqlite.prepare('DELETE FROM "customers_fts" WHERE "organization_id" = ?').run(validOrgId);
        const info = sqlite
          .prepare(
            `INSERT INTO "customers_fts" ("customer_id", "organization_id", "name_search", "phone_digits")
             SELECT "id", "organization_id", "name_search", COALESCE("phone_digits", '')
             FROM "customers"
             WHERE "organization_id" = ? AND "deleted_at_ms" IS NULL`,
          )
          .run(validOrgId);
        return { ftsIndexedCount: Number(info.changes) };
      }

      sqlite.prepare('DELETE FROM "customers_fts"').run();
      const info = sqlite
        .prepare(
          `INSERT INTO "customers_fts" ("customer_id", "organization_id", "name_search", "phone_digits")
           SELECT "id", "organization_id", "name_search", COALESCE("phone_digits", '')
           FROM "customers"
           WHERE "deleted_at_ms" IS NULL`,
        )
        .run();
      return { ftsIndexedCount: Number(info.changes) };
    });
  }
}

export function createSqliteCustomerStore(
  options: CreateSqliteCustomerStoreOptions,
): SqliteCustomerStore {
  return new SqliteCustomerStore(options);
}
