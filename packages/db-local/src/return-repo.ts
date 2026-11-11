import { createHash } from 'node:crypto';
import {
  type CartLineKind,
  DEFAULT_STORE_TIMEZONE,
  DomainError,
  type Money,
  type PaymentMethod,
  type ProductUnit,
  type Quantity,
  type ReturnPaymentInput,
  type UnixMs,
  type UuidV7,
  ZERO_MONEY,
  ZERO_QUANTITY,
  allocateReturnStockMoveLegs,
  assertValidStoreTimeZone,
  canonicalizeCreateReturnRequest,
  canonicalizeVoidSaleRequest,
  computeCumulativeReturnLineAmounts,
  createEmptyPaymentMethodMap,
  formatReturnCode,
  moneyFromTiyin,
  moneyToTiyin,
  negateMoney,
  normalizeMandatoryReason,
  parsePaymentMethod,
  parseProductUnit,
  parseSalePaymentMethod,
  parseUuidV7,
  quantityFromMilli,
  quantityToMilli,
  resolveOrderReturnEffectivePaidByMethod,
  resolveReturnPayments,
  summarizeOrderPayments,
} from '@mezon/domain';
import { and, asc, eq, lt } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { type LocalSqliteConnection } from './connection.js';
import {
  applyReturnDebtOffsetInTxSync,
  prepareReturnSaleDebtContextInTxSync,
  reverseSaleDebtOnVoidInTxSync,
} from './customer-repo.js';
import { advanceReturnSeqSync } from './device-state.js';
import { type StoredSaleRecord, toStoredSaleLine, toStoredSalePayment } from './sale-repo.js';
import { getActiveShiftDrawerBalanceSync, requireOpenShiftSessionSync } from './shift-repo.js';
import {
  cashMoves,
  localHubConfig,
  orderPayments,
  payments,
  products,
  returnLines,
  returnPayments,
  returns,
  saleLines,
  sales,
  stockMoves,
} from './schema/index.js';
import {
  type ReturnStockLegSessionInput,
  applyReturnStockMoveSync,
  prefetchMutablePoolStatesSync,
  stockPoolKey,
  type StockPoolPrefetchTarget,
} from './stock-repo.js';
import {
  type SqliteUnitOfWork,
  type SqliteUnitOfWorkSession,
  runConnectionReadOnly,
} from './uow.js';
import { insertFact, updateMonotone } from './writers.js';

export interface ReturnRuntimeContext {
  readonly uow: SqliteUnitOfWork;
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7;
}

/**
 * Test-only crash injection hook (`C1` atomicity verification): never set by production Hub/Electron.
 */
export interface ReturnStoreTestHooks {
  readonly onBeforeCommit?: () => void;
}

export interface CreateSqliteReturnStoreOptions {
  readonly connection: LocalSqliteConnection;
  readonly getRuntimeContext: () => ReturnRuntimeContext | null;
  readonly __testHooks?: ReturnStoreTestHooks;
}

export interface VoidSaleInput {
  readonly saleId: UuidV7;
  readonly actorUserId: UuidV7;
  readonly reason: string;
  readonly clientRequestId: UuidV7;
}

export interface StoredVoidedSaleRecord extends Omit<StoredSaleRecord, 'status'> {
  readonly status: 'voided';
  readonly voidedAtMs: UnixMs;
  readonly voidedByUserId: UuidV7;
  readonly voidReason: string;
}

export interface VoidSaleOutcome {
  readonly sale: StoredVoidedSaleRecord;
  readonly cashRefundAmount: Money;
  readonly idempotentReplay: boolean;
}

export interface CreateReturnLineInput {
  readonly saleLineId: UuidV7;
  readonly qty: Quantity;
}

export interface CreateReturnInput {
  readonly saleId: UuidV7;
  readonly actorUserId: UuidV7;
  readonly overrideApprovedByUserId?: UuidV7 | null;
  readonly reason: string;
  readonly clientRequestId: UuidV7;
  readonly items: readonly CreateReturnLineInput[];
  readonly payments: readonly ReturnPaymentInput[];
  readonly debtOffsetAmount?: Money;
}

export interface StoredReturnLineRecord {
  readonly id: UuidV7;
  readonly returnId: UuidV7;
  readonly saleId: UuidV7;
  readonly saleLineId: UuidV7;
  readonly sortOrder: number;
  readonly lineKind: CartLineKind;
  readonly productId: UuidV7 | null;
  readonly variantId: UuidV7 | null;
  readonly itemName: string;
  readonly unit: ProductUnit;
  readonly qty: Quantity;
  readonly unitPriceSnapshot: Money;
  readonly vatRateBpSnapshot: number;
  readonly mxikSnapshot: string | null;
  readonly packageCodeSnapshot: string | null;
  readonly refundAmount: Money;
  readonly netExVat: Money;
  readonly vatTotal: Money;
  readonly costValue: Money;
}

export interface StoredReturnPaymentRecord {
  readonly id: UuidV7;
  readonly method: PaymentMethod;
  readonly amount: Money;
  readonly providerRef: string | null;
  readonly createdAtMs: UnixMs;
}

export interface StoredReturnRecord {
  readonly id: UuidV7;
  readonly returnNo: bigint;
  readonly returnCode: string;
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7;
  readonly deviceId: UuidV7;
  readonly saleId: UuidV7;
  readonly shiftId: UuidV7 | null;
  readonly shiftCashierSessionId: UuidV7 | null;
  readonly processedByUserId: UuidV7;
  readonly overrideApprovedByUserId: UuidV7 | null;
  readonly overrideApprovedAtMs: UnixMs | null;
  readonly reason: string;
  readonly clientRequestId: UuidV7;
  readonly totalRefund: Money;
  readonly totalNetExVat: Money;
  readonly totalVat: Money;
  readonly cashRefundAmount: Money;
  readonly nonCashRefundAmount: Money;
  readonly debtOffsetAmount: Money;
  readonly createdAtMs: UnixMs;
  readonly lines: readonly StoredReturnLineRecord[];
  readonly payments: readonly StoredReturnPaymentRecord[];
}

export interface CreateReturnOutcome {
  readonly returnDoc: StoredReturnRecord;
  readonly idempotentReplay: boolean;
}

export interface SalesLinesReportSummaryRecord {
  readonly lineCount: number;
  readonly signedQtyTotal: bigint;
  readonly revenue: Money;
  readonly netRevenue: Money;
  readonly vatTotal: Money;
  readonly costValue: Money;
  readonly grossProfit: Money;
}

