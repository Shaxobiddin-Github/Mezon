import {
  type CartLineInput,
  type CartLineKind,
  type CartManualDiscountInput,
  type CashierDiscountPolicy,
  type ManualDiscountMode,
  type PromotionRule,
  assertCartDiscountAuthorized,
  evaluateCart,
} from './cart.js';
import type { ProductUnit } from './catalog.js';
import type { UnixMs } from './clock.js';
import { normalizeCustomerFullName, normalizeCustomerPhone } from './customer.js';
import { DomainError } from './errors.js';
import { MAX_MONEY_TIYIN, type Money, ZERO_MONEY, moneyFromTiyin, moneyToTiyin } from './money.js';
import type { Quantity } from './quantity.js';
import {
  type ReturnPaymentInput,
  createEmptyPaymentMethodMap,
  normalizeMandatoryReason,
} from './return.js';
import {
  type DeliverSalePaymentInput,
  PAYMENT_METHODS,
  type PaymentMethod,
  type ResolvedSalePayments,
  type SalePaymentInput,
  type SalePaymentMethod,
  normalizePaymentProviderRef,
  parsePaymentMethod,
  resolveSalePayments,
  validateSalePaymentsInvariant,
} from './sale.js';
import { type UuidV7, parseUuidV7 } from './uuidv7.js';
import type { VatRate } from './vat.js';

export const ORDER_STATUSES = ['draft', 'confirmed', 'ready', 'delivered', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_OPEN_STATUSES = ['draft', 'confirmed', 'ready'] as const;
export type OrderOpenStatus = (typeof ORDER_OPEN_STATUSES)[number];

export const ORDER_TERMINAL_STATUSES = ['delivered', 'cancelled'] as const;
export type OrderTerminalStatus = (typeof ORDER_TERMINAL_STATUSES)[number];

export const ORDER_PAYMENT_KINDS = ['advance', 'advance_refund'] as const;
export type OrderPaymentKind = (typeof ORDER_PAYMENT_KINDS)[number];

export const MAX_ORDER_NOTE_LENGTH = 500;
export const MAX_ORDER_REASON_LENGTH = 500;

const ALLOWED_ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  draft: ['confirmed', 'cancelled'],
  confirmed: ['ready', 'delivered', 'cancelled'],
  ready: ['delivered', 'cancelled'],
  delivered: [],
  cancelled: [],
};

export interface OrderDraftLineInput extends CartLineInput {
  readonly mxikSnapshot: string | null;
  readonly packageCodeSnapshot: string | null;
  readonly vatRateBpSnapshot: number;
}

export interface EvaluatedOrderLine {
  readonly id: UuidV7;
  readonly lineKind: CartLineKind;
  readonly productId: UuidV7 | null;
  readonly variantId: UuidV7 | null;
  readonly categoryId: UuidV7 | null;
  readonly name: string;
  readonly unit: ProductUnit;
  readonly qty: Quantity;
  readonly unitPriceSnapshot: Money;
  readonly vatRate: VatRate;
  readonly mxikSnapshot: string | null;
  readonly packageCodeSnapshot: string | null;
  readonly vatRateBpSnapshot: number;
  readonly appliedPromotionId: UuidV7 | null;
  readonly appliedPromotionName: string | null;
  readonly freeUnits: bigint;
  readonly grossTotal: Money;
  readonly promoDiscount: Money;
  readonly subtotalAfterPromo: Money;
  readonly allocatedOrderDiscount: Money;
  readonly finalTotal: Money;
  readonly netExVat: Money;
  readonly vatTotal: Money;
}

export interface EvaluatedOrderDraftResult {
  readonly lines: readonly EvaluatedOrderLine[];
  readonly subtotalGross: Money;
  readonly totalPromoDiscount: Money;
  readonly subtotalAfterPromo: Money;
  readonly requestedOrderDiscount: Money;
  readonly effectiveOrderDiscount: Money;
  readonly totalFinal: Money;
  readonly totalNetExVat: Money;
  readonly totalVat: Money;
  readonly totalFreeUnits: bigint;
  readonly exceedsCashierLimit: boolean;
  readonly discountAuthorized: boolean;
  readonly discountOverrideRequired: boolean;
}

export interface OrderPaymentSummaryItem {
  readonly kind: OrderPaymentKind;
  readonly method: PaymentMethod;
  readonly amount: Money;
}

