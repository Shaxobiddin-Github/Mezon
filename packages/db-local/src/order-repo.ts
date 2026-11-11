import { createHash } from 'node:crypto';
import {
  type CartLineKind,
  DomainError,
  type ManualDiscountMode,
  type Money,
  ORDER_OPEN_STATUSES,
  type OrderPaymentKind,
  type OrderStatus,
  type PaymentMethod,
  type ProductUnit,
  type Quantity,
  type ReturnPaymentInput,
  type SalePaymentInput,
  type UnixMs,
  type UserRole,
  type UuidV7,
  ZERO_MONEY,
  assertOrderTransition,
  buildAutoCancelOrderRefunds,
  buildDeliverySalePayments,
  canonicalizeCancelOrderRequest,
  canonicalizeConfirmOrderRequest,
  canonicalizeCreateOrderRequest,
  canonicalizeDeliverOrderRequest,
  canonicalizeMarkOrderReadyRequest,
  canonicalizeRecordOrderAdvanceRequest,
  canonicalizeRefundOrderAdvanceRequest,
  computeOpenAdvancesAccounting,
  createEmptyPaymentMethodMap,
  evaluateCart,
  evaluateOrderDraft,
  formatOrderCode,
  isUserRole,
  moneyFromTiyin,
  moneyToTiyin,
  negateMoney,
  normalizeMandatoryOrderReason,
  normalizeOrderCustomerSnapshot,
  normalizeOrderNote,
  normalizePriceChangeReason,
  parseNegativeStockPolicy,
  parseOrderPaymentKind,
  parseOrderStatus,
  parsePaymentMethod,
  parseProductUnit,
  parseUuidV7,
  quantityToMilli,
  resolveRecordOrderAdvance,
  resolveRefundOrderAdvances,
  summarizeOrderPayments,
  vatRateFromBasisPoints,
} from '@mezon/domain';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  readHubConfigRowInDbSync,
  readOrgPromotionsInDbSync,
  type SetCartDiscountInput,
  toDiscountSettings,
  toPromotionRule,
} from './cart-repo.js';
import type { LocalSqliteConnection } from './connection.js';
import { advanceOrderSeqSync } from './device-state.js';
import { type StoredSaleRecord, completeSaleCoreInTxSync, toStoredSale } from './sale-repo.js';
import {
  cashMoves,
  customers,
  orderLines,
  orderPayments,
  orders,
  payments,
  products,
  productVariants,
  saleLines,
  sales,
  users,
} from './schema/index.js';
import { getActiveShiftDrawerBalanceSync, requireOpenShiftSessionSync } from './shift-repo.js';
import type { StockMoveWarningRecord } from './stock-repo.js';
import { type SqliteUnitOfWork, runConnectionReadOnly } from './uow.js';
import { insertFact, insertMonotone, updateMonotone } from './writers.js';

export interface OrderRuntimeContext {
  readonly uow: SqliteUnitOfWork;
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7;
}

/**
 * Test-only crash injection hook (`C1` atomicity verification): never set by production Hub/Electron.
 */
export interface OrderStoreTestHooks {
  readonly onBeforeCommit?: () => void;
}

export interface CreateSqliteOrderStoreOptions {
  readonly connection: LocalSqliteConnection;
  readonly getRuntimeContext: () => OrderRuntimeContext | null;
  readonly __testHooks?: OrderStoreTestHooks;
}

export type CreateOrderLineInput =
  | {
      readonly kind: 'catalog';
      readonly productId: UuidV7;
      readonly variantId?: UuidV7 | null;
      readonly qty: Quantity;
    }
  | {
      readonly kind: 'quick_sale';
      readonly name: string;
      readonly unit: ProductUnit;
      readonly qty: Quantity;
      readonly unitPrice: Money;
      readonly mxik?: string | null;
      readonly packageCode?: string | null;
      readonly vatRateBp?: number | null;
    };

export interface CreateOrderInput {
  readonly actorUserId: UuidV7;
  readonly clientRequestId: UuidV7;
  readonly customerId?: UuidV7 | null;
  readonly customerName?: string;
  readonly customerPhone?: string | null;
  readonly dueAtMs?: UnixMs | null;
  readonly note?: string | null;
  readonly confirmImmediately?: boolean;
  readonly expectedTotal?: Money;
  readonly discount?: SetCartDiscountInput;
  readonly overrideApprovedByUserId?: UuidV7 | null;
  readonly lines: readonly CreateOrderLineInput[];
}

export interface OrderTransitionInput {
  readonly orderId: UuidV7;
  readonly actorUserId: UuidV7;
  readonly clientRequestId: UuidV7;
}

export interface RecordOrderAdvanceInput {
  readonly orderId: UuidV7;
  readonly actorUserId: UuidV7;
  readonly clientRequestId: UuidV7;
  readonly payments: readonly SalePaymentInput[];
}

export interface RefundOrderAdvanceInput {
  readonly orderId: UuidV7;
  readonly actorUserId: UuidV7;
  readonly overrideApprovedByUserId?: UuidV7 | null;
  readonly clientRequestId: UuidV7;
  readonly reason: string;
  readonly refunds: readonly ReturnPaymentInput[];
}

export interface DeliverOrderInput {
  readonly orderId: UuidV7;
  readonly actorUserId: UuidV7;
  readonly clientRequestId: UuidV7;
  readonly expectedTotal: Money;
  readonly debtAmount?: Money;
  readonly customerId?: UuidV7 | null;
  readonly dueDays?: number | null;
  readonly creditOverrideApprovedByUserId?: UuidV7 | null;
  readonly payments: readonly SalePaymentInput[];
}

export interface CancelOrderInput {
  readonly orderId: UuidV7;
  readonly actorUserId: UuidV7;
  readonly overrideApprovedByUserId?: UuidV7 | null;
  readonly clientRequestId: UuidV7;
  readonly reason: string;
}

export interface ListOrdersQueryInput {
  readonly status?: OrderStatus;
  readonly customerId?: UuidV7;
  readonly limit?: number;
  readonly offset?: number;
}

export interface StoredOrderLineRecord {
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
}

export interface StoredOrderPaymentRecord {
  readonly id: UuidV7;
  readonly orderId: UuidV7;
  readonly shiftId: UuidV7;
  readonly shiftCashierSessionId: UuidV7;
  readonly kind: OrderPaymentKind;
  readonly method: PaymentMethod;
  readonly amount: Money;
  readonly tenderedAmount: Money | null;
  readonly changeAmount: Money;
  readonly providerRef: string | null;
  readonly reason: string | null;
  readonly createdByUserId: UuidV7;
  readonly overrideApprovedByUserId: UuidV7 | null;
  readonly createdAtMs: UnixMs;
}

export interface StoredOrderRecord {
  readonly id: UuidV7;
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7;
  readonly deviceId: UuidV7;
  readonly orderNo: bigint;
  readonly orderCode: string;
  readonly status: OrderStatus;
  readonly customerId: UuidV7 | null;
  readonly customerName: string;
  readonly customerPhoneNormalized: string | null;
  readonly dueAtMs: UnixMs | null;
  readonly note: string | null;
  readonly subtotalGross: Money;
  readonly totalPromoDiscount: Money;
  readonly subtotalAfterPromo: Money;
  readonly manualDiscountMode: ManualDiscountMode;
  readonly manualDiscountValue: bigint;
  readonly manualDiscountReason: string | null;
  readonly orderDiscountAmount: Money;
  readonly totalAmount: Money;
  readonly totalNetExVat: Money;
  readonly totalVat: Money;
  readonly netAdvance: Money;
  readonly remainingToPay: Money;
  readonly netAdvanceByMethod: Readonly<Record<PaymentMethod, Money>>;
  readonly overrideApprovedByUserId: UuidV7 | null;
  readonly overrideApprovedAmount: Money | null;
  readonly createdByUserId: UuidV7;
  readonly createdAtMs: UnixMs;
  readonly confirmedAtMs: UnixMs | null;
  readonly readyAtMs: UnixMs | null;
  readonly deliveredAtMs: UnixMs | null;
  readonly deliveredSaleId: UuidV7 | null;
  readonly cancelledAtMs: UnixMs | null;
  readonly cancelledByUserId: UuidV7 | null;
  readonly cancelReason: string | null;
  readonly lines: readonly StoredOrderLineRecord[];
  readonly payments: readonly StoredOrderPaymentRecord[];
}

