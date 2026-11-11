import { createHash } from 'node:crypto';
import {
  type CashDenominationCount,
  type ComputedShiftClosureSummary,
  type DayCloseFiscalStatus,
  DEFAULT_MAX_CASH_DISCREPANCY_TIYIN,
  DEFAULT_STORE_TIMEZONE,
  DomainError,
  type Money,
  type PaymentMethod,
  SALE_PAYMENT_METHODS,
  type SalePaymentMethod,
  type ShiftCashMoveType,
  type ShiftExpenseCategory,
  type ShiftStatus,
  type UnixMs,
  type UserRole,
  USER_ROLES,
  type UuidV7,
  ZERO_MONEY,
  assertOpenShiftAccess,
  assertValidBusinessDate,
  canonicalizeCloseBusinessDayRequest,
  canonicalizeCloseShiftRequest,
  canonicalizeHandoffCashierRequest,
  canonicalizeOpenShiftRequest,
  canonicalizeRecloseShiftRequest,
  canonicalizeShiftCashMoveRequest,
  computeActiveShiftDrawerBalance,
  computeShiftClosureFromAggregates,
  evaluateOpeningDiscrepancy,
  evaluateShiftDiscrepancy,
  formatDayCloseCode,
  formatShiftCode,
  moneyFromTiyin,
  moneyToTiyin,
  negateMoney,
  normalizeMandatoryReason,
  parsePaymentMethod,
  parseSalePaymentMethod,
  parseShiftCashMoveType,
  parseShiftExpenseCategory,
  parseUuidV7,
  unixMsFromBigInt,
  validateDenominationCounts,
  validateNonNegativeShiftCash,
  validatePositiveShiftCash,
} from '@mezon/domain';
import type Database from 'better-sqlite3';
import { and, asc, desc, eq, gte, inArray, isNull, lt } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { type LocalSqliteConnection } from './connection.js';
import { type StoredCashMoveRecord, toStoredCashMove } from './customer-repo.js';
import { advanceShiftSeqSync } from './device-state.js';
import {
  cashMoves,
  dayCloses,
  localHubConfig,
  shiftCashierSessions,
  shiftClosureCashiers,
  shiftClosureMethodTotals,
  shiftClosures,
  shifts,
  users,
} from './schema/index.js';
import { resolveIntlDateKey } from './timezone.js';
import { type SqliteUnitOfWork, runConnectionReadOnly } from './uow.js';
import { insertFact, insertMonotone, updateMonotone } from './writers.js';

export interface ShiftRuntimeContext {
  readonly uow: SqliteUnitOfWork;
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7;
}

export interface CreateSqliteShiftStoreOptions {
  readonly connection: LocalSqliteConnection;
  readonly getRuntimeContext: () => ShiftRuntimeContext | null;
}

export interface ActiveShiftSessionContext {
  readonly shift: typeof shifts.$inferSelect;
  readonly activeSession: typeof shiftCashierSessions.$inferSelect;
}

export interface StoredShiftCashierSessionRecord {
  readonly id: UuidV7;
  readonly shiftId: UuidV7;
  readonly sessionSeq: number;
  readonly cashierUserId: UuidV7;
  readonly status: 'active' | 'closed';
  readonly openingFloat: Money;
  readonly expectedCash: Money | null;
  readonly countedCash: Money | null;
  readonly discrepancy: Money | null;
  readonly discrepancyReason: string | null;
  readonly denominationsJson: string | null;
  readonly overrideApprovedByUserId: UuidV7 | null;
  readonly handedOffByUserId: UuidV7 | null;
  readonly note: string | null;
  readonly startedAtMs: UnixMs;
  readonly endedAtMs: UnixMs | null;
}

export interface StoredShiftRecord {
  readonly id: UuidV7;
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7;
  readonly deviceId: UuidV7;
  readonly shiftNo: bigint;
  readonly shiftCode: string;
  readonly status: ShiftStatus;
  readonly openedByUserId: UuidV7;
  readonly closedByUserId: UuidV7 | null;
  readonly openingCash: Money;
  readonly previousCloseCash: Money | null;
  readonly openingDiscrepancy: Money;
  readonly openingDiscrepancyReason: string | null;
  readonly openingNote: string | null;
  readonly closingNote: string | null;
  readonly openedAtMs: UnixMs;
  readonly closedAtMs: UnixMs | null;
  readonly activeCashierSession: StoredShiftCashierSessionRecord | null;
  readonly cashierSessions: readonly StoredShiftCashierSessionRecord[];
}

export interface StoredShiftClosureMethodTotalRecord {
  readonly method: SalePaymentMethod | 'debt';
  readonly salesAmount: Money;
  readonly returnsAmount: Money;
  readonly netAmount: Money;
}

export interface StoredShiftClosureCashierRecord {
  readonly sessionId: UuidV7;
  readonly cashierUserId: UuidV7;
  readonly cashierUsername: string | null;
  readonly cashierFullName: string | null;
  readonly sessionSeq: number;
  readonly openingFloat: Money;
  readonly expectedCash: Money;
  readonly countedCash: Money;
  readonly discrepancy: Money;
  readonly salesCount: number;
  readonly returnsCount: number;
  readonly salesTotal: Money;
  readonly returnsTotal: Money;
  readonly cashInTotal: Money;
  readonly cashOutTotal: Money;
}

export interface StoredShiftClosureRecord {
  readonly id: UuidV7;
  readonly shiftId: UuidV7;
  readonly closureSeq: number;
  readonly isReclose: boolean;
  readonly reason: string | null;
  readonly closedByUserId: UuidV7;
  readonly overrideApprovedByUserId: UuidV7 | null;
  readonly expectedCash: Money;
  readonly countedCash: Money;
  readonly discrepancy: Money;
  readonly denominationsJson: string | null;
  readonly salesCount: number;
  readonly returnsCount: number;
  readonly voidsCount: number;
  readonly grossSalesTotal: Money;
  readonly returnsTotal: Money;
  readonly netSalesTotal: Money;
  readonly orderAdvanceCashTotal: Money;
  readonly orderAdvanceNonCashTotal: Money;
  readonly orderAdvanceRefundTotal: Money;
  readonly createdAtMs: UnixMs;
  readonly methodTotals: readonly StoredShiftClosureMethodTotalRecord[];
  readonly cashiers: readonly StoredShiftClosureCashierRecord[];
}

export interface StoredDayCloseRecord {
  readonly id: UuidV7;
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7;
  readonly businessDate: string;
  readonly closeSeq: number;
  readonly closeCode: string;
  readonly closedByUserId: UuidV7;
  readonly note: string | null;
  readonly shiftsCount: number;
  readonly salesCount: number;
  readonly returnsCount: number;
  readonly voidsCount: number;
  readonly grossSalesTotal: Money;
  readonly returnsTotal: Money;
  readonly netSalesTotal: Money;
  readonly expectedCashTotal: Money;
  readonly countedCashTotal: Money;
  readonly discrepancyTotal: Money;
  readonly methodTotals: readonly StoredShiftClosureMethodTotalRecord[];
  readonly fiscalStatus: DayCloseFiscalStatus;
  readonly fiscalReportNo: string | null;
  readonly isStale: boolean;
  readonly createdAtMs: UnixMs;
}

export interface CurrentShiftOutcome {
  readonly shift: StoredShiftRecord | null;
  readonly drawerCashBalance: Money;
  readonly maxCashDiscrepancyWithoutOverride: Money;
}

export interface OpenShiftInput {
  readonly actorUserId: UuidV7;
  readonly clientRequestId: UuidV7;
  readonly openingCash: Money;
  readonly denominations?: readonly CashDenominationCount[] | null;
  readonly openingDiscrepancyReason?: string | null;
  readonly note?: string | null;
}

export interface OpenShiftOutcome {
  readonly shift: StoredShiftRecord;
  readonly drawerCashBalance: Money;
  readonly idempotentReplay: boolean;
}

export interface HandoffCashierInput {
  readonly shiftId: UuidV7;
  readonly actorUserId: UuidV7;
  readonly nextCashierUserId: UuidV7;
  readonly clientRequestId: UuidV7;
  readonly countedCash: Money;
  readonly denominations?: readonly CashDenominationCount[] | null;
  readonly discrepancyReason?: string | null;
  readonly overrideApprovedByUserId?: UuidV7 | null;
  readonly note?: string | null;
}

export interface HandoffCashierOutcome {
  readonly shift: StoredShiftRecord;
  readonly closedSession: StoredShiftCashierSessionRecord;
  readonly activeSession: StoredShiftCashierSessionRecord;
  readonly drawerCashBalance: Money;
  readonly idempotentReplay: boolean;
}

export interface CloseShiftInput {
  readonly shiftId: UuidV7;
  readonly actorUserId: UuidV7;
  readonly clientRequestId: UuidV7;
  readonly countedCash: Money;
  readonly denominations?: readonly CashDenominationCount[] | null;
  readonly discrepancyReason?: string | null;
  readonly overrideApprovedByUserId?: UuidV7 | null;
  readonly note?: string | null;
}

export interface RecloseShiftInput {
  readonly shiftId: UuidV7;
  readonly actorUserId: UuidV7;
  readonly clientRequestId: UuidV7;
  readonly countedCash: Money;
  readonly denominations?: readonly CashDenominationCount[] | null;
  readonly reason: string;
  readonly overrideApprovedByUserId?: UuidV7 | null;
}

export interface CloseShiftOutcome {
  readonly shift: StoredShiftRecord;
  readonly closure: StoredShiftClosureRecord;
  readonly drawerCashBalance: Money;
  readonly idempotentReplay: boolean;
}

export interface RecordShiftCashMoveInput {
  readonly shiftId: UuidV7;
  readonly actorUserId: UuidV7;
  readonly clientRequestId: UuidV7;
  readonly type: ShiftCashMoveType;
  readonly amount: Money;
  readonly reason: string;
  readonly expenseCategory?: ShiftExpenseCategory | null;
}

export interface ShiftCashMoveOutcome {
  readonly cashMove: StoredCashMoveRecord;
  readonly drawerCashBalance: Money;
  readonly idempotentReplay: boolean;
}

export interface CloseBusinessDayInput {
  readonly actorUserId: UuidV7;
  readonly clientRequestId: UuidV7;
  readonly businessDate: string;
  readonly note?: string | null;
}

export interface CloseBusinessDayOutcome {
  readonly dayClose: StoredDayCloseRecord;
  readonly idempotentReplay: boolean;
}