export interface OrderAdvanceSummary {
  readonly totalAdvanceIn: Money;
  readonly totalAdvanceRefunded: Money;
  readonly netAdvance: Money;
  readonly advanceInByMethod: Readonly<Record<PaymentMethod, Money>>;
  readonly advanceRefundedByMethod: Readonly<Record<PaymentMethod, Money>>;
  readonly netAdvanceByMethod: Readonly<Record<PaymentMethod, Money>>;
}

export interface ResolvedOrderAdvanceItem {
  readonly method: PaymentMethod;
  readonly amount: Money;
  readonly tenderedAmount: Money | null;
  readonly changeAmount: Money;
  readonly providerRef: string | null;
}

export interface ResolvedOrderAdvanceRecord {
  readonly items: readonly ResolvedOrderAdvanceItem[];
  readonly addedAdvance: Money;
  readonly nextNetAdvance: Money;
  readonly nextStatus: OrderOpenStatus;
  readonly cashInAmount: Money;
  readonly cashChangeOutAmount: Money;
}

export interface ResolvedOrderAdvanceRefundItem {
  readonly method: PaymentMethod;
  readonly amount: Money;
  readonly providerRef: string | null;
}

export interface ResolvedOrderAdvanceRefund {
  readonly items: readonly ResolvedOrderAdvanceRefundItem[];
  readonly totalRefund: Money;
  readonly cashRefundAmount: Money;
  readonly nonCashRefundAmount: Money;
  readonly nextNetAdvance: Money;
}

export interface OpenAdvancesAccountingEntry {
  readonly orderStatus: OrderStatus;
  readonly kind: OrderPaymentKind;
  readonly method: PaymentMethod;
  readonly amount: Money;
}

export interface OpenAdvancesSummary {
  readonly totalOpenAdvance: Money;
  readonly byMethod: Readonly<Record<PaymentMethod, Money>>;
  readonly totalAdvanceIn: Money;
  readonly totalAdvanceRefunded: Money;
  readonly totalAdvanceAppliedAtDelivery: Money;
}

function assertBoundedPositive(tiyin: bigint, label: string): void {
  if (tiyin <= 0n || tiyin > MAX_MONEY_TIYIN) {
    throw new DomainError(
      'VALIDATION_ERROR',
      `${label} must be between 1 and ${MAX_MONEY_TIYIN.toString()} tiyin`,
    );
  }
}

export function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === 'string' && (ORDER_STATUSES as readonly string[]).includes(value);
}

export function parseOrderStatus(value: unknown): OrderStatus {
  if (!isOrderStatus(value)) {
    throw new DomainError('VALIDATION_ERROR', `Invalid order status: "${String(value)}"`);
  }
  return value;
}

export function isOrderPaymentKind(value: unknown): value is OrderPaymentKind {
  return typeof value === 'string' && (ORDER_PAYMENT_KINDS as readonly string[]).includes(value);
}

export function parseOrderPaymentKind(value: unknown): OrderPaymentKind {
  if (!isOrderPaymentKind(value)) {
    throw new DomainError('VALIDATION_ERROR', `Invalid order payment kind: "${String(value)}"`);
  }
  return value;
}

export function isOrderOpenStatus(status: OrderStatus): status is OrderOpenStatus {
  return status === 'draft' || status === 'confirmed' || status === 'ready';
}

export function canTransitionOrderStatus(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED_ORDER_TRANSITIONS[from].includes(to);
}

export function assertOrderTransition(from: OrderStatus, to: OrderStatus): OrderStatus {
  if (!canTransitionOrderStatus(from, to)) {
    throw new DomainError(
      'ORDER_INVALID_TRANSITION',
      `Invalid order state transition from "${from}" to "${to}"`,
    );
  }
  return to;
}

export function assertOrderOpenStatus(status: OrderStatus): OrderOpenStatus {
  if (!isOrderOpenStatus(status)) {
    throw new DomainError(
      'ORDER_INVALID_TRANSITION',
      `Order is in terminal status "${status}" and cannot be modified`,
    );
  }
  return status;
}

export function formatOrderCode(deviceId: UuidV7, orderNo: bigint): string {
  const validDeviceId = parseUuidV7(deviceId);
  if (orderNo < 1n) {
    throw new DomainError('VALIDATION_ERROR', 'orderNo must be a positive integer >= 1');
  }
  const deviceSuffix = validDeviceId.slice(-4).toUpperCase();
  const seqText = orderNo.toString().padStart(6, '0');
  return `ORD-${deviceSuffix}-${seqText}`;
}