function sha256Hex(canonical: string): string {
  return createHash('sha256').update(canonical).digest('hex');
}

function toStoredReturnLine(row: typeof returnLines.$inferSelect): StoredReturnLineRecord {
  return {
    id: row.id,
    returnId: row.returnId,
    saleId: row.saleId,
    saleLineId: row.saleLineId,
    sortOrder: row.sortOrder,
    lineKind: row.lineKind as CartLineKind,
    productId: row.productId,
    variantId: row.variantId,
    itemName: row.itemName,
    unit: parseProductUnit(row.unit),
    qty: row.qty,
    unitPriceSnapshot: row.unitPriceSnapshot,
    vatRateBpSnapshot: row.vatRateBpSnapshot,
    mxikSnapshot: row.mxikSnapshot,
    packageCodeSnapshot: row.packageCodeSnapshot,
    refundAmount: row.refundAmount,
    netExVat: row.netExVat,
    vatTotal: row.vatTotal,
    costValue: row.costValue,
  };
}

function toStoredReturnPayment(row: typeof returnPayments.$inferSelect): StoredReturnPaymentRecord {
  return {
    id: row.id,
    method: parsePaymentMethod(row.method),
    amount: row.amount,
    providerRef: row.providerRef,
    createdAtMs: row.createdAtMs,
  };
}

function toStoredReturnRecord(
  row: typeof returns.$inferSelect,
  lineRows: readonly (typeof returnLines.$inferSelect)[],
  paymentRows: readonly (typeof returnPayments.$inferSelect)[],
): StoredReturnRecord {
  return {
    id: row.id,
    returnNo: row.returnNo,
    returnCode: row.returnCode,
    organizationId: row.organizationId,
    storeId: row.storeId,
    deviceId: row.deviceId,
    saleId: row.saleId,
    shiftId: row.shiftId,
    shiftCashierSessionId: row.shiftCashierSessionId,
    processedByUserId: row.processedByUserId,
    overrideApprovedByUserId: row.overrideApprovedByUserId,
    overrideApprovedAtMs: row.overrideApprovedAtMs,
    reason: row.reason,
    clientRequestId: row.clientRequestId,
    totalRefund: row.totalRefund,
    totalNetExVat: row.totalNetExVat,
    totalVat: row.totalVat,
    cashRefundAmount: row.cashRefundAmount,
    nonCashRefundAmount: row.nonCashRefundAmount,
    debtOffsetAmount: row.debtOffsetAmount,
    createdAtMs: row.createdAtMs,
    lines: lineRows.map(toStoredReturnLine),
    payments: paymentRows.map(toStoredReturnPayment),
  };
}

function toStoredVoidedSale(
  row: typeof sales.$inferSelect,
  lineRows: readonly (typeof saleLines.$inferSelect)[],
  paymentRows: readonly (typeof payments.$inferSelect)[],
): StoredVoidedSaleRecord {
  if (row.voidedAtMs === null || row.voidedByUserId === null || row.voidReason === null) {
    throw new DomainError('VALIDATION_ERROR', `Sale "${row.id}" is missing voided metadata`);
  }
  return {
    id: row.id,
    receiptNo: row.receiptNo,
    receiptCode: row.receiptCode,
    organizationId: row.organizationId,
    storeId: row.storeId,
    deviceId: row.deviceId,
    sourceCartId: row.sourceCartId,
    sourceOrderId: row.sourceOrderId,
    cashierUserId: row.cashierUserId,
    completedByUserId: row.completedByUserId,
    customerId: row.customerId,
    shiftId: row.shiftId,
    shiftCashierSessionId: row.shiftCashierSessionId,
    clientRequestId: row.clientRequestId,
    status: 'voided',
    subtotalGross: row.subtotalGross,
    totalPromoDiscount: row.totalPromoDiscount,
    subtotalAfterPromo: row.subtotalAfterPromo,
    manualDiscountMode: row.manualDiscountMode as StoredSaleRecord['manualDiscountMode'],
    manualDiscountValue: row.manualDiscountValue,
    manualDiscountReason: row.manualDiscountReason,
    orderDiscountAmount: row.orderDiscountAmount,
    totalFinal: row.totalFinal,
    totalNetExVat: row.totalNetExVat,
    totalVat: row.totalVat,
    totalPaid: row.totalPaid,
    debtAmount: row.debtAmount,
    changeAmount: row.changeAmount,
    overrideApprovedByUserId: row.overrideApprovedByUserId,
    overrideApprovedAmount: row.overrideApprovedAmount,
    overrideApprovedAtMs: row.overrideApprovedAtMs,
    createdAtMs: row.createdAtMs,
    voidedAtMs: row.voidedAtMs,
    voidedByUserId: row.voidedByUserId,
    voidReason: row.voidReason,
    lines: lineRows.map(toStoredSaleLine),
    payments: paymentRows.map(toStoredSalePayment),
  };
}

function sumNetCashPayments(paymentRows: readonly (typeof payments.$inferSelect)[]): Money {
  // V2: Strictly sums applied net cash (`payments.amount`), NEVER `tenderedAmount`.
  let cashTiyin = 0n;
  for (const p of paymentRows) {
    if (p.method === 'cash') {
      cashTiyin += moneyToTiyin(p.amount);
    }
  }
  return moneyFromTiyin(cashTiyin);
}

/**
 * F3 FISCALIZATION GATE HOOK:
 * Once `fiscal_docs` is introduced in F3, checks whether `sale` has already been fiscalized.
 * Per `GEMINI.md`, a fiscalized receipt CANNOT be voided — it must be reversed via `createReturn`.
 */
function assertSaleNotFiscalizedForVoidSync(
  _session: SqliteUnitOfWorkSession,
  _saleRow: typeof sales.$inferSelect,
): void {
  // F1/T1.6 has no fiscal driver yet; F3 queries `fiscal_docs` here and throws `FISCALIZED_SALE_CANNOT_VOID`.
}

/**
 * Reconstructs exact outbound `stock_moves` legs created for each tracked `sale_line` during `completeSale`.
 * Because `completeSale` writes outbound moves sequentially per tracked line in `sortOrder ASC`, consuming
 * full move rows per `(productId, variantId)` until `accQty === line.qty` restores the exact 1-to-1 leg subset.
 */
function allocateSaleLinesToStockLegsSync(
  db: BetterSQLite3Database,
  saleRow: typeof sales.$inferSelect,
  saleLineRows: readonly (typeof saleLines.$inferSelect)[],
  productUnlimitedById: ReadonlyMap<UuidV7, boolean>,
): Map<
  UuidV7,
  readonly {
    readonly moveId: UuidV7;
    readonly batchId: UuidV7 | null;
    readonly soldQty: Quantity;
    readonly soldCostValue: Money;
  }[]
