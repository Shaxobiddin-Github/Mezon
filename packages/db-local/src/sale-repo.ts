import { createHash } from 'node:crypto';
import {
  type CartLineKind,
  type DeliverSalePaymentInput,
  DomainError,
  MAX_MONEY_TIYIN,
  type ManualDiscountMode,
  type Money,
  type NegativeStockPolicy,
  type ProductUnit,
  type Quantity,
  type SalePaymentInput,
  type SalePaymentMethod,
  type UnixMs,
  type UuidV7,
  ZERO_MONEY,
  assertCartDiscountAuthorized,
  canonicalizeCompleteSaleRequest,
  formatReceiptCode,
  moneyFromTiyin,
  moneyToTiyin,
  negateMoney,
  parseNegativeStockPolicy,
  parseProductUnit,
  parseSalePaymentMethod,
  parseUuidV7,
  quantityFromMilli,
  quantityToMilli,
  resolveSalePayments,
  validateSalePaymentsInvariant,
} from '@mezon/domain';
import { and, asc, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  evaluateCartRowInDbSync,
  readCartLineRowsInDbSync,
  requireCartRowInDbSync,
} from './cart-repo.js';
import type { LocalSqliteConnection } from './connection.js';
import {
  type StoredCashMoveRecord,
  prepareCustomerForSaleInTxSync,
  recordSaleDebtInTxSync,
} from './customer-repo.js';
import { advanceReceiptSeqSync } from './device-state.js';
import {
  cashMoves,
  localCarts,
  payments,
  products,
  productVariants,
  saleLines,
  sales,
} from './schema/index.js';
import {
  type ActiveShiftSessionContext,
  getActiveShiftDrawerBalanceSync,
  getActiveStoreCashBalanceSync,
  requireOpenShiftSessionSync,
} from './shift-repo.js';
import {
  type StockMoveWarningRecord,
  type StockPoolPrefetchTarget,
  applyOutboundStockMoveSync,
  prefetchMutablePoolStatesSync,
  stockPoolKey,
} from './stock-repo.js';
import {
  type SqliteUnitOfWork,
  type SqliteUnitOfWorkSession,
  runConnectionReadOnly,
} from './uow.js';
import { insertFact, insertMonotone } from './writers.js';

export interface SaleRuntimeContext {
  readonly uow: SqliteUnitOfWork;
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7;
}

/**
 * Test-only fault-injection hooks for verifying crash atomicity in isolated tests.
 * SECURITY / C1 INVARIANT:
 * - Never read from `process.env`, CLI flags, or global singletons.
 * - Never passed by Hub (`apps/hub`) or Electron (`apps/desktop`) in production binaries.
 * - Only active when a test explicitly injects `__testHooks` into `createSqliteSaleStore(...)`.
 */
export interface SaleStoreTestHooks {
  readonly onBeforeCommit?: () => void;
}

export interface CreateSqliteSaleStoreOptions {
  readonly connection: LocalSqliteConnection;
  readonly getRuntimeContext: () => SaleRuntimeContext | null;
  /** Test-only hook object (`C1`). Must never be wired in Hub/Electron production code. */
  readonly __testHooks?: SaleStoreTestHooks;
}

export interface CompleteSaleInput {
  readonly cartId: UuidV7;
  readonly actorUserId: UuidV7;
  readonly clientRequestId: UuidV7;
  readonly expectedTotal: Money;
  readonly debtAmount?: Money;
  readonly customerId?: UuidV7 | null;
  readonly dueDays?: number | null;
  readonly creditOverrideApprovedByUserId?: UuidV7 | null;
  readonly payments: readonly SalePaymentInput[];
}

export interface StoredSaleLineRecord {
  readonly id: UuidV7;
  readonly sortOrder: number;
  readonly lineKind: CartLineKind;
  readonly productId: UuidV7 | null;
  readonly variantId: UuidV7 | null;
  readonly categoryIdSnapshot: UuidV7 | null;
  readonly itemName: string;
  readonly unit: ProductUnit;
  readonly qty: Quantity;
  readonly unitPriceSnapshot: Money;
  readonly appliedPromotionId: UuidV7 | null;
  readonly appliedPromotionName: string | null;
  readonly freeUnits: number;
  readonly grossTotal: Money;
  readonly promoDiscount: Money;
  readonly subtotalAfterPromo: Money;
  readonly allocatedOrderDiscount: Money;
  readonly finalTotal: Money;
  readonly vatRateBpSnapshot: number;
  readonly netExVat: Money;
  readonly vatTotal: Money;
  readonly mxikSnapshot: string | null;
  readonly packageCodeSnapshot: string | null;
  /** Snapshotted COGS from stock moves (`stock_moves.cost_value_delta`); excluded from cashier DTOs. */
  readonly costValue: Money;
}

export interface StoredSalePaymentRecord {
  readonly id: UuidV7;
  readonly method: SalePaymentMethod;
  readonly amount: Money;
  readonly tenderedAmount: Money | null;
  readonly changeAmount: Money;
  readonly providerRef: string | null;
  readonly createdAtMs: UnixMs;
}

export type { StoredCashMoveRecord };