export interface OrderActionOutcome {
  readonly order: StoredOrderRecord;
  readonly idempotentReplay: boolean;
}

export interface DeliverOrderOutcome {
  readonly order: StoredOrderRecord;
  readonly sale: StoredSaleRecord;
  readonly warnings: readonly StockMoveWarningRecord[];
  readonly idempotentReplay: boolean;
}

export interface ListOrdersOutcome {
  readonly orders: readonly StoredOrderRecord[];
  readonly total: number;
}

export interface OpenAdvancesOutcome {
  readonly totalOpenAdvance: Money;
  readonly byMethod: Readonly<Record<PaymentMethod, Money>>;
  readonly openOrdersCount: number;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function toStoredOrderLine(row: typeof orderLines.$inferSelect): StoredOrderLineRecord {
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
  };
}

function toStoredOrderPayment(row: typeof orderPayments.$inferSelect): StoredOrderPaymentRecord {
  return {
    id: row.id,
    orderId: row.orderId,
    shiftId: row.shiftId,
    shiftCashierSessionId: row.shiftCashierSessionId,
    kind: parseOrderPaymentKind(row.kind),
    method: parsePaymentMethod(row.method),
    amount: row.amount,
    tenderedAmount: row.tenderedAmount,
    changeAmount: row.changeAmount,
    providerRef: row.providerRef,
    reason: row.reason,
    createdByUserId: row.createdByUserId,
    overrideApprovedByUserId: row.overrideApprovedByUserId,
    createdAtMs: row.createdAtMs,
  };
}

function toStoredOrder(
  row: typeof orders.$inferSelect,
  lineRows: readonly (typeof orderLines.$inferSelect)[],
  paymentRows: readonly (typeof orderPayments.$inferSelect)[],
): StoredOrderRecord {
  const status = parseOrderStatus(row.status);
  const storedPayments = paymentRows.map(toStoredOrderPayment);
  const advSummary = summarizeOrderPayments(
    storedPayments.map((p) => ({ kind: p.kind, method: p.method, amount: p.amount })),
  );

  const netAdvance =
    status === 'delivered' || status === 'cancelled' ? ZERO_MONEY : advSummary.netAdvance;
  const remainingTiyin =
    status === 'delivered' || status === 'cancelled'
      ? 0n
      : moneyToTiyin(row.totalAmount) - moneyToTiyin(advSummary.netAdvance);

  return {
    id: row.id,
    organizationId: row.organizationId,
    storeId: row.storeId,
    deviceId: row.deviceId,
    orderNo: row.orderNo,
    orderCode: row.orderCode,
    status,
    customerId: row.customerId,
    customerName: row.customerName,
    customerPhoneNormalized: row.customerPhoneNormalized,
    dueAtMs: row.dueAtMs,
    note: row.note,
    subtotalGross: row.subtotalGross,
    totalPromoDiscount: row.totalPromoDiscount,
    subtotalAfterPromo: row.subtotalAfterPromo,
    manualDiscountMode: row.manualDiscountMode as ManualDiscountMode,
    manualDiscountValue: row.manualDiscountValue,
    manualDiscountReason: row.manualDiscountReason,
    orderDiscountAmount: row.orderDiscountAmount,
    totalAmount: row.totalAmount,
    totalNetExVat: row.totalNetExVat,
    totalVat: row.totalVat,
    netAdvance,
    remainingToPay: moneyFromTiyin(remainingTiyin > 0n ? remainingTiyin : 0n),
    netAdvanceByMethod:
      status === 'delivered' || status === 'cancelled'
        ? createEmptyPaymentMethodMap()
        : advSummary.netAdvanceByMethod,
    overrideApprovedByUserId: row.overrideApprovedByUserId,
    overrideApprovedAmount: row.overrideApprovedAmount,
    createdByUserId: row.createdByUserId,
    createdAtMs: row.createdAtMs,
    confirmedAtMs: row.confirmedAtMs,
    readyAtMs: row.readyAtMs,
    deliveredAtMs: row.deliveredAtMs,
    deliveredSaleId: row.deliveredSaleId,
    cancelledAtMs: row.cancelledAtMs,
    cancelledByUserId: row.cancelledByUserId,
    cancelReason: row.cancelReason,
    lines: lineRows.map(toStoredOrderLine),
    payments: storedPayments,
  };
}

function loadOrderRecordSync(
  db: BetterSQLite3Database,
  orderRow: typeof orders.$inferSelect,
): StoredOrderRecord {
  const lineRows = db
    .select()
    .from(orderLines)
    .where(eq(orderLines.orderId, orderRow.id))
    .orderBy(asc(orderLines.sortOrder))
    .all();
  const payRows = db
    .select()
    .from(orderPayments)
    .where(eq(orderPayments.orderId, orderRow.id))
    .orderBy(asc(orderPayments.createdAtMs), asc(orderPayments.seq), asc(orderPayments.id))
    .all();
  return toStoredOrder(orderRow, lineRows, payRows);
}

function requireOrderRowSync(
  db: BetterSQLite3Database,
  organizationId: UuidV7,
  storeId: UuidV7,
  orderId: UuidV7,
): typeof orders.$inferSelect {
  const row = db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.id, orderId),
        eq(orders.organizationId, organizationId),
        eq(orders.storeId, storeId),
      ),
    )
    .limit(1)
    .all()[0];
  if (!row) {
    throw new DomainError('ORDER_NOT_FOUND', `Order "${orderId}" was not found`);
  }
  return row;
}

function parseUserRole(raw: string): UserRole {
  if (!isUserRole(raw)) {
    throw new DomainError('VALIDATION_ERROR', `Invalid user role: "${raw}"`);
  }
  return raw;
}

function assertSupervisorForOrderRefundOrCancelSync(
  db: BetterSQLite3Database,
  organizationId: UuidV7,
  actorUserId: UuidV7,
  overrideApprovedByUserId: UuidV7 | null,
): void {
  const actor = db
    .select({ role: users.role, isActive: users.isActive })
    .from(users)
    .where(
      and(
        eq(users.organizationId, organizationId),
        eq(users.id, actorUserId),
        isNull(users.deletedAtMs),
      ),
    )
    .limit(1)
    .all()[0];
  if (!actor || !actor.isActive) {
    throw new DomainError('AUTH_UNAUTHORIZED', 'Acting user is missing or inactive');
  }
  const role = parseUserRole(actor.role);
  if (role === 'owner' || role === 'manager') {
    return;
  }
  if (overrideApprovedByUserId === null) {
    throw new DomainError(
      'SUPERVISOR_OVERRIDE_REQUIRED',
      'Order advance refund or cancellation requires manager/owner PIN approval',
    );
  }
  const supervisor = db
    .select({ role: users.role, isActive: users.isActive })
    .from(users)
    .where(
      and(
        eq(users.organizationId, organizationId),
        eq(users.id, overrideApprovedByUserId),
        isNull(users.deletedAtMs),
      ),
    )
    .limit(1)
    .all()[0];
  if (!supervisor || !supervisor.isActive) {
    throw new DomainError('SUPERVISOR_OVERRIDE_REQUIRED', 'Supervisor account is inactive');
  }
  const supRole = parseUserRole(supervisor.role);
  if (supRole !== 'owner' && supRole !== 'manager') {
    throw new DomainError(
      'SUPERVISOR_OVERRIDE_REQUIRED',
      'Supervisor override must belong to manager or owner',
    );
  }
}