export function normalizeOrderNote(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'string') {
    throw new DomainError('VALIDATION_ERROR', 'Order note must be a string or null');
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > MAX_ORDER_NOTE_LENGTH) {
    throw new DomainError(
      'VALIDATION_ERROR',
      `Order note must not exceed ${String(MAX_ORDER_NOTE_LENGTH)} characters`,
    );
  }
  return trimmed;
}

export function normalizeOrderCustomerSnapshot(params: {
  readonly customerName: string;
  readonly customerPhone?: string | null;
}): {
  readonly customerName: string;
  readonly customerPhoneNormalized: string | null;
} {
  const normalizedName = normalizeCustomerFullName(params.customerName);
  const normalizedPhone = normalizeCustomerPhone(params.customerPhone ?? null);
  return {
    customerName: normalizedName,
    customerPhoneNormalized: normalizedPhone?.phoneNormalized ?? null,
  };
}

export function normalizeMandatoryOrderReason(
  raw: string | null | undefined,
  label = 'reason',
): string {
  if (typeof raw !== 'string') {
    throw new DomainError('VALIDATION_ERROR', `${label} must be a non-empty string`);
  }
  return normalizeMandatoryReason(raw, label);
}

/**
 * O3: Evaluates a customer order draft ONCE at creation time by delegating to T1.3 `evaluateCart`
 * (automatic promotions, pro-rata `allocate` manual discount, VAT calculation, and cashier limit /
 * supervisor approval enforcement). The evaluated snapshot is frozen onto `order_lines` and reused
 * verbatim by `deliverOrder` without re-pricing (O2).
 */
export function evaluateOrderDraft(params: {
  readonly storeId: UuidV7;
  readonly nowMs: UnixMs;
  readonly lines: readonly OrderDraftLineInput[];
  readonly promotions: readonly PromotionRule[];
  readonly manualDiscount: CartManualDiscountInput;
  readonly policy: CashierDiscountPolicy;
  readonly overrideApprovedByUserId: UuidV7 | null;
  readonly overrideApprovedAmount: Money | null;
}): EvaluatedOrderDraftResult {
  if (params.lines.length === 0) {
    throw new DomainError('ORDER_EMPTY', 'Cannot create an order without lines');
  }

  const evaluated = evaluateCart({
    storeId: params.storeId,
    nowMs: params.nowMs,
    lines: params.lines,
    promotions: params.promotions,
    manualDiscount: params.manualDiscount,
    policy: params.policy,
    overrideApprovedByUserId: params.overrideApprovedByUserId,
    overrideApprovedAmount: params.overrideApprovedAmount,
  });

  assertCartDiscountAuthorized(evaluated);

  const lines: EvaluatedOrderLine[] = evaluated.lines.map((line, idx) => {
    const src = params.lines[idx];
    if (!src) {
      throw new DomainError('VALIDATION_ERROR', 'Order line alignment mismatch during evaluation');
    }
    return {
      ...line,
      mxikSnapshot: src.mxikSnapshot,
      packageCodeSnapshot: src.packageCodeSnapshot,
      vatRateBpSnapshot: src.vatRateBpSnapshot,
    };
  });

  return {
    lines,
    subtotalGross: evaluated.subtotalGross,
    totalPromoDiscount: evaluated.totalPromoDiscount,
    subtotalAfterPromo: evaluated.subtotalAfterPromo,
    requestedOrderDiscount: evaluated.requestedOrderDiscount,
    effectiveOrderDiscount: evaluated.effectiveOrderDiscount,
    totalFinal: evaluated.totalFinal,
    totalNetExVat: evaluated.totalNetExVat,
    totalVat: evaluated.totalVat,
    totalFreeUnits: evaluated.totalFreeUnits,
    exceedsCashierLimit: evaluated.exceedsCashierLimit,
    discountAuthorized: evaluated.discountAuthorized,
    discountOverrideRequired: evaluated.discountOverrideRequired,
  };
}

/**
 * Aggregates advance receipts and advance refunds across an order's payment ledger (`order_payments`).
 */