export interface StoredSaleRecord {
  readonly id: UuidV7;
  readonly receiptNo: bigint;
  readonly receiptCode: string;
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7;
  readonly deviceId: UuidV7;
  readonly sourceCartId: UuidV7 | null;
  readonly sourceOrderId: UuidV7 | null;
  readonly cashierUserId: UuidV7;
  readonly completedByUserId: UuidV7;
  readonly customerId: UuidV7 | null;
  readonly shiftId: UuidV7 | null;
  readonly shiftCashierSessionId: UuidV7 | null;
  readonly clientRequestId: UuidV7;
  readonly status: 'completed';
  readonly subtotalGross: Money;
  readonly totalPromoDiscount: Money;
  readonly subtotalAfterPromo: Money;
  readonly manualDiscountMode: ManualDiscountMode;
  readonly manualDiscountValue: bigint;
  readonly manualDiscountReason: string | null;
  readonly orderDiscountAmount: Money;
  readonly totalFinal: Money;
  readonly totalNetExVat: Money;
  readonly totalVat: Money;
  readonly totalPaid: Money;
  readonly debtAmount: Money;
  readonly changeAmount: Money;
  readonly overrideApprovedByUserId: UuidV7 | null;
  readonly overrideApprovedAmount: Money | null;
  readonly overrideApprovedAtMs: UnixMs | null;
  readonly createdAtMs: UnixMs;
  readonly lines: readonly StoredSaleLineRecord[];
  readonly payments: readonly StoredSalePaymentRecord[];
}

export interface CompleteSaleOutcome {
  readonly sale: StoredSaleRecord;
  readonly warnings: readonly StockMoveWarningRecord[];
  readonly idempotentReplay: boolean;
}

function computeCompleteSaleRequestHash(params: {
  readonly cartId: UuidV7;
  readonly expectedTotal: Money;
  readonly debtAmount: Money;
  readonly customerId: UuidV7 | null;
  readonly dueDays?: number | null;
  readonly payments: readonly SalePaymentInput[];
}): string {
  const canonical = canonicalizeCompleteSaleRequest(params);
  return createHash('sha256').update(canonical).digest('hex');
}

interface SerializedWarningJson {
  readonly code: 'NEGATIVE_STOCK';
  readonly productId: string;
  readonly variantId: string | null;
  readonly deficitQty: string;
}

function serializeWarnings(warnings: readonly StockMoveWarningRecord[]): string | null {
  if (warnings.length === 0) {
    return null;
  }
  const dto: SerializedWarningJson[] = warnings.map((w) => ({
    code: w.code,
    productId: w.productId,
    variantId: w.variantId,
    deficitQty: quantityToMilli(w.deficitQty).toString(),
  }));
  return JSON.stringify(dto);
}

function deserializeWarnings(rawJson: string | null): StockMoveWarningRecord[] {
  if (!rawJson) {
    return [];
  }
  const parsed = JSON.parse(rawJson) as readonly SerializedWarningJson[];
  return parsed.map((item) => ({
    code: item.code,
    productId: parseUuidV7(item.productId),
    variantId: item.variantId !== null ? parseUuidV7(item.variantId) : null,
    deficitQty: quantityFromMilli(BigInt(item.deficitQty)),
  }));
}

export function toStoredSaleLine(row: typeof saleLines.$inferSelect): StoredSaleLineRecord {
  return {
    id: row.id,
    sortOrder: row.sortOrder,
    lineKind: row.lineKind as CartLineKind,
    productId: row.productId,
    variantId: row.variantId,
    categoryIdSnapshot: row.categoryIdSnapshot,
    itemName: row.itemName,
    unit: parseProductUnit(row.unit),
    qty: row.qty,
    unitPriceSnapshot: row.unitPriceSnapshot,
    appliedPromotionId: row.appliedPromotionId,
    appliedPromotionName: row.appliedPromotionName,
    freeUnits: Number(row.freeUnits),
    grossTotal: row.grossTotal,
    promoDiscount: row.promoDiscount,
    subtotalAfterPromo: row.subtotalAfterPromo,
    allocatedOrderDiscount: row.allocatedOrderDiscount,
    finalTotal: row.finalTotal,
    vatRateBpSnapshot: row.vatRateBpSnapshot,
    netExVat: row.netExVat,
    vatTotal: row.vatTotal,
    mxikSnapshot: row.mxikSnapshot,
    packageCodeSnapshot: row.packageCodeSnapshot,
    costValue: row.costValue,
  };
}

export function toStoredSalePayment(row: typeof payments.$inferSelect): StoredSalePaymentRecord {
  return {
    id: row.id,
    method: parseSalePaymentMethod(row.method),
    amount: row.amount,
    tenderedAmount: row.tenderedAmount,
    changeAmount: row.changeAmount,
    providerRef: row.providerRef,
    createdAtMs: row.createdAtMs,
  };
}