> {
  const outboundMoves = db
    .select()
    .from(stockMoves)
    .where(
      and(
        eq(stockMoves.organizationId, saleRow.organizationId),
        eq(stockMoves.storeId, saleRow.storeId),
        eq(stockMoves.sourceType, 'sale'),
        eq(stockMoves.sourceId, saleRow.id),
        lt(stockMoves.qtyDelta, ZERO_QUANTITY),
      ),
    )
    .orderBy(asc(stockMoves.id))
    .all();

  const movesByPool = new Map<string, (typeof stockMoves.$inferSelect)[]>();
  for (const m of outboundMoves) {
    const key = stockPoolKey(m.productId, m.variantId);
    const list = movesByPool.get(key);
    if (list) {
      list.push(m);
    } else {
      movesByPool.set(key, [m]);
    }
  }
  const poolCursor = new Map<string, number>();

  const legsBySaleLineId = new Map<
    UuidV7,
    readonly {
      readonly moveId: UuidV7;
      readonly batchId: UuidV7 | null;
      readonly soldQty: Quantity;
      readonly soldCostValue: Money;
    }[]
  >();

  for (const line of saleLineRows) {
    if (line.lineKind !== 'catalog' || line.productId === null) {
      legsBySaleLineId.set(line.id, []);
      continue;
    }
    const isUnlimited = productUnlimitedById.get(line.productId) ?? false;
    if (isUnlimited) {
      legsBySaleLineId.set(line.id, []);
      continue;
    }

    const key = stockPoolKey(line.productId, line.variantId);
    const queue = movesByPool.get(key) ?? [];
    let idx = poolCursor.get(key) ?? 0;

    if (queue.length === 0) {
      legsBySaleLineId.set(line.id, []);
      continue;
    }

    const targetQtyMilli = quantityToMilli(line.qty);
    let accQtyMilli = 0n;
    let accCostTiyin = 0n;
    const assigned: {
      readonly moveId: UuidV7;
      readonly batchId: UuidV7 | null;
      readonly soldQty: Quantity;
      readonly soldCostValue: Money;
    }[] = [];

    while (idx < queue.length && accQtyMilli < targetQtyMilli) {
      const m = queue[idx];
      idx += 1;
      const moveQtyMilli = -quantityToMilli(m.qtyDelta);
      const moveCostTiyin = -moneyToTiyin(m.costValueDelta);
      accQtyMilli += moveQtyMilli;
      accCostTiyin += moveCostTiyin;
      assigned.push({
        moveId: m.id,
        batchId: m.batchId,
        soldQty: quantityFromMilli(moveQtyMilli),
        soldCostValue: moneyFromTiyin(moveCostTiyin),
      });
    }
    poolCursor.set(key, idx);

    if (accQtyMilli !== targetQtyMilli || accCostTiyin !== moneyToTiyin(line.costValue)) {
      throw new DomainError(
        'VALIDATION_ERROR',
        `Stock move history mismatch on sale_line "${line.id}"`,
      );
    }
    legsBySaleLineId.set(line.id, assigned);
  }

  return legsBySaleLineId;
}

export class SqliteReturnStore {
  private readonly connection: LocalSqliteConnection;
  private readonly getRuntimeContext: () => ReturnRuntimeContext | null;
  private readonly testHooks?: ReturnStoreTestHooks;

  constructor(options: CreateSqliteReturnStoreOptions) {
    this.connection = options.connection;
    this.getRuntimeContext = options.getRuntimeContext;
    this.testHooks = options.__testHooks;
  }

  private requireContext(): ReturnRuntimeContext {
    const ctx = this.getRuntimeContext();
    if (!ctx) {
      throw new DomainError('AUTH_UNAUTHORIZED', 'Hub setup must be completed before void/returns');
    }
    return ctx;
  }

  async setStoreTimezone(timeZone: string): Promise<string> {
    const { uow, organizationId } = this.requireContext();
    const validTz = assertValidStoreTimeZone(timeZone);
    return uow.execute((session) => {
      session.db
        .update(localHubConfig)
        .set({
          storeTimezone: validTz,
          updatedAtMs: session.nowUnixMs(),
        })
        .where(eq(localHubConfig.organizationId, organizationId))
        .run();
      return Promise.resolve(validTz);
    });
  }

  async getStoreTimezone(): Promise<string> {
    const ctx = this.requireContext();
    return runConnectionReadOnly(this.connection, () => {
      const row = this.connection.db
        .select({ storeTimezone: localHubConfig.storeTimezone })
        .from(localHubConfig)
        .where(eq(localHubConfig.organizationId, ctx.organizationId))
        .limit(1)
        .all()[0];
      return Promise.resolve(row?.storeTimezone ?? DEFAULT_STORE_TIMEZONE);
    });
  }