export class SqliteOrderStore {
  private readonly connection: LocalSqliteConnection;
  private readonly getRuntimeContext: () => OrderRuntimeContext | null;
  private readonly testHooks?: OrderStoreTestHooks;

  constructor(options: CreateSqliteOrderStoreOptions) {
    this.connection = options.connection;
    this.getRuntimeContext = options.getRuntimeContext;
    this.testHooks = options.__testHooks;
  }

  private requireContext(): OrderRuntimeContext {
    const ctx = this.getRuntimeContext();
    if (!ctx) {
      throw new DomainError('AUTH_UNAUTHORIZED', 'Hub setup has not been completed');
    }
    return ctx;
  }

  /**
   * O3: Evaluates order lines + promotions + manual discount ONCE at order creation via T1.3
   * `evaluateCart` (reused through `evaluateOrderDraft`), freezes complete line & header
   * snapshots in `orders` + `order_lines`, and allocates gapless `order_no`.
   */
  async createOrder(input: CreateOrderInput): Promise<OrderActionOutcome> {
    const ctx = this.requireContext();
    const validActorId = parseUuidV7(input.actorUserId);
    const validReqId = parseUuidV7(input.clientRequestId);
    const rawCustomerId =
      input.customerId !== undefined && input.customerId !== null
        ? parseUuidV7(input.customerId)
        : null;
    const note = normalizeOrderNote(input.note);
    const confirmImmediately = input.confirmImmediately ?? false;
    const dueAtMs = input.dueAtMs ?? null;
    const overrideApprovedByUserId =
      input.overrideApprovedByUserId !== undefined && input.overrideApprovedByUserId !== null
        ? parseUuidV7(input.overrideApprovedByUserId)
        : null;

    if (input.lines.length === 0) {
      throw new DomainError('ORDER_EMPTY', 'Order must contain at least one line');
    }

    const discInput = input.discount ?? { mode: 'none' as const };
    const manualDiscountMode: ManualDiscountMode = discInput.mode;
    const manualDiscountPercentBp = discInput.mode === 'percent' ? BigInt(discInput.percentBp) : 0n;
    const manualDiscountAmount = discInput.mode === 'amount' ? discInput.amount : ZERO_MONEY;
    const manualDiscountReason =
      discInput.mode === 'none' ? null : normalizePriceChangeReason(discInput.reason ?? null);
    const manualDiscountValue =
      manualDiscountMode === 'percent'
        ? manualDiscountPercentBp
        : manualDiscountMode === 'amount'
          ? moneyToTiyin(manualDiscountAmount)
          : 0n;

    return ctx.uow.execute<OrderActionOutcome>((session) => {
      const nowMs = session.nowUnixMs();
      const hubConfig = readHubConfigRowInDbSync(session.db, ctx.organizationId);
      const settings = toDiscountSettings(hubConfig);

      // Resolve customer snapshot (optional customerId; active status validated if provided)
      let customerNameRaw = input.customerName;
      let customerPhoneRaw = input.customerPhone;
      if (rawCustomerId !== null) {
        const cust = session.db
          .select()
          .from(customers)
          .where(
            and(
              eq(customers.id, rawCustomerId),
              eq(customers.organizationId, ctx.organizationId),
              isNull(customers.deletedAtMs),
            ),
          )
          .limit(1)
          .all()[0];
        if (!cust) {
          throw new DomainError('CUSTOMER_NOT_FOUND', `Customer "${rawCustomerId}" was not found`);
        }
        if (!cust.isActive) {
          throw new DomainError('CUSTOMER_INACTIVE', `Customer "${rawCustomerId}" is inactive`);
        }
        customerNameRaw ??= cust.fullName;
        if (customerPhoneRaw === undefined) {
          customerPhoneRaw = cust.phoneNormalized;
        }
      } else if (customerNameRaw === undefined) {
        throw new DomainError(
          'VALIDATION_ERROR',
          'customerName is required when customerId is omitted',
        );
      }

      const custSnap = normalizeOrderCustomerSnapshot({
        customerName: customerNameRaw,
        customerPhone: customerPhoneRaw ?? null,
      });

      // Resolve catalog products/variants and quick_sale lines at creation time
      const resolvedDraftLines: Array<{
        readonly id: UuidV7;
        readonly lineKind: CartLineKind;
        readonly productId: UuidV7 | null;
        readonly variantId: UuidV7 | null;
        readonly categoryId: UuidV7 | null;
        readonly name: string;
        readonly unit: ProductUnit;
        readonly qty: Quantity;
        readonly unitPriceSnapshot: Money;
        readonly mxikSnapshot: string | null;
        readonly packageCodeSnapshot: string | null;
        readonly vatRateBpSnapshot: number;
      }> = [];

      for (const line of input.lines) {
        if (line.kind === 'catalog') {
          const pid = parseUuidV7(line.productId);
          const vid =
            line.variantId !== undefined && line.variantId !== null
              ? parseUuidV7(line.variantId)
              : null;
          const prod = session.db
            .select()
            .from(products)
            .where(
              and(
                eq(products.organizationId, ctx.organizationId),
                eq(products.id, pid),
                isNull(products.deletedAtMs),
              ),
            )
            .limit(1)
            .all()[0];
          if (!prod) {
            throw new DomainError('PRODUCT_NOT_FOUND', `Product "${pid}" was not found`);
          }
          let itemName = prod.name;
          let unitPrice = prod.salePrice;
          if (vid !== null) {
            const variant = session.db
              .select()
              .from(productVariants)
              .where(
                and(
                  eq(productVariants.organizationId, ctx.organizationId),
                  eq(productVariants.id, vid),
                  eq(productVariants.productId, prod.id),
                  isNull(productVariants.deletedAtMs),
                ),
              )
              .limit(1)
              .all()[0];
            if (!variant) {
              throw new DomainError('VARIANT_NOT_FOUND', `Variant "${vid}" was not found`);
            }
            itemName = `${prod.name} (${variant.name})`;
            unitPrice = variant.salePrice ?? prod.salePrice;
          }
          resolvedDraftLines.push({
            id: session.nextId(),
            lineKind: 'catalog',
            productId: prod.id,
            variantId: vid,
            categoryId: prod.categoryId,
            name: itemName,
            unit: parseProductUnit(prod.unit),
            qty: line.qty,
            unitPriceSnapshot: unitPrice,
            mxikSnapshot: prod.mxik,
            packageCodeSnapshot: prod.packageCode,
            vatRateBpSnapshot: prod.vatRateBp,
          });
        } else {
          const vatRateBp = line.vatRateBp ?? settings.quickSaleDefaultVatRateBp ?? 0;
          const mxikSnapshot = line.mxik ?? settings.quickSaleDefaultMxik ?? null;
          const packageCodeSnapshot = line.packageCode ?? null;
          resolvedDraftLines.push({
            id: session.nextId(),
            lineKind: 'quick_sale',
            productId: null,
            variantId: null,
            categoryId: null,
            name: line.name.trim(),
            unit: parseProductUnit(line.unit),
            qty: line.qty,
            unitPriceSnapshot: line.unitPrice,
            mxikSnapshot,
            packageCodeSnapshot,
            vatRateBpSnapshot: vatRateBp,
          });
        }
      }

      const promoRules = readOrgPromotionsInDbSync(session.db, ctx.organizationId).map(
        toPromotionRule,
      );

      const draftLinesForEval = resolvedDraftLines.map((l) => ({
        ...l,
        vatRate: vatRateFromBasisPoints(BigInt(l.vatRateBpSnapshot)),
      }));

      // If supervisor override is present, compute the exact discount amount first via `evaluateCart`
      // without triggering `DISCOUNT_OVERRIDE_REQUIRED`, then authorize via `evaluateOrderDraft`.
      let approvedDiscountAmount: Money | null = null;
      if (overrideApprovedByUserId !== null) {
        const prelim = evaluateCart({
          storeId: ctx.storeId,
          nowMs,
          lines: draftLinesForEval,
          promotions: promoRules,
          manualDiscount: {
            mode: manualDiscountMode,
            percentBp: manualDiscountPercentBp,
            amount: manualDiscountAmount,
          },
          policy: settings.cashierDiscountLimit,
          overrideApprovedByUserId,
          overrideApprovedAmount: null,
        });
        approvedDiscountAmount = prelim.effectiveOrderDiscount;
      }

      const evaluated = evaluateOrderDraft({
        storeId: ctx.storeId,
        nowMs,
        lines: draftLinesForEval,
        promotions: promoRules,
        manualDiscount: {
          mode: manualDiscountMode,
          percentBp: manualDiscountPercentBp,
          amount: manualDiscountAmount,
        },
        policy: settings.cashierDiscountLimit,
        overrideApprovedByUserId,
        overrideApprovedAmount: approvedDiscountAmount,
      });

      const requestHash = sha256Hex(
        canonicalizeCreateOrderRequest({
          customerId: rawCustomerId,
          customerName: custSnap.customerName,
          customerPhoneNormalized: custSnap.customerPhoneNormalized,
          dueAtMs,
          note,
          confirmImmediately,
          manualDiscountMode,
          manualDiscountPercentBp,
          manualDiscountAmount,
          overrideApprovedByUserId,
          overrideApprovedAmount:
            overrideApprovedByUserId !== null ? evaluated.effectiveOrderDiscount : null,
          lines: resolvedDraftLines.map((l) => ({
            lineKind: l.lineKind,
            productId: l.productId,
            variantId: l.variantId,
            itemName: l.name,
            unit: l.unit,
            qtyMilli: quantityToMilli(l.qty),
            unitPriceTiyin: moneyToTiyin(l.unitPriceSnapshot),
            vatRateBp: l.vatRateBpSnapshot,
            mxikSnapshot: l.mxikSnapshot,
            packageCodeSnapshot: l.packageCodeSnapshot,
          })),
        }),
      );

      const existing = session.db
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.organizationId, ctx.organizationId),
            eq(orders.createClientRequestId, validReqId),
          ),
        )
        .limit(1)
        .all()[0];
      if (existing) {
        if (existing.storeId !== ctx.storeId || existing.createRequestHash !== requestHash) {
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            `clientRequestId "${validReqId}" conflicts with another order payload`,
          );
        }
        return Promise.resolve({
          order: loadOrderRecordSync(session.db, existing),
          idempotentReplay: true,
        });
      }

      if (
        input.expectedTotal !== undefined &&
        moneyToTiyin(evaluated.totalFinal) !== moneyToTiyin(input.expectedTotal)
      ) {
        throw new DomainError(
          'ORDER_TOTAL_CHANGED',
          `Evaluated order total (${evaluated.totalFinal.toString()}) differs from expectedTotal`,
        );
      }

      const orderNo = advanceOrderSeqSync(session.internalGetSqlite(), {
        deviceId: ctx.uow.deviceId,
        updatedAtMs: nowMs,
      });
      const orderCode = formatOrderCode(ctx.uow.deviceId, orderNo);

      const orderWrite = insertMonotone(session, orders, {
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        values: {
          originDeviceId: ctx.uow.deviceId,
          orderNo,
          orderCode,
          status: confirmImmediately ? 'confirmed' : 'draft',
          customerId: rawCustomerId,
          customerName: custSnap.customerName,
          customerPhoneNormalized: custSnap.customerPhoneNormalized,
          dueAtMs,
          note,
          subtotalGross: evaluated.subtotalGross,
          totalPromoDiscount: evaluated.totalPromoDiscount,
          subtotalAfterPromo: evaluated.subtotalAfterPromo,
          manualDiscountMode,
          manualDiscountValue,
          manualDiscountReason,
          orderDiscountAmount: evaluated.effectiveOrderDiscount,
          totalAmount: evaluated.totalFinal,
          totalNetExVat: evaluated.totalNetExVat,
          totalVat: evaluated.totalVat,
          overrideApprovedByUserId,
          overrideApprovedAmount:
            overrideApprovedByUserId !== null ? evaluated.effectiveOrderDiscount : null,
          createdByUserId: validActorId,
          confirmedAtMs: confirmImmediately ? nowMs : null,
          readyAtMs: null,
          deliveredAtMs: null,
          deliveredSaleId: null,
          cancelledAtMs: null,
          cancelledByUserId: null,
          cancelReason: null,
          createClientRequestId: validReqId,
          createRequestHash: requestHash,
          confirmClientRequestId: null,
          confirmRequestHash: null,
          readyClientRequestId: null,
          readyRequestHash: null,
          deliverClientRequestId: null,
          deliverRequestHash: null,
          cancelClientRequestId: null,
          cancelRequestHash: null,
        },
        eventType: 'order.created',
        schemaVersion: 1,
      });

      const insertedLines: (typeof orderLines.$inferSelect)[] = [];
      for (let idx = 0; idx < evaluated.lines.length; idx += 1) {
        const ev = evaluated.lines[idx];
        const lw = insertFact(session, orderLines, {
          organizationId: ctx.organizationId,
          storeId: ctx.storeId,
          values: {
            orderId: orderWrite.entityId,
            sortOrder: idx,
            lineKind: ev.lineKind,
            productId: ev.productId,
            variantId: ev.variantId,
            categoryIdSnapshot: ev.categoryId,
            itemName: ev.name,
            unit: ev.unit,
            qty: ev.qty,
            unitPriceSnapshot: ev.unitPriceSnapshot,
            appliedPromotionId: ev.appliedPromotionId,
            appliedPromotionName: ev.appliedPromotionName,
            freeUnits: ev.freeUnits,
            grossTotal: ev.grossTotal,
            promoDiscount: ev.promoDiscount,
            subtotalAfterPromo: ev.subtotalAfterPromo,
            allocatedOrderDiscount: ev.allocatedOrderDiscount,
            finalTotal: ev.finalTotal,
            vatRateBpSnapshot: ev.vatRateBpSnapshot,
            netExVat: ev.netExVat,
            vatTotal: ev.vatTotal,
            mxikSnapshot: ev.mxikSnapshot,
            packageCodeSnapshot: ev.packageCodeSnapshot,
          },
          eventType: 'order_line.created',
          schemaVersion: 1,
        });
        insertedLines.push(lw.row);
      }

      this.testHooks?.onBeforeCommit?.();

      return Promise.resolve({
        order: toStoredOrder(orderWrite.row, insertedLines, []),
        idempotentReplay: false,
      });
    });
  }

  async confirmOrder(input: OrderTransitionInput): Promise<OrderActionOutcome> {
    const ctx = this.requireContext();
    const validOrderId = parseUuidV7(input.orderId);
    parseUuidV7(input.actorUserId);
    const validReqId = parseUuidV7(input.clientRequestId);
    const requestHash = sha256Hex(canonicalizeConfirmOrderRequest({ orderId: validOrderId }));

    return ctx.uow.execute<OrderActionOutcome>((session) => {
      const nowMs = session.nowUnixMs();
      const replayed = session.db
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.organizationId, ctx.organizationId),
            eq(orders.confirmClientRequestId, validReqId),
          ),
        )
        .limit(1)
        .all()[0];
      if (replayed) {
        if (replayed.id !== validOrderId || replayed.confirmRequestHash !== requestHash) {
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            `clientRequestId "${validReqId}" conflicts with another confirmOrder request`,
          );
        }
        return Promise.resolve({
          order: loadOrderRecordSync(session.db, replayed),
          idempotentReplay: true,
        });
      }

      const row = requireOrderRowSync(session.db, ctx.organizationId, ctx.storeId, validOrderId);
      assertOrderTransition(parseOrderStatus(row.status), 'confirmed');

      const updated = updateMonotone(session, orders, {
        id: row.id,
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        values: {
          status: 'confirmed',
          confirmedAtMs: nowMs,
          confirmClientRequestId: validReqId,
          confirmRequestHash: requestHash,
        },
        eventType: 'order.confirmed',
        schemaVersion: 1,
      });

      this.testHooks?.onBeforeCommit?.();
      return Promise.resolve({
        order: loadOrderRecordSync(session.db, updated.row),
        idempotentReplay: false,
      });
    });
  }

  async markOrderReady(input: OrderTransitionInput): Promise<OrderActionOutcome> {
    const ctx = this.requireContext();
    const validOrderId = parseUuidV7(input.orderId);
    parseUuidV7(input.actorUserId);
    const validReqId = parseUuidV7(input.clientRequestId);
    const requestHash = sha256Hex(canonicalizeMarkOrderReadyRequest({ orderId: validOrderId }));

    return ctx.uow.execute<OrderActionOutcome>((session) => {
      const nowMs = session.nowUnixMs();
      const replayed = session.db
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.organizationId, ctx.organizationId),
            eq(orders.readyClientRequestId, validReqId),
          ),
        )
        .limit(1)
        .all()[0];
      if (replayed) {
        if (replayed.id !== validOrderId || replayed.readyRequestHash !== requestHash) {
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            `clientRequestId "${validReqId}" conflicts with another markOrderReady request`,
          );
        }
        return Promise.resolve({
          order: loadOrderRecordSync(session.db, replayed),
          idempotentReplay: true,
        });
      }

      const row = requireOrderRowSync(session.db, ctx.organizationId, ctx.storeId, validOrderId);
      assertOrderTransition(parseOrderStatus(row.status), 'ready');

      const updated = updateMonotone(session, orders, {
        id: row.id,
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        values: {
          status: 'ready',
          readyAtMs: nowMs,
          readyClientRequestId: validReqId,
          readyRequestHash: requestHash,
        },
        eventType: 'order.ready',
        schemaVersion: 1,
      });

      this.testHooks?.onBeforeCommit?.();
      return Promise.resolve({
        order: loadOrderRecordSync(session.db, updated.row),
        idempotentReplay: false,
      });
    });
  }

  async recordOrderAdvance(input: RecordOrderAdvanceInput): Promise<OrderActionOutcome> {
    const ctx = this.requireContext();
    const validOrderId = parseUuidV7(input.orderId);
    const validActorId = parseUuidV7(input.actorUserId);
    const validReqId = parseUuidV7(input.clientRequestId);
    const requestHash = sha256Hex(
      canonicalizeRecordOrderAdvanceRequest({
        orderId: validOrderId,
        payments: input.payments,
      }),
    );

    return ctx.uow.execute<OrderActionOutcome>((session) => {
      const existingPayRows = session.db
        .select()
        .from(orderPayments)
        .where(
          and(
            eq(orderPayments.organizationId, ctx.organizationId),
            eq(orderPayments.clientRequestId, validReqId),
          ),
        )
        .orderBy(asc(orderPayments.seq))
        .all();
      if (existingPayRows.length > 0) {
        const first = existingPayRows[0];
        if (
          first.storeId !== ctx.storeId ||
          first.orderId !== validOrderId ||
          first.kind !== 'advance' ||
          first.requestHash !== requestHash
        ) {
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            `clientRequestId "${validReqId}" conflicts with another order advance request`,
          );
        }
        const orderRow = requireOrderRowSync(
          session.db,
          ctx.organizationId,
          ctx.storeId,
          validOrderId,
        );
        return Promise.resolve({
          order: loadOrderRecordSync(session.db, orderRow),
          idempotentReplay: true,
        });
      }

      const activeShift = requireOpenShiftSessionSync(session.db, {
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        deviceId: ctx.uow.deviceId,
        actorUserId: validActorId,
      });

      const orderRow = requireOrderRowSync(
        session.db,
        ctx.organizationId,
        ctx.storeId,
        validOrderId,
      );
      const existingPayments = session.db
        .select()
        .from(orderPayments)
        .where(eq(orderPayments.orderId, orderRow.id))
        .all();
      const summary = summarizeOrderPayments(
        existingPayments.map((p) => ({
          kind: parseOrderPaymentKind(p.kind),
          method: parsePaymentMethod(p.method),
          amount: p.amount,
        })),
      );

      const resolved = resolveRecordOrderAdvance({
        orderStatus: parseOrderStatus(orderRow.status),
        orderTotalAmount: orderRow.totalAmount,
        existingNetAdvance: summary.netAdvance,
        payments: input.payments,
      });

      const nowMs = session.nowUnixMs();
      let latestOrderRow = orderRow;
      if (resolved.nextStatus !== orderRow.status) {
        const upd = updateMonotone(session, orders, {
          id: orderRow.id,
          organizationId: ctx.organizationId,
          storeId: ctx.storeId,
          values: {
            status: resolved.nextStatus,
            confirmedAtMs: nowMs,
          },
          eventType: 'order.confirmed',
          schemaVersion: 1,
        });
        latestOrderRow = upd.row;
      }

      for (let idx = 0; idx < resolved.items.length; idx += 1) {
        const item = resolved.items[idx];
        const payWrite = insertFact(session, orderPayments, {
          organizationId: ctx.organizationId,
          storeId: ctx.storeId,
          values: {
            orderId: orderRow.id,
            shiftId: activeShift.shift.id,
            shiftCashierSessionId: activeShift.activeSession.id,
            kind: 'advance',
            method: item.method,
            amount: item.amount,
            tenderedAmount: item.tenderedAmount,
            changeAmount: item.changeAmount,
            providerRef: item.providerRef,
            reason: null,
            createdByUserId: validActorId,
            overrideApprovedByUserId: null,
            seq: idx,
            clientRequestId: validReqId,
            requestHash,
          },
          eventType: 'order_payment.created',
          schemaVersion: 1,
        });

        if (item.method === 'cash' && item.tenderedAmount !== null) {
          insertFact(session, cashMoves, {
            organizationId: ctx.organizationId,
            storeId: ctx.storeId,
            values: {
              shiftId: activeShift.shift.id,
              shiftCashierSessionId: activeShift.activeSession.id,
              type: 'advance_cash_in',
              amountDelta: item.tenderedAmount,
              sourceType: 'order_advance',
              sourceId: payWrite.entityId,
              paymentId: null,
              expenseCategory: null,
              reason: `Order ${orderRow.orderCode} cash advance in`,
              createdByUserId: validActorId,
            },
            eventType: 'cash_move.created',
            schemaVersion: 1,
          });
          if (moneyToTiyin(item.changeAmount) > 0n) {
            insertFact(session, cashMoves, {
              organizationId: ctx.organizationId,
              storeId: ctx.storeId,
              values: {
                shiftId: activeShift.shift.id,
                shiftCashierSessionId: activeShift.activeSession.id,
                type: 'advance_change_out',
                amountDelta: negateMoney(item.changeAmount),
                sourceType: 'order_advance',
                sourceId: payWrite.entityId,
                paymentId: null,
                expenseCategory: null,
                reason: `Order ${orderRow.orderCode} cash advance change out`,
                createdByUserId: validActorId,
              },
              eventType: 'cash_move.created',
              schemaVersion: 1,
            });
          }
        }
      }

      this.testHooks?.onBeforeCommit?.();
      return Promise.resolve({
        order: loadOrderRecordSync(session.db, latestOrderRow),
        idempotentReplay: false,
      });
    });
  }

  async refundOrderAdvance(input: RefundOrderAdvanceInput): Promise<OrderActionOutcome> {
    const ctx = this.requireContext();
    const validOrderId = parseUuidV7(input.orderId);
    const validActorId = parseUuidV7(input.actorUserId);
    const validOverrideId =
      input.overrideApprovedByUserId !== undefined && input.overrideApprovedByUserId !== null
        ? parseUuidV7(input.overrideApprovedByUserId)
        : null;
    const validReqId = parseUuidV7(input.clientRequestId);
    const cleanReason = normalizeMandatoryOrderReason(input.reason, 'reason');
    const requestHash = sha256Hex(
      canonicalizeRefundOrderAdvanceRequest({
        orderId: validOrderId,
        reason: cleanReason,
        refunds: input.refunds,
      }),
    );

    return ctx.uow.execute<OrderActionOutcome>((session) => {
      const existingPayRows = session.db
        .select()
        .from(orderPayments)
        .where(
          and(
            eq(orderPayments.organizationId, ctx.organizationId),
            eq(orderPayments.clientRequestId, validReqId),
          ),
        )
        .orderBy(asc(orderPayments.seq))
        .all();
      if (existingPayRows.length > 0) {
        const first = existingPayRows[0];
        if (
          first.storeId !== ctx.storeId ||
          first.orderId !== validOrderId ||
          first.kind !== 'advance_refund' ||
          first.requestHash !== requestHash
        ) {
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            `clientRequestId "${validReqId}" conflicts with another advance refund request`,
          );
        }
        const orderRow = requireOrderRowSync(
          session.db,
          ctx.organizationId,
          ctx.storeId,
          validOrderId,
        );
        return Promise.resolve({
          order: loadOrderRecordSync(session.db, orderRow),
          idempotentReplay: true,
        });
      }

      assertSupervisorForOrderRefundOrCancelSync(
        session.db,
        ctx.organizationId,
        validActorId,
        validOverrideId,
      );

      const activeShift = requireOpenShiftSessionSync(session.db, {
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        deviceId: ctx.uow.deviceId,
        actorUserId: validActorId,
      });

      const orderRow = requireOrderRowSync(
        session.db,
        ctx.organizationId,
        ctx.storeId,
        validOrderId,
      );
      const existingPayments = session.db
        .select()
        .from(orderPayments)
        .where(eq(orderPayments.orderId, orderRow.id))
        .all();
      const summary = summarizeOrderPayments(
        existingPayments.map((p) => ({
          kind: parseOrderPaymentKind(p.kind),
          method: parsePaymentMethod(p.method),
          amount: p.amount,
        })),
      );

      const resolved = resolveRefundOrderAdvances({
        orderStatus: parseOrderStatus(orderRow.status),
        netAdvanceByMethod: summary.netAdvanceByMethod,
        totalNetAdvance: summary.netAdvance,
        refunds: input.refunds,
      });

      const cashRefundTiyin = moneyToTiyin(resolved.cashRefundAmount);
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
            `Insufficient cash in active drawer for advance refund`,
          );
        }
      }

      for (let idx = 0; idx < resolved.items.length; idx += 1) {
        const item = resolved.items[idx];
        const refWrite = insertFact(session, orderPayments, {
          organizationId: ctx.organizationId,
          storeId: ctx.storeId,
          values: {
            orderId: orderRow.id,
            shiftId: activeShift.shift.id,
            shiftCashierSessionId: activeShift.activeSession.id,
            kind: 'advance_refund',
            method: item.method,
            amount: item.amount,
            tenderedAmount: null,
            changeAmount: ZERO_MONEY,
            providerRef: item.providerRef,
            reason: cleanReason,
            createdByUserId: validActorId,
            overrideApprovedByUserId: validOverrideId,
            seq: idx,
            clientRequestId: validReqId,
            requestHash,
          },
          eventType: 'order_payment.refunded',
          schemaVersion: 1,
        });

        if (item.method === 'cash') {
          insertFact(session, cashMoves, {
            organizationId: ctx.organizationId,
            storeId: ctx.storeId,
            values: {
              shiftId: activeShift.shift.id,
              shiftCashierSessionId: activeShift.activeSession.id,
              type: 'advance_refund_out',
              amountDelta: negateMoney(item.amount),
              sourceType: 'order_advance_refund',
              sourceId: refWrite.entityId,
              paymentId: null,
              expenseCategory: null,
              reason: `Order ${orderRow.orderCode} cash advance refund: ${cleanReason}`,
              createdByUserId: validActorId,
            },
            eventType: 'cash_move.created',
            schemaVersion: 1,
          });
        }
      }

      this.testHooks?.onBeforeCommit?.();
      return Promise.resolve({
        order: loadOrderRecordSync(session.db, orderRow),
        idempotentReplay: false,
      });
    });
  }

  /**
   * O2: Delivers a confirmed/ready order using the frozen O3 snapshot from `orders` + `order_lines`
   * WITHOUT re-pricing through `evaluateCart`. Delegates sale creation, stock deduction, debt ledger,
   * and `'advance'` payment settlement atomically to shared `completeSaleCoreInTxSync` in ONE transaction.
   */
  async deliverOrder(input: DeliverOrderInput): Promise<DeliverOrderOutcome> {
    const ctx = this.requireContext();
    const validOrderId = parseUuidV7(input.orderId);
    const validActorId = parseUuidV7(input.actorUserId);
    const validReqId = parseUuidV7(input.clientRequestId);
    const debtAmount = input.debtAmount ?? ZERO_MONEY;
    const customerOverride =
      input.customerId === undefined
        ? undefined
        : input.customerId === null
          ? null
          : parseUuidV7(input.customerId);
    const dueDays = input.dueDays;
    const creditOverrideApprovedByUserId =
      input.creditOverrideApprovedByUserId !== undefined &&
      input.creditOverrideApprovedByUserId !== null
        ? parseUuidV7(input.creditOverrideApprovedByUserId)
        : null;

    const requestHash = sha256Hex(
      canonicalizeDeliverOrderRequest({
        orderId: validOrderId,
        expectedTotal: input.expectedTotal,
        debtAmount,
        customerId: customerOverride ?? null,
        dueDays: dueDays ?? null,
        additionalPayments: input.payments,
      }),
    );

    return ctx.uow.execute<DeliverOrderOutcome>((session) => {
      const nowMs = session.nowUnixMs();

      // 1) Idempotent replay lookup via orders.deliverClientRequestId
      const replayedOrder = session.db
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.organizationId, ctx.organizationId),
            eq(orders.deliverClientRequestId, validReqId),
          ),
        )
        .limit(1)
        .all()[0];
      if (replayedOrder) {
        if (replayedOrder.id !== validOrderId || replayedOrder.deliverRequestHash !== requestHash) {
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            `clientRequestId "${validReqId}" conflicts with another deliverOrder payload`,
          );
        }
        if (replayedOrder.deliveredSaleId === null) {
          throw new DomainError('VALIDATION_ERROR', 'Delivered order is missing deliveredSaleId');
        }
        const saleRow = session.db
          .select()
          .from(sales)
          .where(eq(sales.id, replayedOrder.deliveredSaleId))
          .limit(1)
          .all()[0];
        const sLines = session.db
          .select()
          .from(saleLines)
          .where(eq(saleLines.saleId, saleRow.id))
          .orderBy(asc(saleLines.sortOrder))
          .all();
        const sPays = session.db
          .select()
          .from(payments)
          .where(eq(payments.saleId, saleRow.id))
          .orderBy(asc(payments.createdAtMs), asc(payments.id))
          .all();
        return Promise.resolve({
          order: loadOrderRecordSync(session.db, replayedOrder),
          sale: toStoredSale(saleRow, sLines, sPays),
          warnings: [],
          idempotentReplay: true,
        });
      }

      // 2) Require valid order state ('confirmed' | 'ready') & active open shift/cashier session (X2)
      const orderRow = requireOrderRowSync(
        session.db,
        ctx.organizationId,
        ctx.storeId,
        validOrderId,
      );
      const currentStatus = parseOrderStatus(orderRow.status);
      assertOrderTransition(currentStatus, 'delivered');

      const activeShift = requireOpenShiftSessionSync(session.db, {
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        deviceId: ctx.uow.deviceId,
        actorUserId: validActorId,
      });

      // 3) Reconstruct frozen O3 line snapshots (O2: NO catalog re-pricing or promo re-evaluation)
      const oLines = session.db
        .select()
        .from(orderLines)
        .where(eq(orderLines.orderId, orderRow.id))
        .orderBy(asc(orderLines.sortOrder))
        .all();
      const oPayRows = session.db
        .select()
        .from(orderPayments)
        .where(eq(orderPayments.orderId, orderRow.id))
        .all();
      const advSummary = summarizeOrderPayments(
        oPayRows.map((p) => ({
          kind: parseOrderPaymentKind(p.kind),
          method: parsePaymentMethod(p.method),
          amount: p.amount,
        })),
      );

      const effectiveCustomerId =
        customerOverride !== undefined ? customerOverride : orderRow.customerId;

      buildDeliverySalePayments({
        orderStatus: currentStatus,
        orderTotalAmount: orderRow.totalAmount,
        netAdvance: advSummary.netAdvance,
        debtAmount,
        customerId: effectiveCustomerId,
        additionalPayments: input.payments,
      });

      const combinedPayments = [
        ...(moneyToTiyin(advSummary.netAdvance) > 0n
          ? [{ method: 'advance' as const, amount: advSummary.netAdvance }]
          : []),
        ...input.payments,
      ];

      // 4) Load active catalog metadata strictly for stock tracking (`unlimited`/`trackBatches`) & negativeStockPolicy
      const hubConfig = readHubConfigRowInDbSync(session.db, ctx.organizationId);
      const negativeStockPolicy = parseNegativeStockPolicy(hubConfig.negativeStockPolicy);

      const productIds = [
        ...new Set(
          oLines
            .filter((l) => l.lineKind === 'catalog' && l.productId !== null)
            .map((l) => l.productId!),
        ),
      ];
      const variantIds = [
        ...new Set(oLines.filter((l) => l.variantId !== null).map((l) => l.variantId!)),
      ];

      const productsById = new Map<UuidV7, typeof products.$inferSelect>();
      if (productIds.length > 0) {
        const pRows = session.db
          .select()
          .from(products)
          .where(
            and(
              eq(products.organizationId, ctx.organizationId),
              inArray(products.id, productIds),
              isNull(products.deletedAtMs),
            ),
          )
          .all();
        for (const p of pRows) {
          productsById.set(p.id, p);
        }
      }
      const variantsById = new Map<UuidV7, typeof productVariants.$inferSelect>();
      if (variantIds.length > 0) {
        const vRows = session.db
          .select()
          .from(productVariants)
          .where(
            and(
              eq(productVariants.organizationId, ctx.organizationId),
              inArray(productVariants.id, variantIds),
              isNull(productVariants.deletedAtMs),
            ),
          )
          .all();
        for (const v of vRows) {
          variantsById.set(v.id, v);
        }
      }

      const frozenLines = oLines.map((l) => ({
        id: l.id,
        sortOrder: l.sortOrder,
        lineKind: l.lineKind as CartLineKind,
        productId: l.productId,
        variantId: l.variantId,
        categoryIdSnapshot: l.categoryIdSnapshot,
        name: l.itemName,
        unit: parseProductUnit(l.unit),
        qty: l.qty,
        unitPriceSnapshot: l.unitPriceSnapshot,
        appliedPromotionId: l.appliedPromotionId,
        appliedPromotionName: l.appliedPromotionName,
        freeUnits: Number(l.freeUnits),
        grossTotal: l.grossTotal,
        promoDiscount: l.promoDiscount,
        subtotalAfterPromo: l.subtotalAfterPromo,
        allocatedOrderDiscount: l.allocatedOrderDiscount,
        finalTotal: l.finalTotal,
        vatRateBpSnapshot: l.vatRateBpSnapshot,
        netExVat: l.netExVat,
        vatTotal: l.vatTotal,
        mxikSnapshot: l.mxikSnapshot,
        packageCodeSnapshot: l.packageCodeSnapshot,
      }));

      const totalFreeUnits = frozenLines.reduce((acc, l) => acc + l.freeUnits, 0);

      // 5) Shared `completeSaleCoreInTxSync` writes `sales` (sourceOrderId), `sale_lines`, `payments` ('advance' + tender),
      //    `stock_moves`, `cash_moves` (NO cash_move for 'advance'), `customer_ledger`, & `local_outbox`
      const coreResult = completeSaleCoreInTxSync(session, {
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        deviceId: ctx.uow.deviceId,
        nowMs,
        activeShift,
        sourceCartId: null,
        sourceOrderId: orderRow.id,
        cashierUserId: orderRow.createdByUserId,
        actorUserId: validActorId,
        clientRequestId: validReqId,
        requestHash,
        expectedTotal: input.expectedTotal,
        debtAmount,
        customerId: effectiveCustomerId,
        dueDays,
        creditOverrideApprovedByUserId,
        payments: combinedPayments,
        allowAdvancePayment: true,
        negativeStockPolicy,
        productsById,
        variantsById,
        evaluated: {
          subtotalGross: orderRow.subtotalGross,
          totalPromoDiscount: orderRow.totalPromoDiscount,
          subtotalAfterPromo: orderRow.subtotalAfterPromo,
          manualDiscountMode: orderRow.manualDiscountMode as ManualDiscountMode,
          manualDiscountValue: orderRow.manualDiscountValue,
          manualDiscountReason: orderRow.manualDiscountReason,
          effectiveOrderDiscount: orderRow.orderDiscountAmount,
          totalFinal: orderRow.totalAmount,
          totalNetExVat: orderRow.totalNetExVat,
          totalVat: orderRow.totalVat,
          totalFreeUnits,
          exceedsCashierLimit: false,
          discountAuthorized: true,
          discountOverrideRequired: false,
          overrideApprovedByUserId: orderRow.overrideApprovedByUserId,
          overrideApprovedAmount: orderRow.overrideApprovedAmount,
          overrideApprovedAtMs:
            orderRow.overrideApprovedByUserId !== null ? orderRow.createdAtMs : null,
          lines: frozenLines,
        },
      });

      // 6) Mark order `'delivered'` atomically in the same transaction
      const deliveredOrder = updateMonotone(session, orders, {
        id: orderRow.id,
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        values: {
          status: 'delivered',
          deliveredAtMs: nowMs,
          deliveredSaleId: coreResult.sale.id,
          deliverClientRequestId: validReqId,
          deliverRequestHash: requestHash,
        },
        eventType: 'order.delivered',
        schemaVersion: 1,
      });

      this.testHooks?.onBeforeCommit?.();

      return Promise.resolve({
        order: toStoredOrder(deliveredOrder.row, oLines, oPayRows),
        sale: coreResult.sale,
        warnings: coreResult.warnings,
        idempotentReplay: false,
      });
    });
  }

  async cancelOrder(input: CancelOrderInput): Promise<OrderActionOutcome> {
    const ctx = this.requireContext();
    const validOrderId = parseUuidV7(input.orderId);
    const validActorId = parseUuidV7(input.actorUserId);
    const validOverrideId =
      input.overrideApprovedByUserId !== undefined && input.overrideApprovedByUserId !== null
        ? parseUuidV7(input.overrideApprovedByUserId)
        : null;
    const validReqId = parseUuidV7(input.clientRequestId);
    const cleanReason = normalizeMandatoryOrderReason(input.reason, 'reason');
    const requestHash = sha256Hex(
      canonicalizeCancelOrderRequest({ orderId: validOrderId, reason: cleanReason }),
    );

    return ctx.uow.execute<OrderActionOutcome>((session) => {
      const nowMs = session.nowUnixMs();

      const replayed = session.db
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.organizationId, ctx.organizationId),
            eq(orders.cancelClientRequestId, validReqId),
          ),
        )
        .limit(1)
        .all()[0];
      if (replayed) {
        if (replayed.id !== validOrderId || replayed.cancelRequestHash !== requestHash) {
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            `clientRequestId "${validReqId}" conflicts with another cancelOrder payload`,
          );
        }
        return Promise.resolve({
          order: loadOrderRecordSync(session.db, replayed),
          idempotentReplay: true,
        });
      }

      assertSupervisorForOrderRefundOrCancelSync(
        session.db,
        ctx.organizationId,
        validActorId,
        validOverrideId,
      );

      const orderRow = requireOrderRowSync(
        session.db,
        ctx.organizationId,
        ctx.storeId,
        validOrderId,
      );
      const currentStatus = parseOrderStatus(orderRow.status);
      assertOrderTransition(currentStatus, 'cancelled');

      const existingPayments = session.db
        .select()
        .from(orderPayments)
        .where(eq(orderPayments.orderId, orderRow.id))
        .all();
      const summary = summarizeOrderPayments(
        existingPayments.map((p) => ({
          kind: parseOrderPaymentKind(p.kind),
          method: parsePaymentMethod(p.method),
          amount: p.amount,
        })),
      );

      const autoRefund = buildAutoCancelOrderRefunds({
        orderStatus: currentStatus,
        netAdvanceByMethod: summary.netAdvanceByMethod,
      });

      if (autoRefund.items.length > 0) {
        const activeShift = requireOpenShiftSessionSync(session.db, {
          organizationId: ctx.organizationId,
          storeId: ctx.storeId,
          deviceId: ctx.uow.deviceId,
          actorUserId: validActorId,
        });

        const cashRefundTiyin = moneyToTiyin(autoRefund.cashRefundAmount);
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
              'Insufficient cash in active drawer to refund cash advance on order cancellation',
            );
          }
        }

        for (let idx = 0; idx < autoRefund.items.length; idx += 1) {
          const item = autoRefund.items[idx];
          const refWrite = insertFact(session, orderPayments, {
            organizationId: ctx.organizationId,
            storeId: ctx.storeId,
            values: {
              orderId: orderRow.id,
              shiftId: activeShift.shift.id,
              shiftCashierSessionId: activeShift.activeSession.id,
              kind: 'advance_refund',
              method: item.method,
              amount: item.amount,
              tenderedAmount: null,
              changeAmount: ZERO_MONEY,
              providerRef: null,
              reason: cleanReason,
              createdByUserId: validActorId,
              overrideApprovedByUserId: validOverrideId,
              seq: idx,
              clientRequestId: validReqId,
              requestHash,
            },
            eventType: 'order_payment.refunded',
            schemaVersion: 1,
          });

          if (item.method === 'cash') {
            insertFact(session, cashMoves, {
              organizationId: ctx.organizationId,
              storeId: ctx.storeId,
              values: {
                shiftId: activeShift.shift.id,
                shiftCashierSessionId: activeShift.activeSession.id,
                type: 'advance_refund_out',
                amountDelta: negateMoney(item.amount),
                sourceType: 'order_advance_refund',
                sourceId: refWrite.entityId,
                paymentId: null,
                expenseCategory: null,
                reason: `Order ${orderRow.orderCode} cancel advance refund: ${cleanReason}`,
                createdByUserId: validActorId,
              },
              eventType: 'cash_move.created',
              schemaVersion: 1,
            });
          }
        }
      }

      const cancelled = updateMonotone(session, orders, {
        id: orderRow.id,
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        values: {
          status: 'cancelled',
          cancelledAtMs: nowMs,
          cancelledByUserId: validActorId,
          cancelReason: cleanReason,
          cancelClientRequestId: validReqId,
          cancelRequestHash: requestHash,
        },
        eventType: 'order.cancelled',
        schemaVersion: 1,
      });

      this.testHooks?.onBeforeCommit?.();

      return Promise.resolve({
        order: loadOrderRecordSync(session.db, cancelled.row),
        idempotentReplay: false,
      });
    });
  }

  getOrder(orderId: UuidV7): Promise<StoredOrderRecord> {
    const ctx = this.requireContext();
    const validOrderId = parseUuidV7(orderId);
    return runConnectionReadOnly(this.connection, () => {
      const row = requireOrderRowSync(
        this.connection.db,
        ctx.organizationId,
        ctx.storeId,
        validOrderId,
      );
      return Promise.resolve(loadOrderRecordSync(this.connection.db, row));
    });
  }

  listOrders(query: ListOrdersQueryInput = {}): Promise<ListOrdersOutcome> {
    const ctx = this.requireContext();
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const offset = Math.max(query.offset ?? 0, 0);
    const validCustomerId =
      query.customerId !== undefined ? parseUuidV7(query.customerId) : undefined;
    const validStatus = query.status !== undefined ? parseOrderStatus(query.status) : undefined;

    return runConnectionReadOnly(this.connection, () => {
      const conds = [
        eq(orders.organizationId, ctx.organizationId),
        eq(orders.storeId, ctx.storeId),
      ];
      if (validStatus !== undefined) {
        conds.push(eq(orders.status, validStatus));
      }
      if (validCustomerId !== undefined) {
        conds.push(eq(orders.customerId, validCustomerId));
      }
      const whereClause = and(...conds);

      const countRow = this.connection.db
        .select({ total: sql<number>`count(*)` })
        .from(orders)
        .where(whereClause)
        .get();
      const total = Number(countRow?.total ?? 0);

      const rows = this.connection.db
        .select()
        .from(orders)
        .where(whereClause)
        .orderBy(desc(orders.createdAtMs), desc(orders.id))
        .limit(limit)
        .offset(offset)
        .all();

      return Promise.resolve({
        orders: rows.map((r) => loadOrderRecordSync(this.connection.db, r)),
        total,
      });
    });
  }

  /**
   * O4: Returns current un-settled customer advance obligation across open orders
   * (`status IN ('draft', 'confirmed', 'ready')`) broken down by payment method.
   */
  getOpenAdvancesTotal(): Promise<OpenAdvancesOutcome> {
    const ctx = this.requireContext();
    return runConnectionReadOnly(this.connection, () => {
      const openCountRow = this.connection.db
        .select({ total: sql<number>`count(*)` })
        .from(orders)
        .where(
          and(
            eq(orders.organizationId, ctx.organizationId),
            eq(orders.storeId, ctx.storeId),
            inArray(orders.status, [...ORDER_OPEN_STATUSES]),
          ),
        )
        .get();

      const openEntries = this.connection.db
        .select({
          orderStatus: orders.status,
          kind: orderPayments.kind,
          method: orderPayments.method,
          amount: orderPayments.amount,
        })
        .from(orderPayments)
        .innerJoin(orders, eq(orders.id, orderPayments.orderId))
        .where(
          and(
            eq(orders.organizationId, ctx.organizationId),
            eq(orders.storeId, ctx.storeId),
            inArray(orders.status, [...ORDER_OPEN_STATUSES]),
          ),
        )
        .all();

      const summary = computeOpenAdvancesAccounting(
        openEntries.map((e) => ({
          orderStatus: parseOrderStatus(e.orderStatus),
          kind: parseOrderPaymentKind(e.kind),
          method: parsePaymentMethod(e.method),
          amount: e.amount,
        })),
      );

      return Promise.resolve({
        totalOpenAdvance: summary.totalOpenAdvance,
        byMethod: summary.byMethod,
        openOrdersCount: Number(openCountRow?.total ?? 0),
      });
    });
  }
}

export function createSqliteOrderStore(options: CreateSqliteOrderStoreOptions): SqliteOrderStore {
  return new SqliteOrderStore(options);
}