export function toStoredSale(
  row: typeof sales.$inferSelect,
  lineRows: readonly (typeof saleLines.$inferSelect)[],
  paymentRows: readonly (typeof payments.$inferSelect)[],
): StoredSaleRecord {
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
    status: 'completed',
    subtotalGross: row.subtotalGross,
    totalPromoDiscount: row.totalPromoDiscount,
    subtotalAfterPromo: row.subtotalAfterPromo,
    manualDiscountMode: row.manualDiscountMode as ManualDiscountMode,
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
    lines: lineRows.map(toStoredSaleLine),
    payments: paymentRows.map(toStoredSalePayment),
  };
}

/**
 * Historical cumulative cash ledger sum for a terminal (`cash_moves` only).
 * WARNING (T1.9 X1): NEVER use this for active drawer cash sufficiency or current drawer balance;
 * active drawer cash (`openingCash + shift cash moves`) comes from `getActiveShiftDrawerBalanceSync`.
 */
export function getHistoricalCashMovesTotalSync(
  db: BetterSQLite3Database,
  params: {
    readonly organizationId: UuidV7;
    readonly storeId: UuidV7;
    readonly deviceId: UuidV7;
  },
): Money {
  const rows = db
    .select({ amountDelta: cashMoves.amountDelta })
    .from(cashMoves)
    .where(
      and(
        eq(cashMoves.organizationId, parseUuidV7(params.organizationId)),
        eq(cashMoves.storeId, parseUuidV7(params.storeId)),
        eq(cashMoves.deviceId, parseUuidV7(params.deviceId)),
      ),
    )
    .all();

  let totalTiyin = 0n;
  for (const row of rows) {
    totalTiyin += moneyToTiyin(row.amountDelta);
  }
  return moneyFromTiyin(totalTiyin);
}

/**
 * Historical cumulative cash ledger sum across a store (`cash_moves` only).
 * WARNING (T1.9 X1): Use `getActiveStoreCashBalanceSync` for active store drawer cash.
 */
export function getHistoricalStoreCashMovesTotalSync(
  db: BetterSQLite3Database,
  params: {
    readonly organizationId: UuidV7;
    readonly storeId: UuidV7;
  },
): Money {
  const rows = db
    .select({ amountDelta: cashMoves.amountDelta })
    .from(cashMoves)
    .where(
      and(
        eq(cashMoves.organizationId, parseUuidV7(params.organizationId)),
        eq(cashMoves.storeId, parseUuidV7(params.storeId)),
      ),
    )
    .all();

  let totalTiyin = 0n;
  for (const row of rows) {
    totalTiyin += moneyToTiyin(row.amountDelta);
  }
  return moneyFromTiyin(totalTiyin);
}

export interface SaleCoreEvaluatedLine {
  readonly id: UuidV7;
  readonly sortOrder: number;
  readonly lineKind: CartLineKind;
  readonly productId: UuidV7 | null;
  readonly variantId: UuidV7 | null;
  readonly categoryIdSnapshot: UuidV7 | null;
  readonly name: string;
  readonly unit: ProductUnit;
  readonly qty: Quantity;
  readonly unitPriceSnapshot: Money;
  readonly appliedPromotionId: UuidV7 | null;
  readonly appliedPromotionName: string | null;
  readonly freeUnits: number;
  readonly grossTotal: Money;
  readonly promoDiscount: Money;
  readonly subtotalAfterPromo: Money;
  readonly allocatedOrderDiscount: Money;
  readonly finalTotal: Money;
  readonly vatRateBpSnapshot: number;
  readonly netExVat: Money;
  readonly vatTotal: Money;
  readonly mxikSnapshot: string | null;
  readonly packageCodeSnapshot: string | null;
}

export interface CompleteSaleCoreInTxInput {
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7;
  readonly deviceId: UuidV7;
  readonly nowMs: UnixMs;
  readonly activeShift: ActiveShiftSessionContext;
  readonly sourceCartId: UuidV7 | null;
  readonly sourceOrderId: UuidV7 | null;
  readonly cashierUserId: UuidV7;
  readonly actorUserId: UuidV7;
  readonly clientRequestId: UuidV7;
  readonly requestHash: string;
  readonly expectedTotal: Money;
  readonly debtAmount: Money;
  readonly customerId: UuidV7 | null;
  readonly dueDays: number | null | undefined;
  readonly creditOverrideApprovedByUserId: UuidV7 | null;
  readonly payments: readonly DeliverSalePaymentInput[];
  readonly allowAdvancePayment: boolean;
  readonly negativeStockPolicy: NegativeStockPolicy;
  readonly productsById: ReadonlyMap<UuidV7, typeof products.$inferSelect>;
  readonly variantsById: ReadonlyMap<UuidV7, typeof productVariants.$inferSelect>;
  readonly evaluated: {
    readonly subtotalGross: Money;
    readonly totalPromoDiscount: Money;
    readonly subtotalAfterPromo: Money;
    readonly manualDiscountMode: ManualDiscountMode;
    readonly manualDiscountValue: bigint;
    readonly manualDiscountReason: string | null;
    readonly effectiveOrderDiscount: Money;
    readonly totalFinal: Money;
    readonly totalNetExVat: Money;
    readonly totalVat: Money;
    readonly totalFreeUnits: number;
    readonly exceedsCashierLimit: boolean;
    readonly discountAuthorized: boolean;
    readonly discountOverrideRequired: boolean;
    readonly overrideApprovedByUserId: UuidV7 | null;
    readonly overrideApprovedAmount: Money | null;
    readonly overrideApprovedAtMs: UnixMs | null;
    readonly lines: readonly SaleCoreEvaluatedLine[];
  };
}