export function summarizeOrderPayments(
  rows: readonly OrderPaymentSummaryItem[],
): OrderAdvanceSummary {
  const inByMethod: Record<PaymentMethod, bigint> = {
    cash: 0n,
    card: 0n,
    uzqr: 0n,
    payme: 0n,
    click: 0n,
    uzum: 0n,
    social_card: 0n,
    other: 0n,
  };
  const refundByMethod: Record<PaymentMethod, bigint> = {
    cash: 0n,
    card: 0n,
    uzqr: 0n,
    payme: 0n,
    click: 0n,
    uzum: 0n,
    social_card: 0n,
    other: 0n,
  };

  let totalInTiyin = 0n;
  let totalRefundTiyin = 0n;

  for (const row of rows) {
    const kind = parseOrderPaymentKind(row.kind);
    const method = parsePaymentMethod(row.method);
    const amt = moneyToTiyin(row.amount);
    assertBoundedPositive(amt, `orderPayment.${method}.amount`);
    if (kind === 'advance') {
      inByMethod[method] += amt;
      totalInTiyin += amt;
    } else {
      refundByMethod[method] += amt;
      totalRefundTiyin += amt;
    }
  }

  const advanceInByMethod = createEmptyPaymentMethodMap();
  const advanceRefundedByMethod = createEmptyPaymentMethodMap();
  const netAdvanceByMethod = createEmptyPaymentMethodMap();

  for (const method of PAYMENT_METHODS) {
    const inAmt = inByMethod[method];
    const refAmt = refundByMethod[method];
    if (refAmt > inAmt) {
      throw new DomainError(
        'ORDER_ADVANCE_REFUND_EXCEEDED',
        `Refunded advance (${refAmt.toString()}) exceeds received advance (${inAmt.toString()}) for "${method}"`,
      );
    }
    advanceInByMethod[method] = moneyFromTiyin(inAmt);
    advanceRefundedByMethod[method] = moneyFromTiyin(refAmt);
    netAdvanceByMethod[method] = moneyFromTiyin(inAmt - refAmt);
  }

  return {
    totalAdvanceIn: moneyFromTiyin(totalInTiyin),
    totalAdvanceRefunded: moneyFromTiyin(totalRefundTiyin),
    netAdvance: moneyFromTiyin(totalInTiyin - totalRefundTiyin),
    advanceInByMethod,
    advanceRefundedByMethod,
    netAdvanceByMethod,
  };
}

/**
 * Validates and resolves an advance payment deposit onto an open order (`draft | confirmed | ready`).
 * Enforces `netAdvance + addedAdvance <= orderTotalAmount` (`ORDER_ADVANCE_EXCEEDS_TOTAL`) and
 * auto-transitions `draft -> confirmed`.
 */
export function resolveRecordOrderAdvance(params: {
  readonly orderStatus: OrderStatus;
  readonly orderTotalAmount: Money;
  readonly existingNetAdvance: Money;
  readonly payments: readonly SalePaymentInput[];
}): ResolvedOrderAdvanceRecord {
  const openStatus = assertOrderOpenStatus(params.orderStatus);
  const orderTotalTiyin = moneyToTiyin(params.orderTotalAmount);
  const existingTiyin = moneyToTiyin(params.existingNetAdvance);

  const rawPayments: unknown = params.payments;
  if (!Array.isArray(rawPayments) || params.payments.length === 0) {
    throw new DomainError('VALIDATION_ERROR', 'At least one advance payment row is required');
  }

  let cashCount = 0;
  let addedTiyin = 0n;
  let cashInTiyin = 0n;
  let cashChangeOutTiyin = 0n;
  const items: ResolvedOrderAdvanceItem[] = [];

  for (const row of params.payments) {
    parsePaymentMethod(row.method);
    if (row.method === 'cash') {
      cashCount += 1;
      if (cashCount > 1) {
        throw new DomainError(
          'VALIDATION_ERROR',
          'At most one cash row is allowed per advance deposit',
        );
      }
      const tenderedTiyin = moneyToTiyin(row.tenderedAmount);
      assertBoundedPositive(tenderedTiyin, 'cash.tenderedAmount');
      const appliedTiyin = row.amount !== undefined ? moneyToTiyin(row.amount) : tenderedTiyin;
      assertBoundedPositive(appliedTiyin, 'cash.amount');
      if (appliedTiyin > tenderedTiyin) {
        throw new DomainError(
          'VALIDATION_ERROR',
          'Cash advance amount cannot exceed tenderedAmount',
        );
      }
      const changeTiyin = tenderedTiyin - appliedTiyin;
      items.push({
        method: 'cash',
        amount: moneyFromTiyin(appliedTiyin),
        tenderedAmount: row.tenderedAmount,
        changeAmount: moneyFromTiyin(changeTiyin),
        providerRef: null,
      });
      addedTiyin += appliedTiyin;
      cashInTiyin = tenderedTiyin;
      cashChangeOutTiyin = changeTiyin;
    } else {
      const amt = moneyToTiyin(row.amount);
      assertBoundedPositive(amt, `${row.method}.amount`);
      const ref = normalizePaymentProviderRef(row.providerRef);
      items.push({
        method: row.method,
        amount: row.amount,
        tenderedAmount: null,
        changeAmount: ZERO_MONEY,
        providerRef: ref,
      });
      addedTiyin += amt;
    }
  }

  const nextNetTiyin = existingTiyin + addedTiyin;
  if (nextNetTiyin > MAX_MONEY_TIYIN) {
    throw new DomainError('VALIDATION_ERROR', 'Net advance exceeds MAX_MONEY_TIYIN');
  }
  if (nextNetTiyin > orderTotalTiyin) {
    throw new DomainError(
      'ORDER_ADVANCE_EXCEEDS_TOTAL',
      `Total advance (${nextNetTiyin.toString()}) would exceed order total (${orderTotalTiyin.toString()})`,
    );
  }

  return {
    items,
    addedAdvance: moneyFromTiyin(addedTiyin),
    nextNetAdvance: moneyFromTiyin(nextNetTiyin),
    nextStatus: openStatus === 'draft' ? 'confirmed' : openStatus,
    cashInAmount: moneyFromTiyin(cashInTiyin),
    cashChangeOutAmount: moneyFromTiyin(cashChangeOutTiyin),
  };
}