export interface ShiftListQueryInput {
  readonly status?: ShiftStatus;
  readonly deviceId?: UuidV7;
  readonly fromDate?: string;
  readonly toDate?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface ShiftListOutcome {
  readonly shifts: readonly StoredShiftRecord[];
  readonly total: number;
}

export interface DayCloseListQueryInput {
  readonly businessDate?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface DayCloseListOutcome {
  readonly dayCloses: readonly StoredDayCloseRecord[];
  readonly total: number;
}

export interface ShiftDetailOutcome {
  readonly shift: StoredShiftRecord;
  readonly closures: readonly StoredShiftClosureRecord[];
  readonly cashMoves: readonly StoredCashMoveRecord[];
}

function sha256Hex(canonical: string): string {
  return createHash('sha256').update(canonical).digest('hex');
}

function parseUserRole(raw: string): UserRole {
  if (!(USER_ROLES as readonly string[]).includes(raw)) {
    throw new DomainError('VALIDATION_ERROR', `Invalid user role "${raw}"`);
  }
  return raw as UserRole;
}

function toBigIntStrict(val: unknown): bigint {
  if (typeof val === 'bigint') {
    return val;
  }
  if (typeof val === 'number' && Number.isSafeInteger(val)) {
    return BigInt(val);
  }
  throw new TypeError(`Expected SQL integer/bigint, got ${typeof val}`);
}

function normalizeOptionalText(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function serializeDenominations(
  denominations: readonly CashDenominationCount[] | null | undefined,
  countedCash: Money,
): string | null {
  const valid = validateDenominationCounts(denominations, countedCash);
  if (valid === null) {
    return null;
  }
  return JSON.stringify(
    valid.map((item) => ({
      nominal: moneyToTiyin(item.nominal).toString(),
      count: item.count,
    })),
  );
}

function readHubShiftConfigSync(
  db: BetterSQLite3Database,
  organizationId: UuidV7,
): { readonly storeTimezone: string; readonly maxCashDiscrepancyWithoutOverride: Money } {
  const row = db
    .select({
      storeTimezone: localHubConfig.storeTimezone,
      maxCashDiscrepancyWithoutOverride: localHubConfig.maxCashDiscrepancyWithoutOverride,
    })
    .from(localHubConfig)
    .where(eq(localHubConfig.organizationId, organizationId))
    .limit(1)
    .all()[0];

  return {
    storeTimezone: row?.storeTimezone ?? DEFAULT_STORE_TIMEZONE,
    maxCashDiscrepancyWithoutOverride:
      row?.maxCashDiscrepancyWithoutOverride ?? moneyFromTiyin(DEFAULT_MAX_CASH_DISCREPANCY_TIYIN),
  };
}

function requireActiveUserSync(
  db: BetterSQLite3Database,
  organizationId: UuidV7,
  userId: UuidV7,
  label = 'User',
): typeof users.$inferSelect {
  const validUserId = parseUuidV7(userId);
  const row = db
    .select()
    .from(users)
    .where(
      and(
        eq(users.id, validUserId),
        eq(users.organizationId, organizationId),
        isNull(users.deletedAtMs),
      ),
    )
    .limit(1)
    .all()[0];
  if (!row || !row.isActive) {
    throw new DomainError('USER_NOT_FOUND', `${label} "${validUserId}" was not found or inactive`);
  }
  return row;
}

function findStartOfDateInTz(businessDate: string, tz: string): UnixMs {
  const validDate = assertValidBusinessDate(businessDate);
  const parts = validDate.split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  const utcMid = BigInt(Date.UTC(y, m - 1, d));
  let lo = utcMid - 18n * 3_600_000n;
  let hi = utcMid + 18n * 3_600_000n;
  while (lo < hi) {
    const mid = lo + (hi - lo) / 2n;
    const key = resolveIntlDateKey(unixMsFromBigInt(mid), tz);
    if (key < validDate) {
      lo = mid + 1n;
    } else {
      hi = mid;
    }
  }
  return unixMsFromBigInt(lo);
}

function getNextBusinessDate(businessDate: string): string {
  const parts = assertValidBusinessDate(businessDate).split('-');
  const dt = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]) + 1));
  const y = dt.getUTCFullYear().toString().padStart(4, '0');
  const m = (dt.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = dt.getUTCDate().toString().padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getBusinessDateBoundsInTz(
  businessDate: string,
  tz: string,
): { readonly startMs: UnixMs; readonly endMs: UnixMs } {
  const startMs = findStartOfDateInTz(businessDate, tz);
  const endMs = findStartOfDateInTz(getNextBusinessDate(businessDate), tz);
  return { startMs, endMs };
}

function toStoredCashierSession(
  row: typeof shiftCashierSessions.$inferSelect,
): StoredShiftCashierSessionRecord {
  return {
    id: row.id,
    shiftId: row.shiftId,
    sessionSeq: row.sessionSeq,
    cashierUserId: row.cashierUserId,
    status: row.status as 'active' | 'closed',
    openingFloat: row.openingFloat,
    expectedCash: row.expectedCash,
    countedCash: row.countedCash,
    discrepancy: row.discrepancy,
    discrepancyReason: row.discrepancyReason,
    denominationsJson: row.denominationsJson,
    overrideApprovedByUserId: row.overrideApprovedByUserId,
    handedOffByUserId: row.handedOffByUserId,
    note: row.note,
    startedAtMs: row.startedAtMs,
    endedAtMs: row.endedAtMs,
  };
}

function toStoredShiftRecord(
  row: typeof shifts.$inferSelect,
  sessions: readonly (typeof shiftCashierSessions.$inferSelect)[],
): StoredShiftRecord {
  const mappedSessions = [...sessions]
    .sort((a, b) => a.sessionSeq - b.sessionSeq)
    .map(toStoredCashierSession);
  const activeCashierSession = mappedSessions.find((s) => s.status === 'active') ?? null;

  return {
    id: row.id,
    organizationId: row.organizationId,
    storeId: row.storeId,
    deviceId: row.deviceId,
    shiftNo: row.shiftNo,
    shiftCode: row.shiftCode,
    status: row.status as ShiftStatus,
    openedByUserId: row.openedByUserId,
    closedByUserId: row.closedByUserId,
    openingCash: row.openingCash,
    previousCloseCash: row.previousCloseCash,
    openingDiscrepancy: row.openingDiscrepancy,
    openingDiscrepancyReason: row.openingDiscrepancyReason,
    openingNote: row.openingNote,
    closingNote: row.closingNote,
    openedAtMs: row.openedAtMs,
    closedAtMs: row.closedAtMs,
    activeCashierSession,
    cashierSessions: mappedSessions,
  };
}

function loadSessionsForShiftsSync(
  db: BetterSQLite3Database,
  shiftIds: readonly UuidV7[],
): Map<UuidV7, (typeof shiftCashierSessions.$inferSelect)[]> {
  const map = new Map<UuidV7, (typeof shiftCashierSessions.$inferSelect)[]>();
  if (shiftIds.length === 0) {
    return map;
  }
  const rows = db
    .select()
    .from(shiftCashierSessions)
    .where(inArray(shiftCashierSessions.shiftId, [...shiftIds]))
    .orderBy(asc(shiftCashierSessions.sessionSeq))
    .all();

  for (const r of rows) {
    const arr = map.get(r.shiftId) ?? [];
    arr.push(r);
    map.set(r.shiftId, arr);
  }
  return map;
}

function loadClosureDetailsSync(
  db: BetterSQLite3Database,
  closureRow: typeof shiftClosures.$inferSelect,
): StoredShiftClosureRecord {
  const methodRows = db
    .select()
    .from(shiftClosureMethodTotals)
    .where(eq(shiftClosureMethodTotals.shiftClosureId, closureRow.id))
    .all();
  const methodByKey = new Map<string, typeof shiftClosureMethodTotals.$inferSelect>();
  for (const m of methodRows) {
    methodByKey.set(m.method, m);
  }
  const orderedMethods: StoredShiftClosureMethodTotalRecord[] = [
    ...SALE_PAYMENT_METHODS,
    'debt' as const,
  ].map((methodKey) => {
    const found = methodByKey.get(methodKey);
    return {
      method: methodKey,
      salesAmount: found?.salesAmount ?? ZERO_MONEY,
      returnsAmount: found?.returnsAmount ?? ZERO_MONEY,
      netAmount: found?.netAmount ?? ZERO_MONEY,
    };
  });

  const cashierRows = db
    .select({
      sessionId: shiftClosureCashiers.sessionId,
      cashierUserId: shiftClosureCashiers.cashierUserId,
      cashierUsername: users.username,
      cashierFullName: users.fullName,
      sessionSeq: shiftClosureCashiers.sessionSeq,
      openingFloat: shiftClosureCashiers.openingFloat,
      expectedCash: shiftClosureCashiers.expectedCash,
      countedCash: shiftClosureCashiers.countedCash,
      discrepancy: shiftClosureCashiers.discrepancy,
      salesCount: shiftClosureCashiers.salesCount,
      returnsCount: shiftClosureCashiers.returnsCount,
      salesTotal: shiftClosureCashiers.salesTotal,
      returnsTotal: shiftClosureCashiers.returnsTotal,
      cashInTotal: shiftClosureCashiers.cashInTotal,
      cashOutTotal: shiftClosureCashiers.cashOutTotal,
    })
    .from(shiftClosureCashiers)
    .leftJoin(users, eq(users.id, shiftClosureCashiers.cashierUserId))
    .where(eq(shiftClosureCashiers.shiftClosureId, closureRow.id))
    .orderBy(asc(shiftClosureCashiers.sessionSeq))
    .all();

  return {
    id: closureRow.id,
    shiftId: closureRow.shiftId,
    closureSeq: closureRow.closureSeq,
    isReclose: Boolean(closureRow.isReclose),
    reason: closureRow.reason,
    closedByUserId: closureRow.closedByUserId,
    overrideApprovedByUserId: closureRow.overrideApprovedByUserId,
    expectedCash: closureRow.expectedCash,
    countedCash: closureRow.countedCash,
    discrepancy: closureRow.discrepancy,
    denominationsJson: closureRow.denominationsJson,
    salesCount: closureRow.salesCount,
    returnsCount: closureRow.returnsCount,
    voidsCount: closureRow.voidsCount,
    grossSalesTotal: closureRow.grossSalesTotal,
    returnsTotal: closureRow.returnsTotal,
    netSalesTotal: closureRow.netSalesTotal,
    orderAdvanceCashTotal: closureRow.orderAdvanceCashTotal,
    orderAdvanceNonCashTotal: closureRow.orderAdvanceNonCashTotal,
    orderAdvanceRefundTotal: closureRow.orderAdvanceRefundTotal,
    createdAtMs: closureRow.createdAtMs,
    methodTotals: orderedMethods,
    cashiers: cashierRows.map((c) => ({
      sessionId: c.sessionId,
      cashierUserId: c.cashierUserId,
      cashierUsername: c.cashierUsername ?? null,
      cashierFullName: c.cashierFullName ?? null,
      sessionSeq: c.sessionSeq,
      openingFloat: c.openingFloat,
      expectedCash: c.expectedCash,
      countedCash: c.countedCash,
      discrepancy: c.discrepancy,
      salesCount: c.salesCount,
      returnsCount: c.returnsCount,
      salesTotal: c.salesTotal,
      returnsTotal: c.returnsTotal,
      cashInTotal: c.cashInTotal,
      cashOutTotal: c.cashOutTotal,
    })),
  };
}

/**
 * Computes closed shifts & their LATEST `shift_closures` belonging to `businessDate`
 * strictly by closing timestamp (`closed_at_ms`) in `storeTimezone` (X4).
 */
function findLatestClosuresForBusinessDateSync(
  db: BetterSQLite3Database,
  params: {
    readonly organizationId: UuidV7;
    readonly storeId: UuidV7;
    readonly businessDate: string;
    readonly storeTimezone: string;
  },
): Array<{
  readonly shift: typeof shifts.$inferSelect;
  readonly closure: typeof shiftClosures.$inferSelect;
}> {
  const { startMs, endMs } = getBusinessDateBoundsInTz(params.businessDate, params.storeTimezone);
  const closedShifts = db
    .select()
    .from(shifts)
    .where(
      and(
        eq(shifts.organizationId, params.organizationId),
        eq(shifts.storeId, params.storeId),
        eq(shifts.status, 'closed'),
        gte(shifts.closedAtMs, startMs),
        lt(shifts.closedAtMs, endMs),
      ),
    )
    .orderBy(asc(shifts.closedAtMs), asc(shifts.id))
    .all();

  if (closedShifts.length === 0) {
    return [];
  }

  const allClosures = db
    .select()
    .from(shiftClosures)
    .where(
      inArray(
        shiftClosures.shiftId,
        closedShifts.map((s) => s.id),
      ),
    )
    .orderBy(desc(shiftClosures.closureSeq))
    .all();

  const latestByShift = new Map<UuidV7, typeof shiftClosures.$inferSelect>();
  for (const c of allClosures) {
    if (!latestByShift.has(c.shiftId)) {
      latestByShift.set(c.shiftId, c);
    }
  }

  const out: Array<{
    readonly shift: typeof shifts.$inferSelect;
    readonly closure: typeof shiftClosures.$inferSelect;
  }> = [];
  for (const sh of closedShifts) {
    const closure = latestByShift.get(sh.id);
    if (closure) {
      out.push({ shift: sh, closure });
    }
  }
  return out;
}

function toStoredDayCloseRecord(
  row: typeof dayCloses.$inferSelect,
  currentLatestClosureIdsSorted: readonly UuidV7[],
): StoredDayCloseRecord {
  const parsedMethods = JSON.parse(row.methodTotalsJson) as ReadonlyArray<{
    readonly method: PaymentMethod | 'debt';
    readonly salesAmount: string;
    readonly returnsAmount: string;
    readonly netAmount: string;
  }>;
  const currentJson = JSON.stringify(currentLatestClosureIdsSorted);
  const isStale = row.includedClosureIdsJson !== currentJson;

  return {
    id: row.id,
    organizationId: row.organizationId,
    storeId: row.storeId,
    businessDate: row.businessDate,
    closeSeq: row.closeSeq,
    closeCode: row.closeCode,
    closedByUserId: row.closedByUserId,
    note: row.note,
    shiftsCount: row.shiftsCount,
    salesCount: row.salesCount,
    returnsCount: row.returnsCount,
    voidsCount: row.voidsCount,
    grossSalesTotal: row.grossSalesTotal,
    returnsTotal: row.returnsTotal,
    netSalesTotal: row.netSalesTotal,
    expectedCashTotal: row.expectedCashTotal,
    countedCashTotal: row.countedCashTotal,
    discrepancyTotal: row.discrepancyTotal,
    methodTotals: parsedMethods.map((m) => ({
      method: m.method === 'debt' ? 'debt' : parseSalePaymentMethod(m.method),
      salesAmount: moneyFromTiyin(BigInt(m.salesAmount)),
      returnsAmount: moneyFromTiyin(BigInt(m.returnsAmount)),
      netAmount: moneyFromTiyin(BigInt(m.netAmount)),
    })),
    fiscalStatus: row.fiscalStatus as DayCloseFiscalStatus,
    fiscalReportNo: row.fiscalReportNo,
    isStale,
    createdAtMs: row.createdAtMs,
  };
}

/**
 * Looks up the currently open shift and active cashier session on `deviceId`.
 */
export function getActiveShiftSessionSync(
  db: BetterSQLite3Database,
  params: {
    readonly organizationId: UuidV7;
    readonly storeId: UuidV7;
    readonly deviceId: UuidV7;
  },
): ActiveShiftSessionContext | null {
  const orgId = parseUuidV7(params.organizationId);
  const storeId = parseUuidV7(params.storeId);
  const deviceId = parseUuidV7(params.deviceId);

  const openShift = db
    .select()
    .from(shifts)
    .where(
      and(
        eq(shifts.organizationId, orgId),
        eq(shifts.storeId, storeId),
        eq(shifts.deviceId, deviceId),
        eq(shifts.status, 'open'),
      ),
    )
    .limit(1)
    .all()[0];

  if (!openShift) {
    return null;
  }

  const activeSession = db
    .select()
    .from(shiftCashierSessions)
    .where(
      and(
        eq(shiftCashierSessions.shiftId, openShift.id),
        eq(shiftCashierSessions.status, 'active'),
      ),
    )
    .limit(1)
    .all()[0];

  if (!activeSession) {
    return null;
  }

  return { shift: openShift, activeSession };
}

/**
 * Enforces an open shift + active cashier session on `deviceId` (X2):
 * - Throws `409 SHIFT_NOT_OPEN` if no shift is open on `deviceId`.
 * - Throws `409 CASHIER_SESSION_MISMATCH` if another cashier holds the active session and
 *   `actorRole` is neither `'owner'` nor `'manager'`.
 */
export function requireOpenShiftSessionSync(
  db: BetterSQLite3Database,
  params: {
    readonly organizationId: UuidV7;
    readonly storeId: UuidV7;
    readonly deviceId: UuidV7;
    readonly actorUserId: UuidV7;
  },
): ActiveShiftSessionContext {
  const ctx = getActiveShiftSessionSync(db, params);
  if (!ctx) {
    throw new DomainError(
      'SHIFT_NOT_OPEN',
      'Terminal does not have an open shift; open a shift first',
    );
  }
  const actor = requireActiveUserSync(db, parseUuidV7(params.organizationId), params.actorUserId);
  const actorRole = parseUserRole(actor.role);
  assertOpenShiftAccess({
    shiftStatus: ctx.shift.status as ShiftStatus,
    activeCashierUserId: ctx.activeSession.cashierUserId,
    actorUserId: actor.id,
    actorRole,
  });
  return ctx;
}

/**
 * X1 single source of truth for physical cash currently available in a terminal drawer:
 * `activeSession.openingFloat + SUM(cash_moves.amount_delta WHERE shift_cashier_session_id = activeSession.id)`.
 *
 * Why session `openingFloat` instead of `shift.openingCash + all cash_moves`:
 * If Cashier A hands off with a cash shortage (e.g. expected 8,573, counted 8,473 -> `-100`),
 * Cashier B physically receives 8,473 (`openingFloat`). Any return/outflow check must enforce
 * physical drawer availability (rejecting 8,474 with `INSUFFICIENT_CASH_IN_DRAWER`), whereas
 * shift-closure `expectedCash` still equals `shift.openingCash + SUM(all cash_moves)` so
 * `D_shift = SUM(D_i)`. Returns `0n` if no shift is currently open on `deviceId`.
 */
export function getActiveShiftDrawerBalanceSync(
  db: BetterSQLite3Database,
  sqlite: Database.Database,
  params: {
    readonly organizationId: UuidV7;
    readonly storeId: UuidV7;
    readonly deviceId: UuidV7;
  },
): Money {
  const ctx = getActiveShiftSessionSync(db, params);
  if (!ctx) {
    return ZERO_MONEY;
  }
  // Accumulate in arbitrary-precision JS bigint so large transient moves (e.g. MAX_MONEY_TIYIN
  // tender + change) cannot trigger SQLite signed int64 SUM() intermediate integer overflow.
  // Session #1 fallback (`shift_cashier_session_id IS NULL`) handles pre-0011 open shifts cleanly.
  const moveStmt = sqlite.prepare<
    [string, string, string, string, number],
    { readonly amount_delta: unknown }
  >(
    `SELECT amount_delta
     FROM cash_moves
     WHERE organization_id = ? AND store_id = ? AND shift_id = ?
       AND (shift_cashier_session_id = ? OR (? = 1 AND shift_cashier_session_id IS NULL))`,
  );
  let deltaSumTiyin = 0n;
  for (const row of moveStmt.iterate(
    ctx.shift.organizationId,
    ctx.shift.storeId,
    ctx.shift.id,
    ctx.activeSession.id,
    ctx.activeSession.sessionSeq,
  )) {
    deltaSumTiyin += toBigIntStrict(row.amount_delta);
  }

  return computeActiveShiftDrawerBalance({
    openingCash: ctx.activeSession.openingFloat,
    cashMovesDeltas: [moneyFromTiyin(deltaSumTiyin)],
  });
}

/**
 * X1 single source of truth for active store-wide physical cash across all currently open
 * terminal shifts (`SUM(getActiveShiftDrawerBalanceSync)` per open terminal in the store).
 */
export function getActiveStoreCashBalanceSync(
  db: BetterSQLite3Database,
  sqlite: Database.Database,
  params: {
    readonly organizationId: UuidV7;
    readonly storeId: UuidV7;
  },
): Money {
  const orgId = parseUuidV7(params.organizationId);
  const storeId = parseUuidV7(params.storeId);

  const openShifts = db
    .select({ deviceId: shifts.deviceId })
    .from(shifts)
    .where(
      and(eq(shifts.organizationId, orgId), eq(shifts.storeId, storeId), eq(shifts.status, 'open')),
    )
    .all();

  if (openShifts.length === 0) {
    return ZERO_MONEY;
  }

  let totalTiyin = 0n;
  for (const sh of openShifts) {
    totalTiyin += moneyToTiyin(
      getActiveShiftDrawerBalanceSync(db, sqlite, {
        organizationId: orgId,
        storeId,
        deviceId: sh.deviceId,
      }),
    );
  }
  return moneyFromTiyin(totalTiyin);
}

/**
 * Aggregates shift receipts, returns, payments & cash_moves using 5 indexed SQLite streaming
 * queries accumulated in arbitrary-precision JS bigint so shifts with >= 1,000 receipts close
 * cleanly in <= 500 ms on disk WAL SQLite without int64 SUM() overflow.
 */
function computeShiftSummaryViaSqlSync(params: {
  readonly db: BetterSQLite3Database;
  readonly sqlite: Database.Database;
  readonly shift: typeof shifts.$inferSelect;
  readonly sessions: readonly (typeof shiftCashierSessions.$inferSelect)[];
  readonly finalCountedCash: Money;
}): ComputedShiftClosureSummary {
  const ordered = [...params.sessions].sort((a, b) => a.sessionSeq - b.sessionSeq);
  if (ordered.length === 0) {
    throw new DomainError('VALIDATION_ERROR', `Shift "${params.shift.id}" has no cashier sessions`);
  }
  const fallbackSid = ordered[0].id;

  const sessionBuckets = new Map<
    UuidV7,
    {
      cashDeltaTiyin: bigint;
      cashInTiyin: bigint;
      cashOutTiyin: bigint;
      salesCount: number;
      salesTotalTiyin: bigint;
      returnsCount: number;
      returnsTotalTiyin: bigint;
    }
  >();
  const ensureBucket = (sid: UuidV7) => {
    let b = sessionBuckets.get(sid);
    if (!b) {
      b = {
        cashDeltaTiyin: 0n,
        cashInTiyin: 0n,
        cashOutTiyin: 0n,
        salesCount: 0,
        salesTotalTiyin: 0n,
        returnsCount: 0,
        returnsTotalTiyin: 0n,
      };
      sessionBuckets.set(sid, b);
    }
    return b;
  };

  // Accumulate all money sums in arbitrary-precision JS bigint via indexed SQLite streams
  // so large intermediate operands cannot overflow SQLite's signed int64 SUM().

  // 1) Cash moves accumulated per session
  const cashMoveStmt = params.sqlite.prepare<
    [string, string, string],
    { readonly shift_cashier_session_id: string | null; readonly amount_delta: unknown }
  >(
    `SELECT shift_cashier_session_id, amount_delta
     FROM cash_moves
     WHERE organization_id = ? AND store_id = ? AND shift_id = ?`,
  );

  let totalCashMovesTiyin = 0n;
  for (const r of cashMoveStmt.iterate(
    params.shift.organizationId,
    params.shift.storeId,
    params.shift.id,
  )) {
    const dt = toBigIntStrict(r.amount_delta);
    totalCashMovesTiyin += dt;
    const sid = r.shift_cashier_session_id ? parseUuidV7(r.shift_cashier_session_id) : fallbackSid;
    const b = ensureBucket(sid);
    b.cashDeltaTiyin += dt;
    if (dt > 0n) {
      b.cashInTiyin += dt;
    } else if (dt < 0n) {
      b.cashOutTiyin += -dt;
    }
  }

  // 2) Sales accumulated per session + voided flag
  const saleStmt = params.sqlite.prepare<
    [string, string, string],
    {
      readonly shift_cashier_session_id: string | null;
      readonly voided_at_ms: unknown;
      readonly total_final: unknown;
      readonly debt_amount: unknown;
    }
  >(
    `SELECT shift_cashier_session_id, voided_at_ms, total_final, debt_amount
     FROM sales
     WHERE organization_id = ? AND store_id = ? AND shift_id = ?`,
  );

  let salesCount = 0;
  let voidsCount = 0;
  let grossSalesTiyin = 0n;
  let debtSalesTiyin = 0n;
  for (const r of saleStmt.iterate(
    params.shift.organizationId,
    params.shift.storeId,
    params.shift.id,
  )) {
    if (r.voided_at_ms !== null) {
      voidsCount += 1;
      continue;
    }
    const amt = toBigIntStrict(r.total_final);
    salesCount += 1;
    grossSalesTiyin += amt;
    debtSalesTiyin += toBigIntStrict(r.debt_amount);
    const sid = r.shift_cashier_session_id ? parseUuidV7(r.shift_cashier_session_id) : fallbackSid;
    const b = ensureBucket(sid);
    b.salesCount += 1;
    b.salesTotalTiyin += amt;
  }

  // 3) Sale payment methods (X3: accumulates p.amount verbatim; never subtracts change twice)
  const salePayStmt = params.sqlite.prepare<
    [string, string, string],
    { readonly method: string; readonly amount: unknown }
  >(
    `SELECT p.method, p.amount
     FROM payments p
     INNER JOIN sales s ON s.id = p.sale_id
     WHERE s.organization_id = ? AND s.store_id = ? AND s.shift_id = ? AND s.voided_at_ms IS NULL`,
  );

  const methodSalesTiyin = new Map<SalePaymentMethod, bigint>();
  for (const r of salePayStmt.iterate(
    params.shift.organizationId,
    params.shift.storeId,
    params.shift.id,
  )) {
    const method = parseSalePaymentMethod(r.method);
    methodSalesTiyin.set(method, (methodSalesTiyin.get(method) ?? 0n) + toBigIntStrict(r.amount));
  }

  // 4) Returns accumulated per session
  const retStmt = params.sqlite.prepare<
    [string, string, string],
    {
      readonly shift_cashier_session_id: string | null;
      readonly total_refund: unknown;
      readonly debt_offset_amount: unknown;
    }
  >(
    `SELECT shift_cashier_session_id, total_refund, debt_offset_amount
     FROM returns
     WHERE organization_id = ? AND store_id = ? AND shift_id = ?`,
  );

  let returnsCount = 0;
  let returnsTiyin = 0n;
  let returnDebtOffsetTiyin = 0n;
  for (const r of retStmt.iterate(
    params.shift.organizationId,
    params.shift.storeId,
    params.shift.id,
  )) {
    const amt = toBigIntStrict(r.total_refund);
    returnsCount += 1;
    returnsTiyin += amt;
    returnDebtOffsetTiyin += toBigIntStrict(r.debt_offset_amount);
    const sid = r.shift_cashier_session_id ? parseUuidV7(r.shift_cashier_session_id) : fallbackSid;
    const b = ensureBucket(sid);
    b.returnsCount += 1;
    b.returnsTotalTiyin += amt;
  }

  // 5) Return payment methods
  const retPayStmt = params.sqlite.prepare<
    [string, string, string],
    { readonly method: string; readonly amount: unknown }
  >(
    `SELECT rp.method, rp.amount
     FROM return_payments rp
     INNER JOIN returns r ON r.id = rp.return_id
     WHERE r.organization_id = ? AND r.store_id = ? AND r.shift_id = ?`,
  );

  const methodReturnsTiyin = new Map<PaymentMethod, bigint>();
  for (const r of retPayStmt.iterate(
    params.shift.organizationId,
    params.shift.storeId,
    params.shift.id,
  )) {
    const method = parsePaymentMethod(r.method);
    methodReturnsTiyin.set(
      method,
      (methodReturnsTiyin.get(method) ?? 0n) + toBigIntStrict(r.amount),
    );
  }

  // 6) Order advances & refunds in this shift (obligation totals; never sales revenue)
  const ordAdvStmt = params.sqlite.prepare<
    [string, string, string],
    { readonly kind: string; readonly method: string; readonly amount: unknown }
  >(
    `SELECT kind, method, amount
     FROM order_payments
     WHERE organization_id = ? AND store_id = ? AND shift_id = ?`,
  );

  let orderAdvanceCashTiyin = 0n;
  let orderAdvanceNonCashTiyin = 0n;
  let orderAdvanceRefundTiyin = 0n;
  for (const r of ordAdvStmt.iterate(
    params.shift.organizationId,
    params.shift.storeId,
    params.shift.id,
  )) {
    const amt = toBigIntStrict(r.amount);
    if (r.kind === 'advance') {
      if (parsePaymentMethod(r.method) === 'cash') {
        orderAdvanceCashTiyin += amt;
      } else {
        orderAdvanceNonCashTiyin += amt;
      }
    } else {
      orderAdvanceRefundTiyin += amt;
    }
  }

  return computeShiftClosureFromAggregates({
    openingCash: params.shift.openingCash,
    finalCountedCash: params.finalCountedCash,
    cashierSessions: ordered.map((s) => ({
      sessionId: s.id,
      cashierUserId: s.cashierUserId,
      sessionSeq: s.sessionSeq,
      openingFloat: s.openingFloat,
      isClosed: s.status === 'closed',
      countedCash: s.countedCash,
    })),
    totalCashMovesTiyin,
    salesCount,
    voidsCount,
    returnsCount,
    grossSalesTiyin,
    returnsTiyin,
    debtSalesTiyin,
    returnDebtOffsetTiyin,
    orderAdvanceCashTiyin,
    orderAdvanceNonCashTiyin,
    orderAdvanceRefundTiyin,
    methodSalesTiyin,
    methodReturnsTiyin,
    sessionBuckets,
  });
}

export class SqliteShiftStore {
  constructor(
    private readonly connection: LocalSqliteConnection,
    private readonly getRuntimeContext: () => ShiftRuntimeContext | null,
  ) {}

  private requireContext(): ShiftRuntimeContext {
    const ctx = this.getRuntimeContext();
    if (!ctx) {
      throw new DomainError(
        'AUTH_UNAUTHORIZED',
        'Hub setup is incomplete; shift store is unavailable',
      );
    }
    return ctx;
  }

  async getCurrentShift(deviceId?: UuidV7): Promise<CurrentShiftOutcome> {
    const ctx = this.requireContext();
    const targetDeviceId = parseUuidV7(deviceId ?? ctx.uow.deviceId);
    return runConnectionReadOnly<CurrentShiftOutcome>(this.connection, () => {
      const hubCfg = readHubShiftConfigSync(this.connection.db, ctx.organizationId);
      const active = getActiveShiftSessionSync(this.connection.db, {
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        deviceId: targetDeviceId,
      });
      if (!active) {
        return Promise.resolve({
          shift: null,
          drawerCashBalance: ZERO_MONEY,
          maxCashDiscrepancyWithoutOverride: hubCfg.maxCashDiscrepancyWithoutOverride,
        });
      }
      const sessions = this.connection.db
        .select()
        .from(shiftCashierSessions)
        .where(eq(shiftCashierSessions.shiftId, active.shift.id))
        .orderBy(asc(shiftCashierSessions.sessionSeq))
        .all();

      const drawerCashBalance = getActiveShiftDrawerBalanceSync(
        this.connection.db,
        this.connection.sqlite,
        {
          organizationId: ctx.organizationId,
          storeId: ctx.storeId,
          deviceId: targetDeviceId,
        },
      );

      return Promise.resolve({
        shift: toStoredShiftRecord(active.shift, sessions),
        drawerCashBalance,
        maxCashDiscrepancyWithoutOverride: hubCfg.maxCashDiscrepancyWithoutOverride,
      });
    });
  }

  async getShiftDetail(shiftId: UuidV7): Promise<ShiftDetailOutcome> {
    const ctx = this.requireContext();
    const validShiftId = parseUuidV7(shiftId);
    return runConnectionReadOnly(this.connection, () => {
      const shiftRow = this.connection.db
        .select()
        .from(shifts)
        .where(
          and(
            eq(shifts.id, validShiftId),
            eq(shifts.organizationId, ctx.organizationId),
            eq(shifts.storeId, ctx.storeId),
          ),
        )
        .limit(1)
        .all()[0];

      if (!shiftRow) {
        throw new DomainError('SHIFT_NOT_FOUND', `Shift "${validShiftId}" was not found`);
      }

      const sessions = this.connection.db
        .select()
        .from(shiftCashierSessions)
        .where(eq(shiftCashierSessions.shiftId, shiftRow.id))
        .orderBy(asc(shiftCashierSessions.sessionSeq))
        .all();

      const closureRows = this.connection.db
        .select()
        .from(shiftClosures)
        .where(eq(shiftClosures.shiftId, shiftRow.id))
        .orderBy(asc(shiftClosures.closureSeq))
        .all();

      const moveRows = this.connection.db
        .select()
        .from(cashMoves)
        .where(
          and(
            eq(cashMoves.organizationId, ctx.organizationId),
            eq(cashMoves.storeId, ctx.storeId),
            eq(cashMoves.shiftId, shiftRow.id),
          ),
        )
        .orderBy(asc(cashMoves.createdAtMs), asc(cashMoves.id))
        .all();

      return Promise.resolve({
        shift: toStoredShiftRecord(shiftRow, sessions),
        closures: closureRows.map((c) => loadClosureDetailsSync(this.connection.db, c)),
        cashMoves: moveRows.map(toStoredCashMove),
      });
    });
  }

  async listShifts(query: ShiftListQueryInput = {}): Promise<ShiftListOutcome> {
    const ctx = this.requireContext();
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const offset = Math.max(query.offset ?? 0, 0);

    return runConnectionReadOnly(this.connection, () => {
      const hubCfg = readHubShiftConfigSync(this.connection.db, ctx.organizationId);
      const conditions = [
        eq(shifts.organizationId, ctx.organizationId),
        eq(shifts.storeId, ctx.storeId),
      ];
      if (query.status !== undefined) {
        conditions.push(eq(shifts.status, query.status));
      }
      if (query.deviceId !== undefined) {
        conditions.push(eq(shifts.deviceId, parseUuidV7(query.deviceId)));
      }
      if (query.fromDate !== undefined) {
        const { startMs } = getBusinessDateBoundsInTz(query.fromDate, hubCfg.storeTimezone);
        conditions.push(gte(shifts.openedAtMs, startMs));
      }
      if (query.toDate !== undefined) {
        const { endMs } = getBusinessDateBoundsInTz(query.toDate, hubCfg.storeTimezone);
        conditions.push(lt(shifts.openedAtMs, endMs));
      }

      const allMatching = this.connection.db
        .select({ id: shifts.id })
        .from(shifts)
        .where(and(...conditions))
        .all();
      const total = allMatching.length;

      const rows = this.connection.db
        .select()
        .from(shifts)
        .where(and(...conditions))
        .orderBy(desc(shifts.openedAtMs), desc(shifts.shiftNo))
        .limit(limit)
        .offset(offset)
        .all();

      const sessByShift = loadSessionsForShiftsSync(
        this.connection.db,
        rows.map((r) => r.id),
      );

      return Promise.resolve({
        shifts: rows.map((r) => toStoredShiftRecord(r, sessByShift.get(r.id) ?? [])),
        total,
      });
    });
  }

  async openShift(input: OpenShiftInput): Promise<OpenShiftOutcome> {
    const ctx = this.requireContext();
    const validActorId = parseUuidV7(input.actorUserId);
    const validReqId = parseUuidV7(input.clientRequestId);
    validateNonNegativeShiftCash(input.openingCash, 'openingCash');
    const openingNote = normalizeOptionalText(input.note);
    const rawOpeningReason = normalizeOptionalText(input.openingDiscrepancyReason);
    const requestHash = sha256Hex(
      canonicalizeOpenShiftRequest({
        cashierUserId: validActorId,
        openingCash: input.openingCash,
        openingDiscrepancyReason: rawOpeningReason,
      }),
    );

    return ctx.uow.execute<OpenShiftOutcome>((session) => {
      const nowMs = session.nowUnixMs();
      const sqlite = session.internalGetSqlite();

      // 1) Idempotency check FIRST
      const existingByReq = session.db
        .select()
        .from(shifts)
        .where(
          and(
            eq(shifts.organizationId, ctx.organizationId),
            eq(shifts.openClientRequestId, validReqId),
          ),
        )
        .limit(1)
        .all()[0];

      if (existingByReq) {
        if (
          existingByReq.storeId !== ctx.storeId ||
          existingByReq.openRequestHash !== requestHash
        ) {
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            `openClientRequestId "${validReqId}" conflicts with another shift payload`,
          );
        }
        const sessions = session.db
          .select()
          .from(shiftCashierSessions)
          .where(eq(shiftCashierSessions.shiftId, existingByReq.id))
          .orderBy(asc(shiftCashierSessions.sessionSeq))
          .all();
        const drawerBalance = getActiveShiftDrawerBalanceSync(session.db, sqlite, {
          organizationId: ctx.organizationId,
          storeId: ctx.storeId,
          deviceId: existingByReq.deviceId,
        });
        return Promise.resolve({
          shift: toStoredShiftRecord(existingByReq, sessions),
          drawerCashBalance: drawerBalance,
          idempotentReplay: true,
        });
      }

      // 2) Actor check & denominations validation
      requireActiveUserSync(session.db, ctx.organizationId, validActorId, 'Cashier');
      serializeDenominations(input.denominations, input.openingCash);

      // 3) Ensure no currently open shift on this terminal
      const alreadyOpen = session.db
        .select({ id: shifts.id })
        .from(shifts)
        .where(
          and(
            eq(shifts.organizationId, ctx.organizationId),
            eq(shifts.storeId, ctx.storeId),
            eq(shifts.deviceId, ctx.uow.deviceId),
            eq(shifts.status, 'open'),
          ),
        )
        .limit(1)
        .all()[0];
      if (alreadyOpen) {
        throw new DomainError(
          'SHIFT_ALREADY_OPEN',
          `Terminal already has an open shift "${alreadyOpen.id}"; close it first`,
        );
      }

      // 4) Opening float continuity vs previous closed shift's LATEST closure
      const prevClosedShift = session.db
        .select()
        .from(shifts)
        .where(
          and(
            eq(shifts.organizationId, ctx.organizationId),
            eq(shifts.storeId, ctx.storeId),
            eq(shifts.deviceId, ctx.uow.deviceId),
            eq(shifts.status, 'closed'),
          ),
        )
        .orderBy(desc(shifts.shiftNo))
        .limit(1)
        .all()[0];

      let prevCloseCash: Money | null = null;
      if (prevClosedShift) {
        const latestPrevClosure = session.db
          .select({ countedCash: shiftClosures.countedCash })
          .from(shiftClosures)
          .where(eq(shiftClosures.shiftId, prevClosedShift.id))
          .orderBy(desc(shiftClosures.closureSeq))
          .limit(1)
          .all()[0];
        prevCloseCash = latestPrevClosure?.countedCash ?? null;
      }

      const openEval = evaluateOpeningDiscrepancy({
        prevShiftCloseCash: prevCloseCash,
        openingCash: input.openingCash,
        reason: rawOpeningReason,
      });

      // 5) Allocate gapless shift_no + insert MONOTONE shift & initial cashier session
      const shiftNo = advanceShiftSeqSync(sqlite, {
        deviceId: ctx.uow.deviceId,
        updatedAtMs: nowMs,
      });
      const shiftCode = formatShiftCode(ctx.uow.deviceId, shiftNo);

      const shiftWrite = insertMonotone(session, shifts, {
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        values: {
          shiftNo,
          shiftCode,
          status: 'open',
          openedByUserId: validActorId,
          closedByUserId: null,
          openingCash: input.openingCash,
          previousCloseCash: prevCloseCash,
          openingDiscrepancy: moneyFromTiyin(openEval.openingDiscrepancyTiyin),
          openingDiscrepancyReason: openEval.normalizedReason,
          openingNote,
          closingNote: null,
          openedAtMs: nowMs,
          closedAtMs: null,
          openClientRequestId: validReqId,
          openRequestHash: requestHash,
          closeClientRequestId: null,
          closeRequestHash: null,
        },
        eventType: 'shift.opened',
        schemaVersion: 1,
      });

      const sessWrite = insertMonotone(session, shiftCashierSessions, {
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        values: {
          shiftId: shiftWrite.entityId,
          sessionSeq: 1,
          cashierUserId: validActorId,
          status: 'active',
          openingFloat: input.openingCash,
          expectedCash: null,
          countedCash: null,
          discrepancy: null,
          discrepancyReason: null,
          denominationsJson: null,
          overrideApprovedByUserId: null,
          handedOffByUserId: null,
          note: openingNote,
          startedAtMs: nowMs,
          endedAtMs: null,
          handoffClientRequestId: null,
          handoffRequestHash: null,
        },
        eventType: 'shift_cashier_session.started',
        schemaVersion: 1,
      });

      return Promise.resolve({
        shift: toStoredShiftRecord(shiftWrite.row, [sessWrite.row]),
        drawerCashBalance: input.openingCash,
        idempotentReplay: false,
      });
    });
  }

  async handoffCashier(input: HandoffCashierInput): Promise<HandoffCashierOutcome> {
    const ctx = this.requireContext();
    const validShiftId = parseUuidV7(input.shiftId);
    const validActorId = parseUuidV7(input.actorUserId);
    const validNextCashierId = parseUuidV7(input.nextCashierUserId);
    const validReqId = parseUuidV7(input.clientRequestId);
    const validOverrideId =
      input.overrideApprovedByUserId !== undefined && input.overrideApprovedByUserId !== null
        ? parseUuidV7(input.overrideApprovedByUserId)
        : null;
    validateNonNegativeShiftCash(input.countedCash, 'countedCash');
    const cleanReason = normalizeOptionalText(input.discrepancyReason);
    const cleanNote = normalizeOptionalText(input.note);

    const requestHash = sha256Hex(
      canonicalizeHandoffCashierRequest({
        shiftId: validShiftId,
        countedCash: input.countedCash,
        nextCashierUserId: validNextCashierId,
        reason: cleanReason,
      }),
    );

    return ctx.uow.execute<HandoffCashierOutcome>((session) => {
      const nowMs = session.nowUnixMs();
      const sqlite = session.internalGetSqlite();

      // 1) Idempotency check FIRST
      const existingClosedSession = session.db
        .select()
        .from(shiftCashierSessions)
        .where(
          and(
            eq(shiftCashierSessions.organizationId, ctx.organizationId),
            eq(shiftCashierSessions.handoffClientRequestId, validReqId),
          ),
        )
        .limit(1)
        .all()[0];

      if (existingClosedSession) {
        if (
          existingClosedSession.shiftId !== validShiftId ||
          existingClosedSession.handoffRequestHash !== requestHash
        ) {
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            `clientRequestId "${validReqId}" conflicts with another handoff payload`,
          );
        }
        const shiftRow = session.db
          .select()
          .from(shifts)
          .where(eq(shifts.id, validShiftId))
          .limit(1)
          .get();
        if (!shiftRow) {
          throw new DomainError('SHIFT_NOT_FOUND', `Shift "${validShiftId}" not found`);
        }
        const allSessions = session.db
          .select()
          .from(shiftCashierSessions)
          .where(eq(shiftCashierSessions.shiftId, validShiftId))
          .orderBy(asc(shiftCashierSessions.sessionSeq))
          .all();
        const nextSessRow =
          allSessions.find((s) => s.sessionSeq === existingClosedSession.sessionSeq + 1) ??
          allSessions[allSessions.length - 1];
        const drawerBalance = getActiveShiftDrawerBalanceSync(session.db, sqlite, {
          organizationId: ctx.organizationId,
          storeId: ctx.storeId,
          deviceId: shiftRow.deviceId,
        });
        return Promise.resolve({
          shift: toStoredShiftRecord(shiftRow, allSessions),
          closedSession: toStoredCashierSession(existingClosedSession),
          activeSession: toStoredCashierSession(nextSessRow),
          drawerCashBalance: drawerBalance,
          idempotentReplay: true,
        });
      }

      // 2) Load shift & verify status + access
      const shiftRow = session.db
        .select()
        .from(shifts)
        .where(
          and(
            eq(shifts.id, validShiftId),
            eq(shifts.organizationId, ctx.organizationId),
            eq(shifts.storeId, ctx.storeId),
          ),
        )
        .limit(1)
        .all()[0];
      if (!shiftRow) {
        throw new DomainError('SHIFT_NOT_FOUND', `Shift "${validShiftId}" was not found`);
      }
      if (shiftRow.status !== 'open') {
        throw new DomainError('SHIFT_NOT_OPEN', `Shift "${validShiftId}" is already closed`);
      }

      const actor = requireActiveUserSync(session.db, ctx.organizationId, validActorId);
      requireActiveUserSync(session.db, ctx.organizationId, validNextCashierId, 'Next cashier');

      const allSessions = session.db
        .select()
        .from(shiftCashierSessions)
        .where(eq(shiftCashierSessions.shiftId, shiftRow.id))
        .orderBy(asc(shiftCashierSessions.sessionSeq))
        .all();
      const activeSess = allSessions.find((s) => s.status === 'active');
      if (!activeSess) {
        throw new DomainError('SHIFT_NOT_OPEN', `Shift "${shiftRow.id}" has no active session`);
      }

      assertOpenShiftAccess({
        shiftStatus: 'open',
        activeCashierUserId: activeSess.cashierUserId,
        actorUserId: actor.id,
        actorRole: parseUserRole(actor.role),
      });

      const denominationsJson = serializeDenominations(input.denominations, input.countedCash);

      // 3) Compute expected cash for this active session in arbitrary-precision JS bigint
      const sessCashStmt = sqlite.prepare<
        [string, string, string, string, number],
        { readonly amount_delta: unknown }
      >(
        `SELECT amount_delta
         FROM cash_moves
         WHERE organization_id = ? AND store_id = ? AND shift_id = ?
           AND (shift_cashier_session_id = ? OR (? = 1 AND shift_cashier_session_id IS NULL))`,
      );
      let sessDeltaTiyin = 0n;
      for (const row of sessCashStmt.iterate(
        ctx.organizationId,
        ctx.storeId,
        shiftRow.id,
        activeSess.id,
        activeSess.sessionSeq,
      )) {
        sessDeltaTiyin += toBigIntStrict(row.amount_delta);
      }
      const expectedCash = moneyFromTiyin(moneyToTiyin(activeSess.openingFloat) + sessDeltaTiyin);

      const hubCfg = readHubShiftConfigSync(session.db, ctx.organizationId);
      const discEval = evaluateShiftDiscrepancy({
        expectedCash,
        countedCash: input.countedCash,
        maxCashDiscrepancyWithoutOverride: hubCfg.maxCashDiscrepancyWithoutOverride,
        reason: cleanReason,
        supervisorApprovedByUserId: validOverrideId,
      });

      // 4) Close active session + open next cashier session in SAME transaction
      const closedWrite = updateMonotone(session, shiftCashierSessions, {
        id: activeSess.id,
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        values: {
          status: 'closed',
          expectedCash,
          countedCash: input.countedCash,
          discrepancy: moneyFromTiyin(discEval.discrepancyTiyin),
          discrepancyReason: discEval.normalizedReason,
          denominationsJson,
          overrideApprovedByUserId: validOverrideId,
          handedOffByUserId: validActorId,
          note: cleanNote,
          endedAtMs: nowMs,
          handoffClientRequestId: validReqId,
          handoffRequestHash: requestHash,
        },
        eventType: 'shift_cashier_session.closed',
        schemaVersion: 1,
      });

      const nextSessWrite = insertMonotone(session, shiftCashierSessions, {
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        values: {
          shiftId: shiftRow.id,
          sessionSeq: activeSess.sessionSeq + 1,
          cashierUserId: validNextCashierId,
          status: 'active',
          openingFloat: input.countedCash,
          expectedCash: null,
          countedCash: null,
          discrepancy: null,
          discrepancyReason: null,
          denominationsJson: null,
          overrideApprovedByUserId: null,
          handedOffByUserId: null,
          note: cleanNote,
          startedAtMs: nowMs,
          endedAtMs: null,
          handoffClientRequestId: null,
          handoffRequestHash: null,
        },
        eventType: 'shift_cashier_session.started',
        schemaVersion: 1,
      });

      const updatedSessions = [
        ...allSessions.filter((s) => s.id !== activeSess.id),
        closedWrite.row,
        nextSessWrite.row,
      ];
      const drawerBalance = getActiveShiftDrawerBalanceSync(session.db, sqlite, {
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        deviceId: shiftRow.deviceId,
      });

      return Promise.resolve({
        shift: toStoredShiftRecord(shiftRow, updatedSessions),
        closedSession: toStoredCashierSession(closedWrite.row),
        activeSession: toStoredCashierSession(nextSessWrite.row),
        drawerCashBalance: drawerBalance,
        idempotentReplay: false,
      });
    });
  }

  async closeShift(input: CloseShiftInput): Promise<CloseShiftOutcome> {
    const ctx = this.requireContext();
    const validShiftId = parseUuidV7(input.shiftId);
    const validActorId = parseUuidV7(input.actorUserId);
    const validReqId = parseUuidV7(input.clientRequestId);
    const validOverrideId =
      input.overrideApprovedByUserId !== undefined && input.overrideApprovedByUserId !== null
        ? parseUuidV7(input.overrideApprovedByUserId)
        : null;
    validateNonNegativeShiftCash(input.countedCash, 'countedCash');
    const cleanReason = normalizeOptionalText(input.discrepancyReason);
    const closingNote = normalizeOptionalText(input.note);

    const requestHash = sha256Hex(
      canonicalizeCloseShiftRequest({
        shiftId: validShiftId,
        countedCash: input.countedCash,
        reason: cleanReason,
      }),
    );

    return ctx.uow.execute<CloseShiftOutcome>((session) => {
      const nowMs = session.nowUnixMs();
      const sqlite = session.internalGetSqlite();

      // 1) Idempotency check FIRST
      const existingClosure = session.db
        .select()
        .from(shiftClosures)
        .where(
          and(
            eq(shiftClosures.organizationId, ctx.organizationId),
            eq(shiftClosures.clientRequestId, validReqId),
          ),
        )
        .limit(1)
        .all()[0];

      if (existingClosure) {
        if (
          existingClosure.shiftId !== validShiftId ||
          existingClosure.isReclose ||
          existingClosure.requestHash !== requestHash
        ) {
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            `clientRequestId "${validReqId}" conflicts with another shift close payload`,
          );
        }
        const shiftRow = session.db
          .select()
          .from(shifts)
          .where(eq(shifts.id, validShiftId))
          .limit(1)
          .get();
        if (!shiftRow) {
          throw new DomainError('SHIFT_NOT_FOUND', `Shift "${validShiftId}" not found`);
        }
        const allSessions = session.db
          .select()
          .from(shiftCashierSessions)
          .where(eq(shiftCashierSessions.shiftId, validShiftId))
          .orderBy(asc(shiftCashierSessions.sessionSeq))
          .all();
        return Promise.resolve({
          shift: toStoredShiftRecord(shiftRow, allSessions),
          closure: loadClosureDetailsSync(session.db, existingClosure),
          drawerCashBalance: ZERO_MONEY,
          idempotentReplay: true,
        });
      }

      // 2) Load shift + check open status & actor permission
      const shiftRow = session.db
        .select()
        .from(shifts)
        .where(
          and(
            eq(shifts.id, validShiftId),
            eq(shifts.organizationId, ctx.organizationId),
            eq(shifts.storeId, ctx.storeId),
          ),
        )
        .limit(1)
        .all()[0];
      if (!shiftRow) {
        throw new DomainError('SHIFT_NOT_FOUND', `Shift "${validShiftId}" was not found`);
      }
      if (shiftRow.status !== 'open') {
        throw new DomainError('SHIFT_ALREADY_CLOSED', `Shift "${validShiftId}" is already closed`);
      }

      const actor = requireActiveUserSync(session.db, ctx.organizationId, validActorId);
      const allSessions = session.db
        .select()
        .from(shiftCashierSessions)
        .where(eq(shiftCashierSessions.shiftId, shiftRow.id))
        .orderBy(asc(shiftCashierSessions.sessionSeq))
        .all();
      const activeSess = allSessions.find((s) => s.status === 'active');
      if (!activeSess) {
        throw new DomainError('SHIFT_NOT_OPEN', `Shift "${shiftRow.id}" has no active session`);
      }
      assertOpenShiftAccess({
        shiftStatus: 'open',
        activeCashierUserId: activeSess.cashierUserId,
        actorUserId: actor.id,
        actorRole: parseUserRole(actor.role),
      });

      const denominationsJson = serializeDenominations(input.denominations, input.countedCash);

      // 3) Compute exact shift totals via indexed SQL GROUP BY (<= 10ms for 1,000+ receipts)
      const summary = computeShiftSummaryViaSqlSync({
        db: session.db,
        sqlite,
        shift: shiftRow,
        sessions: allSessions,
        finalCountedCash: input.countedCash,
      });

      const hubCfg = readHubShiftConfigSync(session.db, ctx.organizationId);
      const discEval = evaluateShiftDiscrepancy({
        expectedCash: summary.expectedCash,
        countedCash: input.countedCash,
        maxCashDiscrepancyWithoutOverride: hubCfg.maxCashDiscrepancyWithoutOverride,
        reason: cleanReason,
        supervisorApprovedByUserId: validOverrideId,
      });

      const lastSessionSummary = summary.cashiers[summary.cashiers.length - 1];

      // 4) Close active cashier session + close shift + append closure FACTs in ONE transaction
      const closedSessWrite = updateMonotone(session, shiftCashierSessions, {
        id: activeSess.id,
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        values: {
          status: 'closed',
          expectedCash: lastSessionSummary.expectedCash,
          countedCash: input.countedCash,
          discrepancy: moneyFromTiyin(lastSessionSummary.discrepancyTiyin),
          discrepancyReason: discEval.normalizedReason,
          denominationsJson,
          overrideApprovedByUserId: validOverrideId,
          endedAtMs: nowMs,
        },
        eventType: 'shift_cashier_session.closed',
        schemaVersion: 1,
      });

      const closedShiftWrite = updateMonotone(session, shifts, {
        id: shiftRow.id,
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        values: {
          status: 'closed',
          closedByUserId: validActorId,
          closingNote,
          closedAtMs: nowMs,
          closeClientRequestId: validReqId,
          closeRequestHash: requestHash,
        },
        eventType: 'shift.closed',
        schemaVersion: 1,
      });

      const closureWrite = insertFact(session, shiftClosures, {
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        values: {
          shiftId: shiftRow.id,
          closureSeq: 1,
          isReclose: false,
          reason: discEval.normalizedReason,
          closedByUserId: validActorId,
          overrideApprovedByUserId: validOverrideId,
          clientRequestId: validReqId,
          requestHash,
          expectedCash: summary.expectedCash,
          countedCash: summary.countedCash,
          discrepancy: moneyFromTiyin(summary.discrepancyTiyin),
          denominationsJson,
          salesCount: summary.salesCount,
          returnsCount: summary.returnsCount,
          voidsCount: summary.voidsCount,
          grossSalesTotal: summary.grossSalesTotal,
          returnsTotal: summary.returnsTotal,
          netSalesTotal: summary.netSalesTotal,
          orderAdvanceCashTotal: summary.orderAdvanceCashTotal,
          orderAdvanceNonCashTotal: summary.orderAdvanceNonCashTotal,
          orderAdvanceRefundTotal: summary.orderAdvanceRefundTotal,
        },
        eventType: 'shift_closure.created',
        schemaVersion: 1,
      });

      for (const m of summary.methodTotals) {
        insertFact(session, shiftClosureMethodTotals, {
          organizationId: ctx.organizationId,
          storeId: ctx.storeId,
          values: {
            shiftClosureId: closureWrite.entityId,
            method: m.method,
            salesAmount: m.salesAmount,
            returnsAmount: m.returnsAmount,
            netAmount: m.netAmount,
          },
          eventType: 'shift_closure_method.created',
          schemaVersion: 1,
        });
      }

      for (const c of summary.cashiers) {
        insertFact(session, shiftClosureCashiers, {
          organizationId: ctx.organizationId,
          storeId: ctx.storeId,
          values: {
            shiftClosureId: closureWrite.entityId,
            sessionId: c.sessionId,
            cashierUserId: c.cashierUserId,
            sessionSeq: c.sessionSeq,
            openingFloat: c.openingFloat,
            expectedCash: c.expectedCash,
            countedCash: c.countedCash,
            discrepancy: moneyFromTiyin(c.discrepancyTiyin),
            salesCount: c.salesCount,
            returnsCount: c.returnsCount,
            salesTotal: c.salesTotal,
            returnsTotal: c.returnsTotal,
            cashInTotal: c.cashInTotal,
            cashOutTotal: c.cashOutTotal,
          },
          eventType: 'shift_closure_cashier.created',
          schemaVersion: 1,
        });
      }

      const updatedSessions = [
        ...allSessions.filter((s) => s.id !== activeSess.id),
        closedSessWrite.row,
      ];

      return Promise.resolve({
        shift: toStoredShiftRecord(closedShiftWrite.row, updatedSessions),
        closure: loadClosureDetailsSync(session.db, closureWrite.row),
        drawerCashBalance: ZERO_MONEY,
        idempotentReplay: false,
      });
    });
  }

  async recloseShift(input: RecloseShiftInput): Promise<CloseShiftOutcome> {
    const ctx = this.requireContext();
    const validShiftId = parseUuidV7(input.shiftId);
    const validActorId = parseUuidV7(input.actorUserId);
    const validReqId = parseUuidV7(input.clientRequestId);
    const validOverrideId =
      input.overrideApprovedByUserId !== undefined && input.overrideApprovedByUserId !== null
        ? parseUuidV7(input.overrideApprovedByUserId)
        : null;
    validateNonNegativeShiftCash(input.countedCash, 'countedCash');
    const cleanReason = normalizeMandatoryReason(input.reason);

    const requestHash = sha256Hex(
      canonicalizeRecloseShiftRequest({
        shiftId: validShiftId,
        countedCash: input.countedCash,
        reason: cleanReason,
      }),
    );

    return ctx.uow.execute<CloseShiftOutcome>((session) => {
      const sqlite = session.internalGetSqlite();

      // 1) Idempotency check FIRST
      const existingClosure = session.db
        .select()
        .from(shiftClosures)
        .where(
          and(
            eq(shiftClosures.organizationId, ctx.organizationId),
            eq(shiftClosures.clientRequestId, validReqId),
          ),
        )
        .limit(1)
        .all()[0];

      if (existingClosure) {
        if (
          existingClosure.shiftId !== validShiftId ||
          !existingClosure.isReclose ||
          existingClosure.requestHash !== requestHash
        ) {
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            `clientRequestId "${validReqId}" conflicts with another shift reclose payload`,
          );
        }
        const shiftRow = session.db
          .select()
          .from(shifts)
          .where(eq(shifts.id, validShiftId))
          .limit(1)
          .get();
        if (!shiftRow) {
          throw new DomainError('SHIFT_NOT_FOUND', `Shift "${validShiftId}" not found`);
        }
        const allSessions = session.db
          .select()
          .from(shiftCashierSessions)
          .where(eq(shiftCashierSessions.shiftId, validShiftId))
          .orderBy(asc(shiftCashierSessions.sessionSeq))
          .all();
        return Promise.resolve({
          shift: toStoredShiftRecord(shiftRow, allSessions),
          closure: loadClosureDetailsSync(session.db, existingClosure),
          drawerCashBalance: ZERO_MONEY,
          idempotentReplay: true,
        });
      }

      // 2) Verify shift is closed + actor authorized
      const shiftRow = session.db
        .select()
        .from(shifts)
        .where(
          and(
            eq(shifts.id, validShiftId),
            eq(shifts.organizationId, ctx.organizationId),
            eq(shifts.storeId, ctx.storeId),
          ),
        )
        .limit(1)
        .all()[0];
      if (!shiftRow) {
        throw new DomainError('SHIFT_NOT_FOUND', `Shift "${validShiftId}" was not found`);
      }
      if (shiftRow.status !== 'closed') {
        throw new DomainError(
          'SHIFT_NOT_CLOSED',
          `Shift "${validShiftId}" is open; close it before reclosing`,
        );
      }

      const actor = requireActiveUserSync(session.db, ctx.organizationId, validActorId);
      const role = parseUserRole(actor.role);
      if (role !== 'owner' && role !== 'manager') {
        throw new DomainError('AUTH_FORBIDDEN', 'Only owner or manager may reclose a closed shift');
      }

      const denominationsJson = serializeDenominations(input.denominations, input.countedCash);
      const allSessions = session.db
        .select()
        .from(shiftCashierSessions)
        .where(eq(shiftCashierSessions.shiftId, shiftRow.id))
        .orderBy(asc(shiftCashierSessions.sessionSeq))
        .all();

      const latestClosure = session.db
        .select({ closureSeq: shiftClosures.closureSeq })
        .from(shiftClosures)
        .where(eq(shiftClosures.shiftId, shiftRow.id))
        .orderBy(desc(shiftClosures.closureSeq))
        .limit(1)
        .all()[0];
      const nextClosureSeq = (latestClosure?.closureSeq ?? 0) + 1;

      const summary = computeShiftSummaryViaSqlSync({
        db: session.db,
        sqlite,
        shift: shiftRow,
        sessions: allSessions,
        finalCountedCash: input.countedCash,
      });

      const hubCfg = readHubShiftConfigSync(session.db, ctx.organizationId);
      evaluateShiftDiscrepancy({
        expectedCash: summary.expectedCash,
        countedCash: input.countedCash,
        maxCashDiscrepancyWithoutOverride: hubCfg.maxCashDiscrepancyWithoutOverride,
        reason: cleanReason,
        supervisorApprovedByUserId: validOverrideId,
      });

      // Append-only FACT closure row: history preserved cleanly, X4 dayCloses detect staleness dynamically
      const closureWrite = insertFact(session, shiftClosures, {
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        values: {
          shiftId: shiftRow.id,
          closureSeq: nextClosureSeq,
          isReclose: true,
          reason: cleanReason,
          closedByUserId: validActorId,
          overrideApprovedByUserId: validOverrideId,
          clientRequestId: validReqId,
          requestHash,
          expectedCash: summary.expectedCash,
          countedCash: summary.countedCash,
          discrepancy: moneyFromTiyin(summary.discrepancyTiyin),
          denominationsJson,
          salesCount: summary.salesCount,
          returnsCount: summary.returnsCount,
          voidsCount: summary.voidsCount,
          grossSalesTotal: summary.grossSalesTotal,
          returnsTotal: summary.returnsTotal,
          netSalesTotal: summary.netSalesTotal,
          orderAdvanceCashTotal: summary.orderAdvanceCashTotal,
          orderAdvanceNonCashTotal: summary.orderAdvanceNonCashTotal,
          orderAdvanceRefundTotal: summary.orderAdvanceRefundTotal,
        },
        eventType: 'shift_closure.reclosed',
        schemaVersion: 1,
      });

      for (const m of summary.methodTotals) {
        insertFact(session, shiftClosureMethodTotals, {
          organizationId: ctx.organizationId,
          storeId: ctx.storeId,
          values: {
            shiftClosureId: closureWrite.entityId,
            method: m.method,
            salesAmount: m.salesAmount,
            returnsAmount: m.returnsAmount,
            netAmount: m.netAmount,
          },
          eventType: 'shift_closure_method.created',
          schemaVersion: 1,
        });
      }

      for (const c of summary.cashiers) {
        insertFact(session, shiftClosureCashiers, {
          organizationId: ctx.organizationId,
          storeId: ctx.storeId,
          values: {
            shiftClosureId: closureWrite.entityId,
            sessionId: c.sessionId,
            cashierUserId: c.cashierUserId,
            sessionSeq: c.sessionSeq,
            openingFloat: c.openingFloat,
            expectedCash: c.expectedCash,
            countedCash: c.countedCash,
            discrepancy: moneyFromTiyin(c.discrepancyTiyin),
            salesCount: c.salesCount,
            returnsCount: c.returnsCount,
            salesTotal: c.salesTotal,
            returnsTotal: c.returnsTotal,
            cashInTotal: c.cashInTotal,
            cashOutTotal: c.cashOutTotal,
          },
          eventType: 'shift_closure_cashier.created',
          schemaVersion: 1,
        });
      }

      return Promise.resolve({
        shift: toStoredShiftRecord(shiftRow, allSessions),
        closure: loadClosureDetailsSync(session.db, closureWrite.row),
        drawerCashBalance: ZERO_MONEY,
        idempotentReplay: false,
      });
    });
  }

  async recordShiftCashMove(input: RecordShiftCashMoveInput): Promise<ShiftCashMoveOutcome> {
    const ctx = this.requireContext();
    const validShiftId = parseUuidV7(input.shiftId);
    const validActorId = parseUuidV7(input.actorUserId);
    const validReqId = parseUuidV7(input.clientRequestId);
    const moveType = parseShiftCashMoveType(input.type);
    const amount = validatePositiveShiftCash(input.amount, 'amount');
    const expenseCategory = parseShiftExpenseCategory(moveType, input.expenseCategory);
    const cleanReason = normalizeMandatoryReason(input.reason);
    const expectedDelta = moveType === 'cash_in' ? amount : negateMoney(amount);

    // Verify canonical hash matches for idempotent replay
    const requestHash = sha256Hex(
      canonicalizeShiftCashMoveRequest({
        shiftId: validShiftId,
        type: moveType,
        amount,
        expenseCategory,
        reason: cleanReason,
      }),
    );

    return ctx.uow.execute<ShiftCashMoveOutcome>((session) => {
      const sqlite = session.internalGetSqlite();

      // 1) Idempotency check FIRST (sourceType='shift_cash_move', sourceId=clientRequestId)
      const existingMove = session.db
        .select()
        .from(cashMoves)
        .where(
          and(
            eq(cashMoves.organizationId, ctx.organizationId),
            eq(cashMoves.storeId, ctx.storeId),
            eq(cashMoves.sourceType, 'shift_cash_move'),
            eq(cashMoves.sourceId, validReqId),
          ),
        )
        .limit(1)
        .all()[0];

      if (existingMove) {
        const existingHash = sha256Hex(
          canonicalizeShiftCashMoveRequest({
            shiftId: existingMove.shiftId ?? validShiftId,
            type: parseShiftCashMoveType(existingMove.type),
            amount: moneyFromTiyin(
              moneyToTiyin(existingMove.amountDelta) >= 0n
                ? moneyToTiyin(existingMove.amountDelta)
                : -moneyToTiyin(existingMove.amountDelta),
            ),
            expenseCategory: (existingMove.expenseCategory as ShiftExpenseCategory | null) ?? null,
            reason: existingMove.reason ?? '',
          }),
        );
        if (existingMove.shiftId !== validShiftId || existingHash !== requestHash) {
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            `clientRequestId "${validReqId}" conflicts with another cash move payload`,
          );
        }
        const shRow = session.db
          .select({ deviceId: shifts.deviceId })
          .from(shifts)
          .where(eq(shifts.id, validShiftId))
          .limit(1)
          .all()[0];
        const drawerBalance = shRow
          ? getActiveShiftDrawerBalanceSync(session.db, sqlite, {
              organizationId: ctx.organizationId,
              storeId: ctx.storeId,
              deviceId: shRow.deviceId,
            })
          : ZERO_MONEY;
        return Promise.resolve({
          cashMove: toStoredCashMove(existingMove),
          drawerCashBalance: drawerBalance,
          idempotentReplay: true,
        });
      }

      // 2) Load shift + check open status & actor
      const shiftRow = session.db
        .select()
        .from(shifts)
        .where(
          and(
            eq(shifts.id, validShiftId),
            eq(shifts.organizationId, ctx.organizationId),
            eq(shifts.storeId, ctx.storeId),
          ),
        )
        .limit(1)
        .all()[0];
      if (!shiftRow) {
        throw new DomainError('SHIFT_NOT_FOUND', `Shift "${validShiftId}" was not found`);
      }
      if (shiftRow.status !== 'open') {
        throw new DomainError('SHIFT_NOT_OPEN', `Shift "${validShiftId}" is already closed`);
      }

      const actor = requireActiveUserSync(session.db, ctx.organizationId, validActorId);
      const activeSess = session.db
        .select()
        .from(shiftCashierSessions)
        .where(
          and(
            eq(shiftCashierSessions.shiftId, shiftRow.id),
            eq(shiftCashierSessions.status, 'active'),
          ),
        )
        .limit(1)
        .all()[0];
      if (!activeSess) {
        throw new DomainError('SHIFT_NOT_OPEN', `Shift "${shiftRow.id}" has no active session`);
      }

      assertOpenShiftAccess({
        shiftStatus: 'open',
        activeCashierUserId: activeSess.cashierUserId,
        actorUserId: actor.id,
        actorRole: parseUserRole(actor.role),
      });

      // 3) X1 cash sufficiency on outflows using open shift's drawer balance
      if (moveType !== 'cash_in') {
        const drawerBalance = getActiveShiftDrawerBalanceSync(session.db, sqlite, {
          organizationId: ctx.organizationId,
          storeId: ctx.storeId,
          deviceId: shiftRow.deviceId,
        });
        if (moneyToTiyin(drawerBalance) < moneyToTiyin(amount)) {
          throw new DomainError(
            'INSUFFICIENT_CASH_IN_DRAWER',
            `Shift drawer cash balance (${moneyToTiyin(drawerBalance).toString()} tiyin) is insufficient for ${moveType} (${moneyToTiyin(amount).toString()} tiyin)`,
            {
              details: {
                drawerBalance: moneyToTiyin(drawerBalance).toString(),
                requiredAmount: moneyToTiyin(amount).toString(),
              },
            },
          );
        }
      }

      // 4) Insert FACT cash_move stamped with shiftId + active shiftCashierSessionId (X2)
      const write = insertFact(session, cashMoves, {
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        values: {
          shiftId: shiftRow.id,
          shiftCashierSessionId: activeSess.id,
          type: moveType,
          amountDelta: expectedDelta,
          sourceType: 'shift_cash_move',
          sourceId: validReqId,
          paymentId: null,
          expenseCategory,
          reason: cleanReason,
          createdByUserId: validActorId,
        },
        eventType: 'cash_move.created',
        schemaVersion: 1,
      });

      const updatedDrawerBalance = getActiveShiftDrawerBalanceSync(session.db, sqlite, {
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        deviceId: shiftRow.deviceId,
      });

      return Promise.resolve({
        cashMove: toStoredCashMove(write.row),
        drawerCashBalance: updatedDrawerBalance,
        idempotentReplay: false,
      });
    });
  }

  async closeBusinessDay(input: CloseBusinessDayInput): Promise<CloseBusinessDayOutcome> {
    const ctx = this.requireContext();
    const validActorId = parseUuidV7(input.actorUserId);
    const validReqId = parseUuidV7(input.clientRequestId);
    const businessDate = assertValidBusinessDate(input.businessDate);
    const note = normalizeOptionalText(input.note);

    return ctx.uow.execute<CloseBusinessDayOutcome>((session) => {
      const hubCfg = readHubShiftConfigSync(session.db, ctx.organizationId);
      const requestHash = sha256Hex(
        canonicalizeCloseBusinessDayRequest({
          businessDate,
          reason: note,
          storeTimezone: hubCfg.storeTimezone,
        }),
      );

      // 1) Idempotency check FIRST
      const existingByReq = session.db
        .select()
        .from(dayCloses)
        .where(
          and(
            eq(dayCloses.organizationId, ctx.organizationId),
            eq(dayCloses.clientRequestId, validReqId),
          ),
        )
        .limit(1)
        .all()[0];

      if (existingByReq) {
        if (existingByReq.storeId !== ctx.storeId || existingByReq.requestHash !== requestHash) {
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            `clientRequestId "${validReqId}" conflicts with another day-close payload`,
          );
        }
        const liveClosures = findLatestClosuresForBusinessDateSync(session.db, {
          organizationId: ctx.organizationId,
          storeId: ctx.storeId,
          businessDate: existingByReq.businessDate,
          storeTimezone: hubCfg.storeTimezone,
        });
        const liveIdsSorted = liveClosures.map((x) => x.closure.id).sort();
        return Promise.resolve({
          dayClose: toStoredDayCloseRecord(existingByReq, liveIdsSorted),
          idempotentReplay: true,
        });
      }

      requireActiveUserSync(session.db, ctx.organizationId, validActorId);

      // 2) X4 Open-shifts guard (`DAY_HAS_OPEN_SHIFTS` 409): block if any open shift opened on/before end of businessDate
      const { endMs } = getBusinessDateBoundsInTz(businessDate, hubCfg.storeTimezone);
      const openBlocking = session.db
        .select({ id: shifts.id, shiftCode: shifts.shiftCode })
        .from(shifts)
        .where(
          and(
            eq(shifts.organizationId, ctx.organizationId),
            eq(shifts.storeId, ctx.storeId),
            eq(shifts.status, 'open'),
            lt(shifts.openedAtMs, endMs),
          ),
        )
        .all();

      if (openBlocking.length > 0) {
        throw new DomainError(
          'DAY_HAS_OPEN_SHIFTS',
          `Cannot close business day "${businessDate}" while ${openBlocking.length} shift(s) remain open`,
          { details: { openShiftIds: openBlocking.map((s) => s.id) } },
        );
      }

      // 3) Collect LATEST closure for every closed shift whose `closedAtMs` falls inside `businessDate` (X4)
      const closedEntries = findLatestClosuresForBusinessDateSync(session.db, {
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        businessDate,
        storeTimezone: hubCfg.storeTimezone,
      });

      const closureIdsSorted = closedEntries.map((e) => e.closure.id).sort();
      const includedClosureIdsJson = JSON.stringify(closureIdsSorted);

      let salesCount = 0;
      let returnsCount = 0;
      let voidsCount = 0;
      let grossSalesTiyin = 0n;
      let returnsTiyin = 0n;
      let netSalesTiyin = 0n;
      let expectedCashTiyin = 0n;
      let countedCashTiyin = 0n;

      const aggSalesByMethod = new Map<string, bigint>();
      const aggReturnsByMethod = new Map<string, bigint>();

      if (closedEntries.length > 0) {
        const closureIds = closedEntries.map((e) => e.closure.id);
        const methodRows = session.db
          .select()
          .from(shiftClosureMethodTotals)
          .where(inArray(shiftClosureMethodTotals.shiftClosureId, closureIds))
          .all();

        for (const m of methodRows) {
          aggSalesByMethod.set(
            m.method,
            (aggSalesByMethod.get(m.method) ?? 0n) + moneyToTiyin(m.salesAmount),
          );
          aggReturnsByMethod.set(
            m.method,
            (aggReturnsByMethod.get(m.method) ?? 0n) + moneyToTiyin(m.returnsAmount),
          );
        }

        for (const { closure: c } of closedEntries) {
          salesCount += c.salesCount;
          returnsCount += c.returnsCount;
          voidsCount += c.voidsCount;
          grossSalesTiyin += moneyToTiyin(c.grossSalesTotal);
          returnsTiyin += moneyToTiyin(c.returnsTotal);
          netSalesTiyin += moneyToTiyin(c.netSalesTotal);
          expectedCashTiyin += moneyToTiyin(c.expectedCash);
          countedCashTiyin += moneyToTiyin(c.countedCash);
        }
      }

      const methodTotalsJson = JSON.stringify(
        [...SALE_PAYMENT_METHODS, 'debt' as const].map((methodKey) => {
          const sAmt = aggSalesByMethod.get(methodKey) ?? 0n;
          const rAmt = aggReturnsByMethod.get(methodKey) ?? 0n;
          return {
            method: methodKey,
            salesAmount: sAmt.toString(),
            returnsAmount: rAmt.toString(),
            netAmount: (sAmt - rAmt).toString(),
          };
        }),
      );

      // 4) Preserve re-close history (`close_seq` increments)
      const latestDayClose = session.db
        .select({ closeSeq: dayCloses.closeSeq })
        .from(dayCloses)
        .where(
          and(
            eq(dayCloses.organizationId, ctx.organizationId),
            eq(dayCloses.storeId, ctx.storeId),
            eq(dayCloses.businessDate, businessDate),
          ),
        )
        .orderBy(desc(dayCloses.closeSeq))
        .limit(1)
        .all()[0];
      const nextCloseSeq = (latestDayClose?.closeSeq ?? 0) + 1;
      const closeCode = formatDayCloseCode(businessDate, nextCloseSeq);

      const write = insertFact(session, dayCloses, {
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        values: {
          businessDate,
          closeSeq: nextCloseSeq,
          closeCode,
          closedByUserId: validActorId,
          clientRequestId: validReqId,
          requestHash,
          note,
          shiftsCount: closedEntries.length,
          salesCount,
          returnsCount,
          voidsCount,
          grossSalesTotal: moneyFromTiyin(grossSalesTiyin),
          returnsTotal: moneyFromTiyin(returnsTiyin),
          netSalesTotal: moneyFromTiyin(netSalesTiyin),
          expectedCashTotal: moneyFromTiyin(expectedCashTiyin),
          countedCashTotal: moneyFromTiyin(countedCashTiyin),
          discrepancyTotal: moneyFromTiyin(countedCashTiyin - expectedCashTiyin),
          methodTotalsJson,
          includedClosureIdsJson,
          fiscalStatus: 'not_fiscalized',
          fiscalReportNo: null,
        },
        eventType: 'day_close.created',
        schemaVersion: 1,
      });

      return Promise.resolve({
        dayClose: toStoredDayCloseRecord(write.row, closureIdsSorted),
        idempotentReplay: false,
      });
    });
  }

  async listDayCloses(query: DayCloseListQueryInput = {}): Promise<DayCloseListOutcome> {
    const ctx = this.requireContext();
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const offset = Math.max(query.offset ?? 0, 0);

    return runConnectionReadOnly(this.connection, () => {
      const hubCfg = readHubShiftConfigSync(this.connection.db, ctx.organizationId);
      const conditions = [
        eq(dayCloses.organizationId, ctx.organizationId),
        eq(dayCloses.storeId, ctx.storeId),
      ];
      if (query.businessDate !== undefined) {
        conditions.push(eq(dayCloses.businessDate, assertValidBusinessDate(query.businessDate)));
      }

      const allMatching = this.connection.db
        .select({ id: dayCloses.id })
        .from(dayCloses)
        .where(and(...conditions))
        .all();
      const total = allMatching.length;

      const rows = this.connection.db
        .select()
        .from(dayCloses)
        .where(and(...conditions))
        .orderBy(desc(dayCloses.businessDate), desc(dayCloses.closeSeq))
        .limit(limit)
        .offset(offset)
        .all();

      const liveIdsByDate = new Map<string, readonly UuidV7[]>();
      const out: StoredDayCloseRecord[] = rows.map((row) => {
        let liveIds = liveIdsByDate.get(row.businessDate);
        if (!liveIds) {
          liveIds = findLatestClosuresForBusinessDateSync(this.connection.db, {
            organizationId: ctx.organizationId,
            storeId: ctx.storeId,
            businessDate: row.businessDate,
            storeTimezone: hubCfg.storeTimezone,
          })
            .map((e) => e.closure.id)
            .sort();
          liveIdsByDate.set(row.businessDate, liveIds);
        }
        return toStoredDayCloseRecord(row, liveIds);
      });

      return Promise.resolve({ dayCloses: out, total });
    });
  }

  async updateCashDiscrepancyThreshold(newThreshold: Money): Promise<Money> {
    const ctx = this.requireContext();
    const validated = validateNonNegativeShiftCash(
      newThreshold,
      'maxCashDiscrepancyWithoutOverride',
    );
    return ctx.uow.execute((session) => {
      const nowMs = session.nowUnixMs();
      const updated = session.db
        .update(localHubConfig)
        .set({
          maxCashDiscrepancyWithoutOverride: validated,
          updatedAtMs: nowMs,
        })
        .where(eq(localHubConfig.organizationId, ctx.organizationId))
        .returning({ val: localHubConfig.maxCashDiscrepancyWithoutOverride })
        .all()[0];

      if (!updated) {
        throw new DomainError('AUTH_UNAUTHORIZED', 'local_hub_config row not found');
      }
      return Promise.resolve(updated.val);
    });
  }
}

export function createSqliteShiftStore(options: CreateSqliteShiftStoreOptions): SqliteShiftStore {
  return new SqliteShiftStore(options.connection, options.getRuntimeContext);
}