export interface CompleteSaleCoreInTxOutcome {
  readonly sale: StoredSaleRecord;
  readonly warnings: readonly StockMoveWarningRecord[];
}

/**
 * Shared atomic receipt completion core (`GEMINI.md` 3.1.9 & 3.1.10).
 * Used identically by POS `completeSale` (re-evaluated cart) and order `deliverOrder`
 * (O2 frozen order snapshot + `'advance'` payment without double `cash_moves` recording).
 */
export function completeSaleCoreInTxSync(
  session: SqliteUnitOfWorkSession,
  input: CompleteSaleCoreInTxInput,
): CompleteSaleCoreInTxOutcome {
  const { evaluated } = input;
  const expectedTiyin = moneyToTiyin(input.expectedTotal);
  if (expectedTiyin < 0n || expectedTiyin > MAX_MONEY_TIYIN) {
    throw new DomainError(
      'VALIDATION_ERROR',
      `expectedTotal must be between 0 and ${MAX_MONEY_TIYIN.toString()} tiyin`,
    );
  }
  const actualTiyin = moneyToTiyin(evaluated.totalFinal);
  if (actualTiyin !== expectedTiyin) {
    throw new DomainError(
      'SALE_TOTAL_CHANGED',
      `Sale total changed from ${expectedTiyin.toString()} to ${actualTiyin.toString()}`,
      {
        details: {
          expectedTotal: expectedTiyin.toString(),
          actualTotal: actualTiyin.toString(),
          subtotalGross: moneyToTiyin(evaluated.subtotalGross).toString(),
          totalPromoDiscount: moneyToTiyin(evaluated.totalPromoDiscount).toString(),
          effectiveOrderDiscount: moneyToTiyin(evaluated.effectiveOrderDiscount).toString(),
        },
      },
    );
  }

  assertCartDiscountAuthorized({
    lines: [],
    subtotalGross: evaluated.subtotalGross,
    totalPromoDiscount: evaluated.totalPromoDiscount,
    subtotalAfterPromo: evaluated.subtotalAfterPromo,
    requestedOrderDiscount: evaluated.effectiveOrderDiscount,
    effectiveOrderDiscount: evaluated.effectiveOrderDiscount,
    totalFinal: evaluated.totalFinal,
    totalNetExVat: evaluated.totalNetExVat,
    totalVat: evaluated.totalVat,
    totalFreeUnits: BigInt(evaluated.totalFreeUnits),
    exceedsCashierLimit: evaluated.exceedsCashierLimit,
    discountAuthorized: evaluated.discountAuthorized,
    discountOverrideRequired: evaluated.discountOverrideRequired,
  });

  // T1.7 customer registry & debt validation + mixed payment resolution + strict invariant check
  const debtTiyin = moneyToTiyin(input.debtAmount);
  if (debtTiyin < 0n || debtTiyin > MAX_MONEY_TIYIN) {
    throw new DomainError(
      'VALIDATION_ERROR',
      `debtAmount must be between 0 and ${MAX_MONEY_TIYIN.toString()} tiyin`,
    );
  }
  if (debtTiyin > 0n && input.customerId === null) {
    throw new DomainError('CUSTOMER_REQUIRED', 'Partial or full debt requires an active customer');
  }

  const resolvedPayments = resolveSalePayments({
    totalFinal: evaluated.totalFinal,
    debtAmount: input.debtAmount,
    customerId: input.customerId,
    allowAdvancePayment: input.allowAdvancePayment,
    payments: input.payments,
  });
  validateSalePaymentsInvariant({
    totalFinal: evaluated.totalFinal,
    debtAmount: input.debtAmount,
    customerId: input.customerId,
    allowAdvancePayment: input.allowAdvancePayment,
    payments: resolvedPayments.payments,
  });

  const customerSalePrep =
    input.customerId !== null
      ? prepareCustomerForSaleInTxSync(session, {
          organizationId: input.organizationId,
          customerId: input.customerId,
          debtAmount: input.debtAmount,
          dueDays: input.dueDays,
          creditOverrideApprovedByUserId: input.creditOverrideApprovedByUserId,
          saleCreatedAtMs: input.nowMs,
        })
      : null;

  // F3 HOOK POINT (`packages/rules`, PF-246 compliance):
  // Evaluate signed legal rule bundle here (banned MXIK cash block, mixed receipt cash ban,
  // 25M UZS limit, prescription/expiry checks) AFTER server totals & payment invariants pass and
  // BEFORE allocating `receipt_no` or modifying inventory/sales/payments/cash_moves.

  // Validate catalog integrity & batch-prefetch full mutable pool states via stock-repo's single loader
  const trackedTargets: StockPoolPrefetchTarget[] = [];

  for (const line of evaluated.lines) {
    if (line.lineKind !== 'catalog' || line.productId === null) {
      continue;
    }
    const prod = input.productsById.get(line.productId);
    if (!prod) {
      throw new DomainError(
        'PRODUCT_NOT_FOUND',
        `Catalog product "${line.productId}" is missing or deleted`,
      );
    }
    if (line.variantId !== null) {
      const variant = input.variantsById.get(line.variantId);
      if (!variant || variant.productId !== prod.id) {
        throw new DomainError(
          'VARIANT_NOT_FOUND',
          `Variant "${line.variantId}" is missing or deleted`,
        );
      }
    }
    if (!prod.unlimited) {
      trackedTargets.push({
        productId: prod.id,
        variantId: line.variantId,
        trackBatches: Boolean(prod.trackBatches),
      });
    }
  }

  const sessionPoolCache = prefetchMutablePoolStatesSync(session, {
    organizationId: input.organizationId,
    storeId: input.storeId,
    targets: trackedTargets,
  });

  // Cumulative check in 'block' mode so ALL short lines (including duplicate-product lines) fail clearly
  if (input.negativeStockPolicy === 'block' && sessionPoolCache.size > 0) {
    const remainingAvailableMilli = new Map<string, bigint>();
    for (const [key, state] of sessionPoolCache.entries()) {
      const onHand = quantityToMilli(state.qtyOnHand);
      remainingAvailableMilli.set(key, onHand > 0n ? onHand : 0n);
    }

    const insufficientLines: {
      readonly cartLineId: string;
      readonly productId: string;
      readonly variantId: string | null;
      readonly itemName: string;
      readonly requestedQty: string;
      readonly availableQty: string;
      readonly deficitQty: string;
    }[] = [];

    for (const line of evaluated.lines) {
      if (line.lineKind !== 'catalog' || line.productId === null) {
        continue;
      }
      const prod = input.productsById.get(line.productId);
      if (!prod || prod.unlimited) {
        continue;
      }
      const key = stockPoolKey(prod.id, line.variantId);
      const avail = remainingAvailableMilli.get(key) ?? 0n;
      const need = quantityToMilli(line.qty);
      if (avail < need) {
        insufficientLines.push({
          cartLineId: line.id,
          productId: prod.id,
          variantId: line.variantId,
          itemName: line.name,
          requestedQty: need.toString(),
          availableQty: avail.toString(),
          deficitQty: (need - avail).toString(),
        });
        remainingAvailableMilli.set(key, 0n);
      } else {
        remainingAvailableMilli.set(key, avail - need);
      }
    }

    if (insufficientLines.length > 0) {
      throw new DomainError(
        'INSUFFICIENT_STOCK',
        `Insufficient stock for ${insufficientLines.length} cart line(s)`,
        { details: { insufficientLines } },
      );
    }
  }

  // Allocate gapless device receipt_no inside same transaction (auto-rolled back on abort)
  const receiptNo = advanceReceiptSeqSync(session.internalGetSqlite(), {
    deviceId: input.deviceId,
    updatedAtMs: input.nowMs,
  });
  const receiptCode = formatReceiptCode(input.deviceId, receiptNo);

  // Insert `sales` (MONOTONE) first so `sale_lines`, `payments`, and `cash_moves` reference valid saleId
  const saleWrite = insertMonotone(session, sales, {
    organizationId: input.organizationId,
    storeId: input.storeId,
    values: {
      receiptNo,
      receiptCode,
      sourceCartId: input.sourceCartId,
      sourceOrderId: input.sourceOrderId,
      cashierUserId: input.cashierUserId,
      completedByUserId: input.actorUserId,
      customerId: input.customerId,
      shiftId: input.activeShift.shift.id,
      shiftCashierSessionId: input.activeShift.activeSession.id,
      clientRequestId: input.clientRequestId,
      requestHash: input.requestHash,
      subtotalGross: evaluated.subtotalGross,
      totalPromoDiscount: evaluated.totalPromoDiscount,
      subtotalAfterPromo: evaluated.subtotalAfterPromo,
      manualDiscountMode: evaluated.manualDiscountMode,
      manualDiscountValue: evaluated.manualDiscountValue,
      manualDiscountReason: evaluated.manualDiscountReason,
      orderDiscountAmount: evaluated.effectiveOrderDiscount,
      totalFinal: evaluated.totalFinal,
      totalNetExVat: evaluated.totalNetExVat,
      totalVat: evaluated.totalVat,
      totalPaid: resolvedPayments.totalPaid,
      debtAmount: resolvedPayments.debtAmount,
      changeAmount: resolvedPayments.changeAmount,
      overrideApprovedByUserId: evaluated.overrideApprovedByUserId,
      overrideApprovedAmount: evaluated.overrideApprovedAmount,
      overrideApprovedAtMs: evaluated.overrideApprovedAtMs,
      voidedAtMs: null,
      voidedByUserId: null,
      voidReason: null,
      voidClientRequestId: null,
      voidRequestHash: null,
    },
    eventType: 'sale.completed',
    schemaVersion: 1,
  });
  const saleId = saleWrite.entityId;

  // Deduct stock (for tracked catalog lines) and insert immutable `sale_lines` (`FACT`)
  const allWarnings: StockMoveWarningRecord[] = [];
  const insertedLines: (typeof saleLines.$inferSelect)[] = [];

  for (const line of evaluated.lines) {
    let lineCostTiyin = 0n;

    if (line.lineKind === 'catalog' && line.productId !== null) {
      const prod = input.productsById.get(line.productId)!;
      if (!prod.unlimited) {
        const stockOut = applyOutboundStockMoveSync(session, {
          organizationId: input.organizationId,
          storeId: input.storeId,
          productId: prod.id,
          variantId: line.variantId,
          reason: 'sale',
          needQty: line.qty,
          overridePolicy: input.negativeStockPolicy,
          sourceType: 'sale',
          sourceId: saleId,
          note: `Sale receipt ${receiptCode}`,
          actorUserId: input.actorUserId,
          prefetchedProduct: prod,
          sessionPoolCache,
        });
        for (const m of stockOut.moves) {
          lineCostTiyin += -moneyToTiyin(m.costValueDelta);
        }
        allWarnings.push(...stockOut.warnings);
      }
    }

    const lineWrite = insertFact(session, saleLines, {
      organizationId: input.organizationId,
      storeId: input.storeId,
      values: {
        saleId,
        sortOrder: line.sortOrder,
        lineKind: line.lineKind,
        productId: line.productId,
        variantId: line.variantId,
        categoryIdSnapshot: line.categoryIdSnapshot,
        itemName: line.name,
        unit: line.unit,
        qty: line.qty,
        unitPriceSnapshot: line.unitPriceSnapshot,
        appliedPromotionId: line.appliedPromotionId,
        appliedPromotionName: line.appliedPromotionName,
        freeUnits: BigInt(line.freeUnits),
        grossTotal: line.grossTotal,
        promoDiscount: line.promoDiscount,
        subtotalAfterPromo: line.subtotalAfterPromo,
        allocatedOrderDiscount: line.allocatedOrderDiscount,
        finalTotal: line.finalTotal,
        vatRateBpSnapshot: line.vatRateBpSnapshot,
        netExVat: line.netExVat,
        vatTotal: line.vatTotal,
        mxikSnapshot: line.mxikSnapshot,
        packageCodeSnapshot: line.packageCodeSnapshot,
        costValue: moneyFromTiyin(lineCostTiyin),
      },
      eventType: 'sale_line.created',
      schemaVersion: 1,
    });
    insertedLines.push(lineWrite.row);
  }

  // Insert immutable `payments` (`FACT`) & atomic `cash_moves` (`FACT`) — `'advance'` NEVER emits `cash_moves`
  const insertedPayments: (typeof payments.$inferSelect)[] = [];
  for (const item of resolvedPayments.payments) {
    const paymentWrite = insertFact(session, payments, {
      organizationId: input.organizationId,
      storeId: input.storeId,
      values: {
        saleId,
        method: item.method,
        amount: item.amount,
        tenderedAmount: item.tenderedAmount,
        changeAmount: item.changeAmount,
        providerRef: item.providerRef,
        providerMetaJson: null,
      },
      eventType: 'payment.created',
      schemaVersion: 1,
    });
    insertedPayments.push(paymentWrite.row);

    if (item.method === 'cash' && item.tenderedAmount !== null) {
      insertFact(session, cashMoves, {
        organizationId: input.organizationId,
        storeId: input.storeId,
        values: {
          shiftId: input.activeShift.shift.id,
          shiftCashierSessionId: input.activeShift.activeSession.id,
          type: 'sale_cash_in',
          amountDelta: item.tenderedAmount,
          sourceType: 'sale',
          sourceId: saleId,
          paymentId: paymentWrite.entityId,
          expenseCategory: null,
          reason: `Sale receipt ${receiptCode} cash in`,
          createdByUserId: input.actorUserId,
        },
        eventType: 'cash_move.created',
        schemaVersion: 1,
      });

      if (moneyToTiyin(item.changeAmount) > 0n) {
        insertFact(session, cashMoves, {
          organizationId: input.organizationId,
          storeId: input.storeId,
          values: {
            shiftId: input.activeShift.shift.id,
            shiftCashierSessionId: input.activeShift.activeSession.id,
            type: 'sale_change_out',
            amountDelta: negateMoney(item.changeAmount),
            sourceType: 'sale',
            sourceId: saleId,
            paymentId: paymentWrite.entityId,
            expenseCategory: null,
            reason: `Sale receipt ${receiptCode} change out`,
            createdByUserId: input.actorUserId,
          },
          eventType: 'cash_move.created',
          schemaVersion: 1,
        });
      }
    }
  }

  // Record `sale_debt` in `customer_ledger` (`FACT`) & update `local_customer_balances` in the same tx
  if (customerSalePrep !== null && input.customerId !== null && debtTiyin > 0n) {
    recordSaleDebtInTxSync(session, {
      organizationId: input.organizationId,
      storeId: input.storeId,
      customerId: input.customerId,
      saleId,
      debtAmount: resolvedPayments.debtAmount,
      dueAtMs: customerSalePrep.dueAtMs,
      actorUserId: input.actorUserId,
      overrideApprovedByUserId: input.creditOverrideApprovedByUserId,
      nowMs: saleWrite.row.createdAtMs,
    });
  }

  return {
    sale: toStoredSale(saleWrite.row, insertedLines, insertedPayments),
    warnings: allWarnings,
  };
}