  /**
   * Atomically voids an unreturned, same-business-day, non-fiscalized sale in a single `BEGIN IMMEDIATE`
   * transaction: sets MONOTONE `sales.voided_*`, writes compensating `FACT` stock & cash moves, and
   * enqueues matching outbox rows.
   */
  async voidSale(input: VoidSaleInput): Promise<VoidSaleOutcome> {
    const ctx = this.requireContext();
    const validSaleId = parseUuidV7(input.saleId);
    const validActorId = parseUuidV7(input.actorUserId);
    const validClientReqId = parseUuidV7(input.clientRequestId);
    const cleanReason = normalizeMandatoryReason(input.reason);
    const incomingRequestHash = sha256Hex(
      canonicalizeVoidSaleRequest({ saleId: validSaleId, reason: cleanReason }),
    );

    return ctx.uow.execute<VoidSaleOutcome>((session) => {
      const nowMs = session.nowUnixMs();

      // 1) Idempotency check across org
      const replayRow = session.db
        .select()
        .from(sales)
        .where(
          and(
            eq(sales.organizationId, ctx.organizationId),
            eq(sales.voidClientRequestId, validClientReqId),
          ),
        )
        .limit(1)
        .all()[0];

      if (replayRow) {
        if (
          replayRow.storeId !== ctx.storeId ||
          replayRow.id !== validSaleId ||
          replayRow.voidRequestHash !== incomingRequestHash
        ) {
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            `clientRequestId "${validClientReqId}" already voided a different sale or payload`,
          );
        }
        const existingLines = session.db
          .select()
          .from(saleLines)
          .where(eq(saleLines.saleId, replayRow.id))
          .orderBy(asc(saleLines.sortOrder))
          .all();
        const existingPayments = session.db
          .select()
          .from(payments)
          .where(eq(payments.saleId, replayRow.id))
          .orderBy(asc(payments.createdAtMs))
          .all();
        return Promise.resolve({
          sale: toStoredVoidedSale(replayRow, existingLines, existingPayments),
          cashRefundAmount: sumNetCashPayments(existingPayments),
          idempotentReplay: true,
        });
      }

      // 2) Require active open shift + cashier session access (X2), then enforce MONOTONE, zero prior returns, F3 fiscal gate, & V1 same-open-shift
      const activeShift = requireOpenShiftSessionSync(session.db, {
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        deviceId: ctx.uow.deviceId,
        actorUserId: validActorId,
      });

      const saleRow = session.db
        .select()
        .from(sales)
        .where(
          and(
            eq(sales.id, validSaleId),
            eq(sales.organizationId, ctx.organizationId),
            eq(sales.storeId, ctx.storeId),
          ),
        )
        .limit(1)
        .all()[0];

      if (!saleRow) {
        throw new DomainError('SALE_NOT_FOUND', `Sale "${validSaleId}" was not found`);
      }
      if (saleRow.voidedAtMs !== null) {
        throw new DomainError('SALE_ALREADY_VOIDED', `Sale "${validSaleId}" is already voided`);
      }
      if (saleRow.sourceOrderId !== null) {
        throw new DomainError(
          'ORDER_SALE_USE_RETURN',
          `Delivered order receipt "${validSaleId}" cannot be voided; create a return instead`,
        );
      }

      if (saleRow.shiftId !== activeShift.shift.id) {
        throw new DomainError(
          'SHIFT_ALREADY_CLOSED',
          `Sale "${validSaleId}" belongs to another or closed shift and cannot be voided; create a return instead`,
        );
      }

      const existingReturn = session.db
        .select({ id: returns.id })
        .from(returns)
        .where(
          and(
            eq(returns.organizationId, ctx.organizationId),
            eq(returns.storeId, ctx.storeId),
            eq(returns.saleId, validSaleId),
          ),
        )
        .limit(1)
        .all()[0];
      if (existingReturn) {
        throw new DomainError(
          'SALE_HAS_RETURNS',
          `Sale "${validSaleId}" already has return "${existingReturn.id}" and cannot be voided`,
        );
      }

      assertSaleNotFiscalizedForVoidSync(session, saleRow);

      const lineRows = session.db
        .select()
        .from(saleLines)
        .where(eq(saleLines.saleId, saleRow.id))
        .orderBy(asc(saleLines.sortOrder))
        .all();
      const paymentRows = session.db
        .select()
        .from(payments)
        .where(eq(payments.saleId, saleRow.id))
        .orderBy(asc(payments.createdAtMs))
        .all();

      // 3) V2 + X1: Cash drawer sufficiency uses active open shift's balance only!
      const cashRefundAmount = sumNetCashPayments(paymentRows);
      const cashRefundTiyin = moneyToTiyin(cashRefundAmount);
      if (cashRefundTiyin > 0n) {
        const drawerBalance = getActiveShiftDrawerBalanceSync(
          session.db,
          session.internalGetSqlite(),
          {
            organizationId: ctx.organizationId,
            storeId: ctx.storeId,
            deviceId: ctx.uow.deviceId,
          },
        );
        if (moneyToTiyin(drawerBalance) < cashRefundTiyin) {
          throw new DomainError(
            'INSUFFICIENT_CASH_IN_DRAWER',
            `Terminal cash drawer balance (${moneyToTiyin(drawerBalance).toString()} tiyin) is insufficient for cash refund (${cashRefundTiyin.toString()} tiyin)`,
            {
              details: {
                drawerBalance: moneyToTiyin(drawerBalance).toString(),
                requiredCashRefund: cashRefundTiyin.toString(),
              },
            },
          );
        }
      }

      // 3b) T1.7: Validate and reverse sale debt in `customer_ledger` (rejects SALE_DEBT_HAS_PAYMENTS if already reduced)
      reverseSaleDebtOnVoidInTxSync(session, {
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        customerId: saleRow.customerId,
        saleId: saleRow.id,
        saleDebtAmount: saleRow.debtAmount,
        reason: `Void ${saleRow.receiptCode}: ${cleanReason}`,
        actorUserId: validActorId,
        nowMs,
      });

      // 4) Load product tracking info and prefetch pool states before modifying anything
      const catalogProductIds = [
        ...new Set(lineRows.map((l) => l.productId).filter((id): id is UuidV7 => id !== null)),
      ];
      const productById = new Map<UuidV7, typeof products.$inferSelect>();
      const productUnlimitedById = new Map<UuidV7, boolean>();
      const prefetchTargets: StockPoolPrefetchTarget[] = [];

      if (catalogProductIds.length > 0) {
        for (const pid of catalogProductIds) {
          const prod = session.db
            .select()
            .from(products)
            .where(and(eq(products.id, pid), eq(products.organizationId, ctx.organizationId)))
            .limit(1)
            .all()[0];
          if (prod) {
            productById.set(prod.id, prod);
            productUnlimitedById.set(prod.id, Boolean(prod.unlimited));
          }
        }
        for (const line of lineRows) {
          if (line.lineKind !== 'catalog' || line.productId === null) {
            continue;
          }
          const prod = productById.get(line.productId);
          if (!prod || Boolean(prod.unlimited)) {
            continue;
          }
          prefetchTargets.push({
            productId: prod.id,
            variantId: line.variantId,
            trackBatches: Boolean(prod.trackBatches),
          });
        }
      }

      const legsBySaleLineId = allocateSaleLinesToStockLegsSync(
        session.db,
        saleRow,
        lineRows,
        productUnlimitedById,
      );
      const sessionPoolCache = prefetchMutablePoolStatesSync(session, {
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        targets: prefetchTargets,
      });

      // 5) One-way MONOTONE update on `sales`
      const updatedSaleWrite = updateMonotone(session, sales, {
        id: saleRow.id,
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        values: {
          voidedAtMs: nowMs,
          voidedByUserId: validActorId,
          voidReason: cleanReason,
          voidClientRequestId: validClientReqId,
          voidRequestHash: incomingRequestHash,
        },
        eventType: 'sale.voided',
        schemaVersion: 1,
      });

      // 6) Restore inventory cleanly (V5 skips non-tracked lines automatically)
      for (const line of lineRows) {
        const lineLegs = legsBySaleLineId.get(line.id) ?? [];
        if (lineLegs.length === 0 || line.productId === null) {
          continue;
        }
        const restoreLegs: ReturnStockLegSessionInput[] = lineLegs.map((l) => ({
          batchId: l.batchId,
          qty: l.soldQty,
          costValue: l.soldCostValue,
        }));
        applyReturnStockMoveSync(session, {
          organizationId: ctx.organizationId,
          storeId: ctx.storeId,
          productId: line.productId,
          variantId: line.variantId,
          legs: restoreLegs,
          fallbackBatchNumber: `RET-${line.id}`,
          sourceId: saleRow.id,
          note: `Void receipt ${saleRow.receiptCode}`,
          actorUserId: validActorId,
          sessionPoolCache,
        });
      }

      // 7) Record compensating cash outflow in `cash_moves` (`refund_cash_out`), stamped with X2 cashier session
      if (cashRefundTiyin > 0n) {
        const cashPaymentRow = paymentRows.find((p) => p.method === 'cash');
        insertFact(session, cashMoves, {
          organizationId: ctx.organizationId,
          storeId: ctx.storeId,
          values: {
            shiftId: activeShift.shift.id,
            shiftCashierSessionId: activeShift.activeSession.id,
            type: 'refund_cash_out',
            amountDelta: negateMoney(cashRefundAmount),
            sourceType: 'sale_void',
            sourceId: saleRow.id,
            paymentId: cashPaymentRow?.id ?? null,
            expenseCategory: null,
            reason: `Void ${saleRow.receiptCode}: ${cleanReason}`,
            createdByUserId: validActorId,
          },
          eventType: 'cash_move.created',
          schemaVersion: 1,
        });
      }

      this.testHooks?.onBeforeCommit?.();

      return Promise.resolve({
        sale: toStoredVoidedSale(updatedSaleWrite.row, lineRows, paymentRows),
        cashRefundAmount,
        idempotentReplay: false,
      });
    });
  }

  /**
   * Atomically creates a partial or full customer return document (`returns`, `return_lines`,
   * `return_payments`, compensating `stock_moves`, and `cash_moves`) inside `BEGIN IMMEDIATE`.
   */
  async createReturn(input: CreateReturnInput): Promise<CreateReturnOutcome> {
    const ctx = this.requireContext();
    const validSaleId = parseUuidV7(input.saleId);
    const validActorId = parseUuidV7(input.actorUserId);
    const validOverrideId =
      input.overrideApprovedByUserId !== undefined && input.overrideApprovedByUserId !== null
        ? parseUuidV7(input.overrideApprovedByUserId)
        : null;
    const validClientReqId = parseUuidV7(input.clientRequestId);
    const cleanReason = normalizeMandatoryReason(input.reason);
    const requestedDebtOffset = input.debtOffsetAmount ?? ZERO_MONEY;

    if (input.items.length === 0) {
      throw new DomainError('VALIDATION_ERROR', 'At least one return item is required');
    }

    const seenLineIds = new Set<string>();
    const validItems: { readonly saleLineId: UuidV7; readonly qty: Quantity }[] = [];
    for (const item of input.items) {
      const saleLineId = parseUuidV7(item.saleLineId);
      if (seenLineIds.has(saleLineId)) {
        throw new DomainError(
          'VALIDATION_ERROR',
          `Duplicate saleLineId "${saleLineId}" in return items`,
        );
      }
      seenLineIds.add(saleLineId);
      validItems.push({ saleLineId, qty: item.qty });
    }

    const incomingRequestHash = sha256Hex(
      canonicalizeCreateReturnRequest({
        saleId: validSaleId,
        reason: cleanReason,
        debtOffsetAmount: requestedDebtOffset,
        items: validItems,
        payments: input.payments,
      }),
    );

    return ctx.uow.execute<CreateReturnOutcome>((session) => {
      const nowMs = session.nowUnixMs();

      // 1) Idempotency lookup
      const existingReturn = session.db
        .select()
        .from(returns)
        .where(
          and(
            eq(returns.organizationId, ctx.organizationId),
            eq(returns.clientRequestId, validClientReqId),
          ),
        )
        .limit(1)
        .all()[0];

      if (existingReturn) {
        if (
          existingReturn.storeId !== ctx.storeId ||
          existingReturn.saleId !== validSaleId ||
          existingReturn.requestHash !== incomingRequestHash
        ) {
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            `clientRequestId "${validClientReqId}" already used with a different return payload`,
          );
        }
        return Promise.resolve({
          returnDoc: this.loadReturnRecordSync(session.db, existingReturn),
          idempotentReplay: true,
        });
      }

      // 2) Require active open shift + cashier session access (X2), then load target sale
      const activeShift = requireOpenShiftSessionSync(session.db, {
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        deviceId: ctx.uow.deviceId,
        actorUserId: validActorId,
      });

      const saleRow = session.db
        .select()
        .from(sales)
        .where(
          and(
            eq(sales.id, validSaleId),
            eq(sales.organizationId, ctx.organizationId),
            eq(sales.storeId, ctx.storeId),
          ),
        )
        .limit(1)
        .all()[0];

      if (!saleRow) {
        throw new DomainError('SALE_NOT_FOUND', `Sale "${validSaleId}" was not found`);
      }
      if (saleRow.voidedAtMs !== null) {
        throw new DomainError(
          'SALE_ALREADY_VOIDED',
          `Sale "${validSaleId}" has been voided and cannot be returned`,
        );
      }

      const saleLineRows = session.db
        .select()
        .from(saleLines)
        .where(eq(saleLines.saleId, saleRow.id))
        .orderBy(asc(saleLines.sortOrder))
        .all();
      const saleLineById = new Map<UuidV7, typeof saleLines.$inferSelect>(
        saleLineRows.map((l) => [l.id, l]),
      );

      const salePaymentRows = session.db
        .select()
        .from(payments)
        .where(eq(payments.saleId, saleRow.id))
        .orderBy(asc(payments.createdAtMs))
        .all();

      const priorReturnLineRows = session.db
        .select()
        .from(returnLines)
        .where(
          and(
            eq(returnLines.organizationId, ctx.organizationId),
            eq(returnLines.storeId, ctx.storeId),
            eq(returnLines.saleId, saleRow.id),
          ),
        )
        .all();

      const priorAggBySaleLine = new Map<
        UuidV7,
        {
          qtyMilli: bigint;
          refundTiyin: bigint;
          netTiyin: bigint;
          vatTiyin: bigint;
          costTiyin: bigint;
        }
      >();
      for (const rl of priorReturnLineRows) {
        const cur = priorAggBySaleLine.get(rl.saleLineId) ?? {
          qtyMilli: 0n,
          refundTiyin: 0n,
          netTiyin: 0n,
          vatTiyin: 0n,
          costTiyin: 0n,
        };
        cur.qtyMilli += quantityToMilli(rl.qty);
        cur.refundTiyin += moneyToTiyin(rl.refundAmount);
        cur.netTiyin += moneyToTiyin(rl.netExVat);
        cur.vatTiyin += moneyToTiyin(rl.vatTotal);
        cur.costTiyin += moneyToTiyin(rl.costValue);
        priorAggBySaleLine.set(rl.saleLineId, cur);
      }

      // 3) Resolve product metadata & stock move legs for all sale lines
      const catalogProductIds = [
        ...new Set(saleLineRows.map((l) => l.productId).filter((id): id is UuidV7 => id !== null)),
      ];
      const productById = new Map<UuidV7, typeof products.$inferSelect>();
      const productUnlimitedById = new Map<UuidV7, boolean>();
      for (const pid of catalogProductIds) {
        const prod = session.db
          .select()
          .from(products)
          .where(and(eq(products.id, pid), eq(products.organizationId, ctx.organizationId)))
          .limit(1)
          .all()[0];
        if (prod) {
          productById.set(prod.id, prod);
          productUnlimitedById.set(prod.id, Boolean(prod.unlimited));
        }
      }

      const legsBySaleLineId = allocateSaleLinesToStockLegsSync(
        session.db,
        saleRow,
        saleLineRows,
        productUnlimitedById,
      );

      // 4) Compute cumulative return line amounts & stock leg allocations
      const plannedLines: {
        readonly sortOrder: number;
        readonly origLine: typeof saleLines.$inferSelect;
        readonly qty: Quantity;
        readonly refundAmount: Money;
        readonly netExVat: Money;
        readonly vatTotal: Money;
        readonly costValue: Money;
        readonly stockLegs: readonly ReturnStockLegSessionInput[];
      }[] = [];

      const prefetchTargets: StockPoolPrefetchTarget[] = [];
      let totalRefundTiyin = 0n;
      let totalNetTiyin = 0n;
      let totalVatTiyin = 0n;

      for (let i = 0; i < validItems.length; i += 1) {
        const item = validItems[i];
        const origLine = saleLineById.get(item.saleLineId);
        if (!origLine) {
          throw new DomainError(
            'SALE_LINE_NOT_FOUND',
            `Sale line "${item.saleLineId}" does not belong to sale "${saleRow.id}"`,
          );
        }

        const prev = priorAggBySaleLine.get(origLine.id) ?? {
          qtyMilli: 0n,
          refundTiyin: 0n,
          netTiyin: 0n,
          vatTiyin: 0n,
          costTiyin: 0n,
        };

        const amounts = computeCumulativeReturnLineAmounts({
          saleLineId: origLine.id,
          unit: parseProductUnit(origLine.unit),
          soldQty: origLine.qty,
          previouslyReturnedQty: quantityFromMilli(prev.qtyMilli),
          requestedQty: item.qty,
          soldFinalTotal: origLine.finalTotal,
          soldNetExVat: origLine.netExVat,
          soldVatTotal: origLine.vatTotal,
          previouslyRefunded: moneyFromTiyin(prev.refundTiyin),
          previouslyReturnedNet: moneyFromTiyin(prev.netTiyin),
          previouslyReturnedVat: moneyFromTiyin(prev.vatTiyin),
        });

        const origLegs = legsBySaleLineId.get(origLine.id) ?? [];
        const stockAlloc = allocateReturnStockMoveLegs({
          origLegs,
          soldLineQty: origLine.qty,
          soldLineCostValue: origLine.costValue,
          previouslyReturnedQty: quantityFromMilli(prev.qtyMilli),
          previouslyReturnedCostValue: moneyFromTiyin(prev.costTiyin),
          requestedQty: amounts.qty,
        });

        if (stockAlloc.legs.length > 0 && origLine.productId !== null) {
          const prod = productById.get(origLine.productId);
          if (prod && !Boolean(prod.unlimited)) {
            prefetchTargets.push({
              productId: prod.id,
              variantId: origLine.variantId,
              trackBatches: Boolean(prod.trackBatches),
            });
          }
        }

        totalRefundTiyin += moneyToTiyin(amounts.refundAmount);
        totalNetTiyin += moneyToTiyin(amounts.netExVat);
        totalVatTiyin += moneyToTiyin(amounts.vatTotal);

        plannedLines.push({
          sortOrder: i,
          origLine,
          qty: amounts.qty,
          refundAmount: amounts.refundAmount,
          netExVat: amounts.netExVat,
          vatTotal: amounts.vatTotal,
          costValue: stockAlloc.totalCostValue,
          stockLegs: stockAlloc.legs.map((l) => ({
            batchId: l.batchId,
            qty: l.qty,
            costValue: l.costValue,
          })),
        });
      }

      // 5) Validate per-method refund limits (`payments.amount` - prior returned), T1.7 hook, & drawer cash
      let originalPaidByMethod = createEmptyPaymentMethodMap();
      if (saleRow.sourceOrderId !== null) {
        // O1 / T1.6: Expand 'advance' row in delivered order sale payments into real order_payments methods.
        const ordPayRows = session.db
          .select()
          .from(orderPayments)
          .where(
            and(
              eq(orderPayments.organizationId, ctx.organizationId),
              eq(orderPayments.storeId, ctx.storeId),
              eq(orderPayments.orderId, saleRow.sourceOrderId),
            ),
          )
          .orderBy(asc(orderPayments.createdAtMs), asc(orderPayments.id))
          .all();
        const advSummary = summarizeOrderPayments(
          ordPayRows.map((op) => ({
            kind: op.kind as 'advance' | 'advance_refund',
            method: parsePaymentMethod(op.method),
            amount: op.amount,
          })),
        );
        originalPaidByMethod = resolveOrderReturnEffectivePaidByMethod({
          salePayments: salePaymentRows.map((p) => ({
            method: parseSalePaymentMethod(p.method),
            amount: p.amount,
          })),
          netAdvanceByMethod: advSummary.netAdvanceByMethod,
          netAdvanceTotal: advSummary.netAdvance,
        });
      } else {
        for (const p of salePaymentRows) {
          const m = parsePaymentMethod(p.method);
          originalPaidByMethod[m] = moneyFromTiyin(
            moneyToTiyin(originalPaidByMethod[m]) + moneyToTiyin(p.amount),
          );
        }
      }

      const priorReturnPaymentRows = session.db
        .select()
        .from(returnPayments)
        .where(
          and(
            eq(returnPayments.organizationId, ctx.organizationId),
            eq(returnPayments.storeId, ctx.storeId),
            eq(returnPayments.saleId, saleRow.id),
          ),
        )
        .all();

      const priorReturnedByMethod = createEmptyPaymentMethodMap();
      for (const rp of priorReturnPaymentRows) {
        const m = parsePaymentMethod(rp.method);
        priorReturnedByMethod[m] = moneyFromTiyin(
          moneyToTiyin(priorReturnedByMethod[m]) + moneyToTiyin(rp.amount),
        );
      }

      const debtContext = prepareReturnSaleDebtContextInTxSync(session, {
        organizationId: ctx.organizationId,
        customerId: saleRow.customerId,
        saleId: saleRow.id,
        saleDebtAmount: saleRow.debtAmount,
        nowMs,
      });

      const resolvedPayments = resolveReturnPayments({
        totalRefund: moneyFromTiyin(totalRefundTiyin),
        debtOffsetAmount: requestedDebtOffset,
        saleTotalPaid: saleRow.totalPaid,
        saleDebtAmount: saleRow.debtAmount,
        ...(debtContext !== null
          ? {
              remainingSaleDebt: debtContext.remainingSaleDebt,
              paidTowardDebtByMethod: debtContext.paidTowardDebtByMethod,
            }
          : {}),
        originalPaidByMethod,
        priorReturnedByMethod,
        payments: input.payments,
      });

      const cashRefundTiyin = moneyToTiyin(resolvedPayments.cashRefundAmount);
      if (cashRefundTiyin > 0n) {
        const drawerBalance = getActiveShiftDrawerBalanceSync(
          session.db,
          session.internalGetSqlite(),
          {
            organizationId: ctx.organizationId,
            storeId: ctx.storeId,
            deviceId: ctx.uow.deviceId,
          },
        );
        if (moneyToTiyin(drawerBalance) < cashRefundTiyin) {
          throw new DomainError(
            'INSUFFICIENT_CASH_IN_DRAWER',
            `Terminal cash drawer balance (${moneyToTiyin(drawerBalance).toString()} tiyin) is insufficient for cash refund (${cashRefundTiyin.toString()} tiyin)`,
            {
              details: {
                drawerBalance: moneyToTiyin(drawerBalance).toString(),
                requiredCashRefund: cashRefundTiyin.toString(),
              },
            },
          );
        }
      }

      const sessionPoolCache = prefetchMutablePoolStatesSync(session, {
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        targets: prefetchTargets,
      });

      // 6) Allocate gapless `return_no` inside same transaction
      const returnNo = advanceReturnSeqSync(session.internalGetSqlite(), {
        deviceId: ctx.uow.deviceId,
        updatedAtMs: nowMs,
      });
      const returnCode = formatReturnCode(ctx.uow.deviceId, returnNo);

      // 7) Insert `returns`, `return_lines`, `return_payments`, restore stock & insert `cash_moves`
      const returnWrite = insertFact(session, returns, {
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        values: {
          saleId: saleRow.id,
          shiftId: activeShift.shift.id,
          shiftCashierSessionId: activeShift.activeSession.id,
          returnNo,
          returnCode,
          processedByUserId: validActorId,
          overrideApprovedByUserId: validOverrideId,
          overrideApprovedAtMs: validOverrideId !== null ? nowMs : null,
          reason: cleanReason,
          clientRequestId: validClientReqId,
          requestHash: incomingRequestHash,
          totalRefund: moneyFromTiyin(totalRefundTiyin),
          totalNetExVat: moneyFromTiyin(totalNetTiyin),
          totalVat: moneyFromTiyin(totalVatTiyin),
          cashRefundAmount: resolvedPayments.cashRefundAmount,
          nonCashRefundAmount: resolvedPayments.nonCashRefundAmount,
          debtOffsetAmount: resolvedPayments.debtOffsetAmount,
        },
        eventType: 'return.created',
        schemaVersion: 1,
      });
      const returnId = returnWrite.entityId;

      const insertedLines: (typeof returnLines.$inferSelect)[] = [];
      for (const planned of plannedLines) {
        if (planned.stockLegs.length > 0 && planned.origLine.productId !== null) {
          applyReturnStockMoveSync(session, {
            organizationId: ctx.organizationId,
            storeId: ctx.storeId,
            productId: planned.origLine.productId,
            variantId: planned.origLine.variantId,
            legs: planned.stockLegs,
            fallbackBatchNumber: `RET-${planned.origLine.id}`,
            sourceId: returnId,
            note: `Return ${returnCode} (${saleRow.receiptCode})`,
            actorUserId: validActorId,
            sessionPoolCache,
          });
        }

        const lineWrite = insertFact(session, returnLines, {
          organizationId: ctx.organizationId,
          storeId: ctx.storeId,
          values: {
            returnId,
            saleId: saleRow.id,
            saleLineId: planned.origLine.id,
            sortOrder: planned.sortOrder,
            lineKind: planned.origLine.lineKind,
            productId: planned.origLine.productId,
            variantId: planned.origLine.variantId,
            itemName: planned.origLine.itemName,
            unit: planned.origLine.unit,
            qty: planned.qty,
            unitPriceSnapshot: planned.origLine.unitPriceSnapshot,
            vatRateBpSnapshot: planned.origLine.vatRateBpSnapshot,
            mxikSnapshot: planned.origLine.mxikSnapshot,
            packageCodeSnapshot: planned.origLine.packageCodeSnapshot,
            refundAmount: planned.refundAmount,
            netExVat: planned.netExVat,
            vatTotal: planned.vatTotal,
            costValue: planned.costValue,
          },
          eventType: 'return_line.created',
          schemaVersion: 1,
        });
        insertedLines.push(lineWrite.row);
      }

      const insertedPayments: (typeof returnPayments.$inferSelect)[] = [];
      for (const rp of resolvedPayments.payments) {
        const payWrite = insertFact(session, returnPayments, {
          organizationId: ctx.organizationId,
          storeId: ctx.storeId,
          values: {
            returnId,
            saleId: saleRow.id,
            method: rp.method,
            amount: rp.amount,
            providerRef: rp.providerRef,
          },
          eventType: 'return_payment.created',
          schemaVersion: 1,
        });
        insertedPayments.push(payWrite.row);
      }

      if (cashRefundTiyin > 0n) {
        insertFact(session, cashMoves, {
          organizationId: ctx.organizationId,
          storeId: ctx.storeId,
          values: {
            shiftId: activeShift.shift.id,
            shiftCashierSessionId: activeShift.activeSession.id,
            type: 'refund_cash_out',
            amountDelta: negateMoney(resolvedPayments.cashRefundAmount),
            sourceType: 'return',
            sourceId: returnId,
            paymentId: null,
            expenseCategory: null,
            reason: `Return ${returnCode}: ${cleanReason}`,
            createdByUserId: validActorId,
          },
          eventType: 'cash_move.created',
          schemaVersion: 1,
        });
      }

      if (
        debtContext !== null &&
        moneyToTiyin(resolvedPayments.debtOffsetAmount) > 0n &&
        saleRow.customerId !== null
      ) {
        applyReturnDebtOffsetInTxSync(session, {
          organizationId: ctx.organizationId,
          storeId: ctx.storeId,
          customerId: saleRow.customerId,
          saleId: saleRow.id,
          returnId,
          debtOffsetAmount: resolvedPayments.debtOffsetAmount,
          currentBalance: debtContext.currentBalance,
          remainingSaleDebt: debtContext.remainingSaleDebt,
          reason: `Return ${returnCode}: ${cleanReason}`,
          actorUserId: validActorId,
          nowMs,
        });
      }

      this.testHooks?.onBeforeCommit?.();

      return Promise.resolve({
        returnDoc: toStoredReturnRecord(returnWrite.row, insertedLines, insertedPayments),
        idempotentReplay: false,
      });
    });
  }

  private loadReturnRecordSync(
    db: BetterSQLite3Database,
    row: typeof returns.$inferSelect,
  ): StoredReturnRecord {
    const lineRows = db
      .select()
      .from(returnLines)
      .where(eq(returnLines.returnId, row.id))
      .orderBy(asc(returnLines.sortOrder))
      .all();
    const payRows = db
      .select()
      .from(returnPayments)
      .where(eq(returnPayments.returnId, row.id))
      .orderBy(asc(returnPayments.createdAtMs))
      .all();
    return toStoredReturnRecord(row, lineRows, payRows);
  }

  async getReturnById(returnId: UuidV7): Promise<StoredReturnRecord | null> {
    const ctx = this.requireContext();
    const validId = parseUuidV7(returnId);
    return runConnectionReadOnly(this.connection, () => {
      const row = this.connection.db
        .select()
        .from(returns)
        .where(
          and(
            eq(returns.id, validId),
            eq(returns.organizationId, ctx.organizationId),
            eq(returns.storeId, ctx.storeId),
          ),
        )
        .limit(1)
        .all()[0];
      return Promise.resolve(row ? this.loadReturnRecordSync(this.connection.db, row) : null);
    });
  }

  async listSaleReturns(saleId: UuidV7): Promise<readonly StoredReturnRecord[]> {
    const ctx = this.requireContext();
    const validSaleId = parseUuidV7(saleId);
    return runConnectionReadOnly(this.connection, () => {
      const saleExists = this.connection.db
        .select({ id: sales.id })
        .from(sales)
        .where(
          and(
            eq(sales.id, validSaleId),
            eq(sales.organizationId, ctx.organizationId),
            eq(sales.storeId, ctx.storeId),
          ),
        )
        .limit(1)
        .all()[0];
      if (!saleExists) {
        throw new DomainError('SALE_NOT_FOUND', `Sale "${validSaleId}" was not found`);
      }

      const retRows = this.connection.db
        .select()
        .from(returns)
        .where(
          and(
            eq(returns.organizationId, ctx.organizationId),
            eq(returns.storeId, ctx.storeId),
            eq(returns.saleId, validSaleId),
          ),
        )
        .orderBy(asc(returns.createdAtMs), asc(returns.id))
        .all();

      return Promise.resolve(retRows.map((r) => this.loadReturnRecordSync(this.connection.db, r)));
    });
  }

  /**
   * Computes revenue, net revenue, VAT, COGS, and gross profit strictly from `v_sales_lines` SQLite view
   * (`+` for non-voided sales, `-` for returns, voided sales excluded completely).
   */
  async querySalesLinesReport(filter?: {
    readonly fromMs?: bigint;
    readonly toMs?: bigint;
  }): Promise<SalesLinesReportSummaryRecord> {
    const ctx = this.requireContext();
    return runConnectionReadOnly(this.connection, () => {
      const conditions: string[] = ['"organization_id" = ?', '"store_id" = ?'];
      const bindings: (string | bigint)[] = [ctx.organizationId, ctx.storeId];

      if (filter?.fromMs !== undefined) {
        conditions.push('"event_at_ms" >= ?');
        bindings.push(filter.fromMs);
      }
      if (filter?.toMs !== undefined) {
        conditions.push('"event_at_ms" <= ?');
        bindings.push(filter.toMs);
      }

      const stmt = this.connection.sqlite.prepare<
        (string | bigint)[],
        {
          readonly signed_qty: bigint;
          readonly signed_final_total: bigint;
          readonly signed_net_ex_vat: bigint;
          readonly signed_vat_total: bigint;
          readonly signed_cost_value: bigint;
        }
      >(
        `
        SELECT
          "signed_qty",
          "signed_final_total",
          "signed_net_ex_vat",
          "signed_vat_total",
          "signed_cost_value"
        FROM "v_sales_lines"
        WHERE ${conditions.join(' AND ')}
        `,
      );

      let lineCount = 0;
      let signedQtyTotal = 0n;
      let revenueTiyin = 0n;
      let netTiyin = 0n;
      let vatTiyin = 0n;
      let costTiyin = 0n;

      for (const row of stmt.iterate(...bindings)) {
        lineCount += 1;
        signedQtyTotal += row.signed_qty;
        revenueTiyin += row.signed_final_total;
        netTiyin += row.signed_net_ex_vat;
        vatTiyin += row.signed_vat_total;
        costTiyin += row.signed_cost_value;
      }

      return Promise.resolve({
        lineCount,
        signedQtyTotal,
        revenue: moneyFromTiyin(revenueTiyin),
        netRevenue: moneyFromTiyin(netTiyin),
        vatTotal: moneyFromTiyin(vatTiyin),
        costValue: moneyFromTiyin(costTiyin),
        grossProfit: moneyFromTiyin(netTiyin - costTiyin),
      });
    });
  }
}

export function createSqliteReturnStore(
  options: CreateSqliteReturnStoreOptions,
): SqliteReturnStore {
  return new SqliteReturnStore(options);
}