/**
 * Validates and resolves advance refunds against an open order enforcing per-method V2 caps
 * (`requestedByMethod[m] <= netAdvanceByMethod[m]`).
 */
export function resolveRefundOrderAdvances(params: {
  readonly orderStatus: OrderStatus;
  readonly netAdvanceByMethod: Readonly<Record<PaymentMethod, Money>>;
  readonly totalNetAdvance: Money;
  readonly refunds: readonly ReturnPaymentInput[];
}): ResolvedOrderAdvanceRefund {
  assertOrderOpenStatus(params.orderStatus);
  const rawRefunds: unknown = params.refunds;
  if (!Array.isArray(rawRefunds) || params.refunds.length === 0) {
    throw new DomainError('VALIDATION_ERROR', 'At least one advance refund row is required');
  }

  const requestedByMethod: Record<PaymentMethod, bigint> = {
    cash: 0n,
    card: 0n,
    uzqr: 0n,
    payme: 0n,
    click: 0n,
    uzum: 0n,
    social_card: 0n,
    other: 0n,
  };

  let totalRefundTiyin = 0n;
  let cashRefundTiyin = 0n;
  let nonCashRefundTiyin = 0n;
  const items: ResolvedOrderAdvanceRefundItem[] = [];

  for (const row of params.refunds) {
    const method = parsePaymentMethod(row.method);
    const amt = moneyToTiyin(row.amount);
    assertBoundedPositive(amt, `refund.${method}.amount`);
    const ref =
      method === 'cash' ? null : normalizePaymentProviderRef(row.providerRef ?? undefined);
    if (method === 'cash' && normalizePaymentProviderRef(row.providerRef) !== null) {
      throw new DomainError('VALIDATION_ERROR', 'Cash advance refund must not set providerRef');
    }
    requestedByMethod[method] += amt;
    totalRefundTiyin += amt;
    if (method === 'cash') {
      cashRefundTiyin += amt;
    } else {
      nonCashRefundTiyin += amt;
    }
    items.push({
      method,
      amount: row.amount,
      providerRef: ref,
    });
  }

  for (const method of PAYMENT_METHODS) {
    const avail = moneyToTiyin(params.netAdvanceByMethod[method]);
    const req = requestedByMethod[method];
    if (req > avail) {
      throw new DomainError(
        'ORDER_ADVANCE_REFUND_EXCEEDED',
        `Cannot refund ${req.toString()} via "${method}": remaining advance for method is ${avail.toString()}`,
      );
    }
  }

  const prevNet = moneyToTiyin(params.totalNetAdvance);
  if (totalRefundTiyin > prevNet) {
    throw new DomainError(
      'ORDER_ADVANCE_REFUND_EXCEEDED',
      `Cannot refund ${totalRefundTiyin.toString()}: remaining order advance is ${prevNet.toString()}`,
    );
  }

  return {
    items,
    totalRefund: moneyFromTiyin(totalRefundTiyin),
    cashRefundAmount: moneyFromTiyin(cashRefundTiyin),
    nonCashRefundAmount: moneyFromTiyin(nonCashRefundTiyin),
    nextNetAdvance: moneyFromTiyin(prevNet - totalRefundTiyin),
  };
}

/**
 * Computes exact per-method refund rows required to bring an open order's net advance to zero
 * during `cancelOrder` while preserving the per-method V2 invariant.
 */