export class SqliteSaleStore {
  private readonly connection: LocalSqliteConnection;
  private readonly getRuntimeContext: () => SaleRuntimeContext | null;
  private readonly testHooks?: SaleStoreTestHooks;

  constructor(options: CreateSqliteSaleStoreOptions) {
    this.connection = options.connection;
    this.getRuntimeContext = options.getRuntimeContext;
    this.testHooks = options.__testHooks;
  }

  private requireContext(): SaleRuntimeContext {
    const ctx = this.getRuntimeContext();
    if (ctx === null) {
      throw new DomainError('AUTH_UNAUTHORIZED', 'Hub setup has not been completed');
    }
    return ctx;
  }

  /** Read-only lookup of a completed sale (lines + payments) in the active tenant/store; `null` if absent. */
  async getSaleById(saleId: UuidV7): Promise<StoredSaleRecord | null> {
    const ctx = this.requireContext();
    const validSaleId = parseUuidV7(saleId);
    return runConnectionReadOnly(this.connection, () => {
      const row = this.connection.db
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
      if (!row) {
        return Promise.resolve(null);
      }
      const lineRows = this.connection.db
        .select()
        .from(saleLines)
        .where(eq(saleLines.saleId, row.id))
        .orderBy(asc(saleLines.sortOrder))
        .all();
      const paymentRows = this.connection.db
        .select()
        .from(payments)
        .where(eq(payments.saleId, row.id))
        .orderBy(asc(payments.createdAtMs), asc(payments.id))
        .all();
      return Promise.resolve(toStoredSale(row, lineRows, paymentRows));
    });
  }

  async getTerminalCashBalance(deviceId?: UuidV7): Promise<Money> {
    const ctx = this.requireContext();
    const targetDeviceId = deviceId !== undefined ? parseUuidV7(deviceId) : ctx.uow.deviceId;
    return runConnectionReadOnly(this.connection, () =>
      Promise.resolve(
        getActiveShiftDrawerBalanceSync(this.connection.db, this.connection.sqlite, {
          organizationId: ctx.organizationId,
          storeId: ctx.storeId,
          deviceId: targetDeviceId,
        }),
      ),
    );
  }

  async getStoreCashBalance(): Promise<Money> {
    const ctx = this.requireContext();
    return runConnectionReadOnly(this.connection, () =>
      Promise.resolve(
        getActiveStoreCashBalanceSync(this.connection.db, this.connection.sqlite, {
          organizationId: ctx.organizationId,
          storeId: ctx.storeId,
        }),
      ),
    );
  }

  /**
   * Executes the sole authoritative `completeSale` transaction (`GEMINI.md` 3.1.9–3.1.10):
   * - Idempotency check by `(organization_id, client_request_id)` + `storeId` + `cartId` + `requestHash`.
   * - Re-evaluates cart totals at commit timestamp (`evaluateCartRowInDbSync`) and checks `expectedTotal`.
   * - Enforces cashier/supervisor discount approval (`DISCOUNT_OVERRIDE_REQUIRED`).
   * - Enforces T1.5 debt/customer gates (`CUSTOMER_REQUIRED` on `debt > 0`, `VALIDATION_ERROR` on `customerId !== null`),
   *   resolves mixed payment rows, and runs `validateSalePaymentsInvariant` against server `totalFinal`.
   * - Deducts stock via shared `applyOutboundStockMoveSync` without nested `uow.execute`.
   * - Allocates gapless per-device `receipt_no` atomically (`last_receipt_seq`).
   * - Inserts `sales` (`MONOTONE`), `sale_lines` (`FACT`), `payments` (`FACT`), `cash_moves` (`FACT`),
   *   `stock_moves` (`FACT`), updates `local_carts.status = 'completed'`, and emits all `local_outbox` rows in 1 tx.
   */
  async completeSale(input: CompleteSaleInput): Promise<CompleteSaleOutcome> {
    const ctx = this.requireContext();
    const cartId = parseUuidV7(input.cartId);
    const actorUserId = parseUuidV7(input.actorUserId);
    const clientRequestId = parseUuidV7(input.clientRequestId);
    const debtAmount = input.debtAmount ?? ZERO_MONEY;
    const customerId =
      input.customerId !== undefined && input.customerId !== null
        ? parseUuidV7(input.customerId)
        : null;
    const dueDays = input.dueDays;
    const creditOverrideApprovedByUserId =
      input.creditOverrideApprovedByUserId !== undefined &&
      input.creditOverrideApprovedByUserId !== null
        ? parseUuidV7(input.creditOverrideApprovedByUserId)
        : null;

    const incomingRequestHash = computeCompleteSaleRequestHash({
      cartId,
      expectedTotal: input.expectedTotal,
      debtAmount,
      customerId,
      dueDays,
      payments: input.payments,
    });

    return ctx.uow.execute<CompleteSaleOutcome>((session) => {
      // 1) Idempotent replay lookup inside BEGIN IMMEDIATE (prevents double-click/parallel duplicates
      //    and rejects reusing the same clientRequestId with another store, cart, or differing payload)
      const existingSale = session.db
        .select()
        .from(sales)
        .where(
          and(
            eq(sales.organizationId, ctx.organizationId),
            eq(sales.clientRequestId, clientRequestId),
          ),
        )
        .limit(1)
        .all()[0];

      if (existingSale) {
        if (
          existingSale.storeId !== ctx.storeId ||
          existingSale.sourceCartId !== cartId ||
          existingSale.requestHash !== incomingRequestHash
        ) {
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            `clientRequestId "${clientRequestId}" conflicts with another store, cart, or request payload`,
          );
        }
        const existingLines = session.db
          .select()
          .from(saleLines)
          .where(eq(saleLines.saleId, existingSale.id))
          .orderBy(asc(saleLines.sortOrder))
          .all();
        const existingPayments = session.db
          .select()
          .from(payments)
          .where(eq(payments.saleId, existingSale.id))
          .orderBy(asc(payments.createdAtMs), asc(payments.id))
          .all();
        const sourceCart = session.db
          .select({ completionWarningsJson: localCarts.completionWarningsJson })
          .from(localCarts)
          .where(eq(localCarts.id, cartId))
          .limit(1)
          .all()[0];

        return Promise.resolve({
          sale: toStoredSale(existingSale, existingLines, existingPayments),
          warnings: deserializeWarnings(sourceCart?.completionWarningsJson ?? null),
          idempotentReplay: true,
        });
      }

      // 2) Ensure cart exists in tenant/store and is strictly in 'open' status, then require open shift + cashier session (X2)
      const cartRow = requireCartRowInDbSync(session.db, ctx.organizationId, ctx.storeId, cartId);
      if (cartRow.status !== 'open') {
        throw new DomainError(
          'CART_NOT_OPEN',
          `Cart "${cartId}" is "${cartRow.status}", not "open"`,
        );
      }

      const activeShift = requireOpenShiftSessionSync(session.db, {
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        deviceId: ctx.uow.deviceId,
        actorUserId,
      });

      const rawLines = readCartLineRowsInDbSync(session.db, cartId);
      if (rawLines.length === 0) {
        throw new DomainError('CART_EMPTY', 'Cannot complete sale for an empty cart');
      }

      // 3) Server-side recomputation at current clock time & shared completion core
      const nowMs = session.nowUnixMs();
      const { detail, hubConfig, productsById, variantsById } = evaluateCartRowInDbSync({
        db: session.db,
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        cartRow,
        nowMs,
      });

      const negativeStockPolicy = parseNegativeStockPolicy(hubConfig.negativeStockPolicy);
      const { sale, warnings } = completeSaleCoreInTxSync(session, {
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        deviceId: ctx.uow.deviceId,
        nowMs,
        activeShift,
        sourceCartId: cartId,
        sourceOrderId: null,
        cashierUserId: cartRow.cashierUserId,
        actorUserId,
        clientRequestId,
        requestHash: incomingRequestHash,
        expectedTotal: input.expectedTotal,
        debtAmount,
        customerId,
        dueDays,
        creditOverrideApprovedByUserId,
        payments: input.payments,
        allowAdvancePayment: false,
        negativeStockPolicy,
        productsById,
        variantsById,
        evaluated: {
          subtotalGross: detail.subtotalGross,
          totalPromoDiscount: detail.totalPromoDiscount,
          subtotalAfterPromo: detail.subtotalAfterPromo,
          manualDiscountMode: detail.manualDiscountMode,
          manualDiscountValue: detail.manualDiscountValue,
          manualDiscountReason: detail.manualDiscountReason,
          effectiveOrderDiscount: detail.effectiveOrderDiscount,
          totalFinal: detail.totalFinal,
          totalNetExVat: detail.totalNetExVat,
          totalVat: detail.totalVat,
          totalFreeUnits: detail.totalFreeUnits,
          exceedsCashierLimit: detail.exceedsCashierLimit,
          discountAuthorized: detail.discountAuthorized,
          discountOverrideRequired: detail.discountOverrideRequired,
          overrideApprovedByUserId: detail.overrideApprovedByUserId,
          overrideApprovedAmount: detail.overrideApprovedAmount,
          overrideApprovedAtMs: detail.overrideApprovedAtMs,
          lines: detail.lines,
        },
      });

      // Mark cart `'completed'` inside the same transaction so subsequent conflicting requests get CART_NOT_OPEN
      session.db
        .update(localCarts)
        .set({
          status: 'completed',
          parkedAtMs: null,
          completedSaleId: sale.id,
          completedAtMs: nowMs,
          completionWarningsJson: serializeWarnings(warnings),
          updatedAtMs: nowMs,
        })
        .where(eq(localCarts.id, cartId))
        .run();

      // Test-only crash injection hook (`C1`): never wired in Hub/Electron production binaries
      this.testHooks?.onBeforeCommit?.();

      return Promise.resolve({
        sale,
        warnings,
        idempotentReplay: false,
      });
    });
  }
}

export function createSqliteSaleStore(options: CreateSqliteSaleStoreOptions): SqliteSaleStore {
  return new SqliteSaleStore(options);
}