export function buildAutoCancelOrderRefunds(params: {
  readonly orderStatus: OrderStatus;
  readonly netAdvanceByMethod: Readonly<Record<PaymentMethod, Money>>;
}): ResolvedOrderAdvanceRefund {
  assertOrderOpenStatus(params.orderStatus);
  const items: ResolvedOrderAdvanceRefundItem[] = [];
  let totalRefundTiyin = 0n;
  let cashRefundTiyin = 0n;
  let nonCashRefundTiyin = 0n;

  for (const method of PAYMENT_METHODS) {
    const amtTiyin = moneyToTiyin(params.netAdvanceByMethod[method]);
    if (amtTiyin <= 0n) {
      continue;
    }
    items.push({
      method,
      amount: params.netAdvanceByMethod[method],
      providerRef: null,
    });
    totalRefundTiyin += amtTiyin;
    if (method === 'cash') {
      cashRefundTiyin += amtTiyin;
    } else {
      nonCashRefundTiyin += amtTiyin;
    }
  }

  return {
    items,
    totalRefund: moneyFromTiyin(totalRefundTiyin),
    cashRefundAmount: moneyFromTiyin(cashRefundTiyin),
    nonCashRefundAmount: moneyFromTiyin(nonCashRefundTiyin),
    nextNetAdvance: ZERO_MONEY,
  };
}

/**
 * O2: Constructs and validates final sale payments for `deliverOrder` using frozen `orderTotalAmount`
 * (no re-pricing at delivery). Prepends `{ method: 'advance', amount: netAdvance }` when `netAdvance > 0`,
 * merges additional tender rows (`SalePaymentInput[]`, strictly excluding `'advance'`), and verifies
 * `SUM(payments) + debtAmount === orderTotalAmount` through the shared T1.5 validator.
 */
export function buildDeliverySalePayments(params: {
  readonly orderStatus: OrderStatus;
  readonly orderTotalAmount: Money;
  readonly netAdvance: Money;
  readonly debtAmount: Money;
  readonly customerId: UuidV7 | null;
  readonly additionalPayments: readonly SalePaymentInput[];
}): {
  readonly resolved: ResolvedSalePayments;
  readonly appliedAdvance: Money;
} {
  assertOrderTransition(params.orderStatus, 'delivered');

  const totalTiyin = moneyToTiyin(params.orderTotalAmount);
  const netAdvTiyin = moneyToTiyin(params.netAdvance);
  if (netAdvTiyin < 0n) {
    throw new DomainError('VALIDATION_ERROR', 'netAdvance cannot be negative');
  }
  if (netAdvTiyin > totalTiyin) {
    throw new DomainError(
      'ORDER_EXCESS_ADVANCE',
      `Net advance (${netAdvTiyin.toString()}) exceeds frozen order total (${totalTiyin.toString()})`,
    );
  }

  for (const row of params.additionalPayments) {
    parsePaymentMethod(row.method);
  }

  const combinedInputs: DeliverSalePaymentInput[] = [
    ...(netAdvTiyin > 0n ? [{ method: 'advance' as const, amount: params.netAdvance }] : []),
    ...params.additionalPayments,
  ];

  const resolved = resolveSalePayments({
    totalFinal: params.orderTotalAmount,
    debtAmount: params.debtAmount,
    customerId: params.customerId,
    allowAdvancePayment: true,
    payments: combinedInputs,
  });

  validateSalePaymentsInvariant({
    totalFinal: params.orderTotalAmount,
    debtAmount: params.debtAmount,
    customerId: params.customerId,
    allowAdvancePayment: true,
    payments: resolved.payments,
  });

  return {
    resolved,
    appliedAdvance: params.netAdvance,
  };
}

/**
 * O1 / T1.6: Expands `'advance'` row in a delivered order sale's `payments` back into the order's
 * real tender methods (`netAdvanceByMethod` from `order_payments`), producing an accurate per-method
 * return cap map with zero `'advance'` entries remaining.
 */
export function resolveOrderReturnEffectivePaidByMethod(params: {
  readonly salePayments: readonly {
    readonly method: SalePaymentMethod;
    readonly amount: Money;
  }[];
  readonly netAdvanceByMethod: Readonly<Record<PaymentMethod, Money>>;
  readonly netAdvanceTotal: Money;
}): Record<PaymentMethod, Money> {
  const effective = createEmptyPaymentMethodMap();
  const buckets: Record<PaymentMethod, bigint> = {
    cash: 0n,
    card: 0n,
    uzqr: 0n,
    payme: 0n,
    click: 0n,
    uzum: 0n,
    social_card: 0n,
    other: 0n,
  };

  let advanceRowTiyin = 0n;
  for (const p of params.salePayments) {
    const amt = moneyToTiyin(p.amount);
    if (p.method === 'advance') {
      advanceRowTiyin += amt;
    } else {
      buckets[p.method] += amt;
    }
  }

  const expectedAdvTiyin = moneyToTiyin(params.netAdvanceTotal);
  if (advanceRowTiyin !== expectedAdvTiyin) {
    throw new DomainError(
      'VALIDATION_ERROR',
      `Delivered sale advance amount (${advanceRowTiyin.toString()}) does not match order net advance (${expectedAdvTiyin.toString()})`,
    );
  }

  if (advanceRowTiyin > 0n) {
    for (const method of PAYMENT_METHODS) {
      buckets[method] += moneyToTiyin(params.netAdvanceByMethod[method]);
    }
  }

  for (const method of PAYMENT_METHODS) {
    effective[method] = moneyFromTiyin(buckets[method]);
  }
  return effective;
}

/**
 * O4: Pure accounting aggregator over order advance entries.
 * Computes currently open customer advance obligations (`status IN ('draft','confirmed','ready')`)
 * by method and proves:
 * `totalOpenAdvance === totalAdvanceIn - totalAdvanceRefunded - totalAdvanceAppliedAtDelivery`.
 */
export function computeOpenAdvancesAccounting(
  entries: readonly OpenAdvancesAccountingEntry[],
): OpenAdvancesSummary {
  const openIn: Record<PaymentMethod, bigint> = {
    cash: 0n,
    card: 0n,
    uzqr: 0n,
    payme: 0n,
    click: 0n,
    uzum: 0n,
    social_card: 0n,
    other: 0n,
  };
  const openRefund: Record<PaymentMethod, bigint> = {
    cash: 0n,
    card: 0n,
    uzqr: 0n,
    payme: 0n,
    click: 0n,
    uzum: 0n,
    social_card: 0n,
    other: 0n,
  };

  let totalIn = 0n;
  let totalRefund = 0n;
  let totalAppliedAtDelivery = 0n;
  let totalOpen = 0n;

  for (const e of entries) {
    const method = parsePaymentMethod(e.method);
    const amt = moneyToTiyin(e.amount);
    assertBoundedPositive(amt, `openAdvances.${method}.amount`);
    if (e.kind === 'advance') {
      totalIn += amt;
      if (isOrderOpenStatus(e.orderStatus)) {
        openIn[method] += amt;
        totalOpen += amt;
      } else if (e.orderStatus === 'delivered') {
        totalAppliedAtDelivery += amt;
      }
    } else {
      totalRefund += amt;
      if (isOrderOpenStatus(e.orderStatus)) {
        openRefund[method] += amt;
        totalOpen -= amt;
      } else if (e.orderStatus === 'delivered') {
        totalAppliedAtDelivery -= amt;
      }
    }
  }

  const byMethod = createEmptyPaymentMethodMap();
  for (const method of PAYMENT_METHODS) {
    byMethod[method] = moneyFromTiyin(openIn[method] - openRefund[method]);
  }

  return {
    totalOpenAdvance: moneyFromTiyin(totalOpen),
    byMethod,
    totalAdvanceIn: moneyFromTiyin(totalIn),
    totalAdvanceRefunded: moneyFromTiyin(totalRefund),
    totalAdvanceAppliedAtDelivery: moneyFromTiyin(totalAppliedAtDelivery),
  };
}

// --- Canonical Idempotency Request Builders ---

export function canonicalizeCreateOrderRequest(params: {
  readonly customerId: UuidV7 | null;
  readonly customerName: string;
  readonly customerPhoneNormalized: string | null;
  readonly dueAtMs: UnixMs | null;
  readonly note: string | null;
  readonly confirmImmediately: boolean;
  readonly manualDiscountMode: ManualDiscountMode;
  readonly manualDiscountPercentBp: bigint;
  readonly manualDiscountAmount: Money;
  readonly overrideApprovedByUserId: UuidV7 | null;
  readonly overrideApprovedAmount: Money | null;
  readonly lines: readonly {
    readonly lineKind: CartLineKind;
    readonly productId: UuidV7 | null;
    readonly variantId: UuidV7 | null;
    readonly itemName: string;
    readonly unit: ProductUnit;
    readonly qtyMilli: bigint;
    readonly unitPriceTiyin: bigint;
    readonly vatRateBp: number;
    readonly mxikSnapshot: string | null;
    readonly packageCodeSnapshot: string | null;
  }[];
}): string {
  return JSON.stringify({
    op: 'create_order.v1',
    customerId: params.customerId,
    customerName: params.customerName,
    customerPhoneNormalized: params.customerPhoneNormalized,
    dueAtMs: params.dueAtMs !== null ? BigInt(params.dueAtMs).toString() : null,
    note: params.note,
    confirmImmediately: params.confirmImmediately,
    manualDiscountMode: params.manualDiscountMode,
    manualDiscountPercentBp: params.manualDiscountPercentBp.toString(),
    manualDiscountAmount: moneyToTiyin(params.manualDiscountAmount).toString(),
    overrideApprovedByUserId: params.overrideApprovedByUserId,
    overrideApprovedAmount:
      params.overrideApprovedAmount !== null
        ? moneyToTiyin(params.overrideApprovedAmount).toString()
        : null,
    lines: params.lines.map((l) => ({
      lineKind: l.lineKind,
      productId: l.productId,
      variantId: l.variantId,
      itemName: l.itemName,
      unit: l.unit,
      qtyMilli: l.qtyMilli.toString(),
      unitPriceTiyin: l.unitPriceTiyin.toString(),
      vatRateBp: l.vatRateBp,
      mxikSnapshot: l.mxikSnapshot,
      packageCodeSnapshot: l.packageCodeSnapshot,
    })),
  });
}

export function canonicalizeConfirmOrderRequest(params: { readonly orderId: UuidV7 }): string {
  return JSON.stringify({
    op: 'confirm_order.v1',
    orderId: parseUuidV7(params.orderId),
  });
}

export function canonicalizeMarkOrderReadyRequest(params: { readonly orderId: UuidV7 }): string {
  return JSON.stringify({
    op: 'mark_order_ready.v1',
    orderId: parseUuidV7(params.orderId),
  });
}

export function canonicalizeRecordOrderAdvanceRequest(params: {
  readonly orderId: UuidV7;
  readonly payments: readonly SalePaymentInput[];
}): string {
  return JSON.stringify({
    op: 'record_order_advance.v1',
    orderId: parseUuidV7(params.orderId),
    payments: params.payments.map((row) =>
      row.method === 'cash'
        ? [
            'cash',
            moneyToTiyin(row.tenderedAmount).toString(),
            row.amount !== undefined ? moneyToTiyin(row.amount).toString() : null,
          ]
        : [
            row.method,
            moneyToTiyin(row.amount).toString(),
            normalizePaymentProviderRef(row.providerRef),
          ],
    ),
  });
}

export function canonicalizeRefundOrderAdvanceRequest(params: {
  readonly orderId: UuidV7;
  readonly reason: string;
  readonly refunds: readonly ReturnPaymentInput[];
}): string {
  return JSON.stringify({
    op: 'refund_order_advance.v1',
    orderId: parseUuidV7(params.orderId),
    reason: params.reason,
    refunds: params.refunds.map((r) => [
      r.method,
      moneyToTiyin(r.amount).toString(),
      normalizePaymentProviderRef(r.providerRef),
    ]),
  });
}

export function canonicalizeDeliverOrderRequest(params: {
  readonly orderId: UuidV7;
  readonly expectedTotal: Money;
  readonly debtAmount: Money;
  readonly customerId: UuidV7 | null;
  readonly dueDays: number | null;
  readonly additionalPayments: readonly SalePaymentInput[];
}): string {
  return JSON.stringify({
    op: 'deliver_order.v1',
    orderId: parseUuidV7(params.orderId),
    expectedTotal: moneyToTiyin(params.expectedTotal).toString(),
    debtAmount: moneyToTiyin(params.debtAmount).toString(),
    customerId: params.customerId,
    dueDays: params.dueDays,
    additionalPayments: params.additionalPayments.map((row) =>
      row.method === 'cash'
        ? [
            'cash',
            moneyToTiyin(row.tenderedAmount).toString(),
            row.amount !== undefined ? moneyToTiyin(row.amount).toString() : null,
          ]
        : [
            row.method,
            moneyToTiyin(row.amount).toString(),
            normalizePaymentProviderRef(row.providerRef),
          ],
    ),
  });
}

export function canonicalizeCancelOrderRequest(params: {
  readonly orderId: UuidV7;
  readonly reason: string;
}): string {
  return JSON.stringify({
    op: 'cancel_order.v1',
    orderId: parseUuidV7(params.orderId),
    reason: params.reason,
  });
}
