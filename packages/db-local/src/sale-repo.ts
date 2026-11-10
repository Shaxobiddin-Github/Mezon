import { createHash } from 'node:crypto';
import {
  type CartLineKind,
  type CashMoveType,
  DomainError,
  MAX_MONEY_TIYIN,
  type ManualDiscountMode,
  type Money,
  type PaymentMethod,
  type ProductUnit,
  type Quantity,
  type SalePaymentInput,
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
import { advanceReceiptSeqSync } from './device-state.js';
import { cashMoves, localCarts, payments, saleLines, sales } from './schema/index.js';
import {
  type StockMoveWarningRecord,
  type StockPoolPrefetchTarget,
  applyOutboundStockMoveSync,
  prefetchMutablePoolStatesSync,
  stockPoolKey,
} from './stock-repo.js';
import { type SqliteUnitOfWork, runConnectionReadOnly } from './uow.js';
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
  readonly method: PaymentMethod;
  readonly amount: Money;
  readonly tenderedAmount: Money | null;
  readonly changeAmount: Money;
  readonly providerRef: string | null;
  readonly createdAtMs: UnixMs;
}

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

export interface StoredSaleRecord {
  readonly id: UuidV7;
  readonly receiptNo: bigint;
  readonly receiptCode: string;
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7;
  readonly deviceId: UuidV7;
  readonly sourceCartId: UuidV7 | null;
  readonly cashierUserId: UuidV7;
  readonly completedByUserId: UuidV7;
  readonly customerId: UuidV7 | null;
  readonly shiftId: UuidV7 | null;
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

function toStoredSaleLine(row: typeof saleLines.$inferSelect): StoredSaleLineRecord {
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

function toStoredSalePayment(row: typeof payments.$inferSelect): StoredSalePaymentRecord {
  return {
    id: row.id,
    method: row.method as PaymentMethod,
    amount: row.amount,
    tenderedAmount: row.tenderedAmount,
    changeAmount: row.changeAmount,
    providerRef: row.providerRef,
    createdAtMs: row.createdAtMs,
  };
}

function toStoredSale(
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
    cashierUserId: row.cashierUserId,
    completedByUserId: row.completedByUserId,
    customerId: row.customerId,
    shiftId: row.shiftId,
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
 * Computes exact cash drawer balance for a specific terminal (`deviceId`) strictly from the
 * append-only `cash_moves` ledger (`SUM(amount_delta)`).
 */
export function getCashDrawerBalanceSync(
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
 * Computes total cash ledger balance across all terminals in a store (`SUM(amount_delta)`).
 */
export function getStoreCashBalanceSync(
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

  async getTerminalCashBalance(deviceId?: UuidV7): Promise<Money> {
    const ctx = this.requireContext();
    const targetDeviceId = deviceId !== undefined ? parseUuidV7(deviceId) : ctx.uow.deviceId;
    return runConnectionReadOnly(this.connection, () =>
      Promise.resolve(
        getCashDrawerBalanceSync(this.connection.db, {
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
        getStoreCashBalanceSync(this.connection.db, {
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

    const incomingRequestHash = computeCompleteSaleRequestHash({
      cartId,
      expectedTotal: input.expectedTotal,
      debtAmount,
      customerId,
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

      // 2) Ensure cart exists in tenant/store and is strictly in 'open' status
      const cartRow = requireCartRowInDbSync(session.db, ctx.organizationId, ctx.storeId, cartId);
      if (cartRow.status !== 'open') {
        throw new DomainError(
          'CART_NOT_OPEN',
          `Cart "${cartId}" is "${cartRow.status}", not "open"`,
        );
      }

      const rawLines = readCartLineRowsInDbSync(session.db, cartId);
      if (rawLines.length === 0) {
        throw new DomainError('CART_EMPTY', 'Cannot complete sale for an empty cart');
      }

      // 3) Server-side recomputation at current clock time + price/promo/override checks
      const nowMs = session.nowUnixMs();
      const { detail, hubConfig, productsById, variantsById } = evaluateCartRowInDbSync({
        db: session.db,
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        cartRow,
        nowMs,
      });

      const expectedTiyin = moneyToTiyin(input.expectedTotal);
      if (expectedTiyin < 0n || expectedTiyin > MAX_MONEY_TIYIN) {
        throw new DomainError(
          'VALIDATION_ERROR',
          `expectedTotal must be between 0 and ${MAX_MONEY_TIYIN.toString()} tiyin`,
        );
      }
      const actualTiyin = moneyToTiyin(detail.totalFinal);
      if (actualTiyin !== expectedTiyin) {
        throw new DomainError(
          'SALE_TOTAL_CHANGED',
          `Sale total changed from ${expectedTiyin.toString()} to ${actualTiyin.toString()}`,
          {
            details: {
              expectedTotal: expectedTiyin.toString(),
              actualTotal: actualTiyin.toString(),
              subtotalGross: moneyToTiyin(detail.subtotalGross).toString(),
              totalPromoDiscount: moneyToTiyin(detail.totalPromoDiscount).toString(),
              effectiveOrderDiscount: moneyToTiyin(detail.effectiveOrderDiscount).toString(),
            },
          },
        );
      }

      assertCartDiscountAuthorized({
        lines: [],
        subtotalGross: detail.subtotalGross,
        totalPromoDiscount: detail.totalPromoDiscount,
        subtotalAfterPromo: detail.subtotalAfterPromo,
        requestedOrderDiscount: detail.requestedOrderDiscount,
        effectiveOrderDiscount: detail.effectiveOrderDiscount,
        totalFinal: detail.totalFinal,
        totalNetExVat: detail.totalNetExVat,
        totalVat: detail.totalVat,
        totalFreeUnits: BigInt(detail.totalFreeUnits),
        exceedsCashierLimit: detail.exceedsCashierLimit,
        discountAuthorized: detail.discountAuthorized,
        discountOverrideRequired: detail.discountOverrideRequired,
      });

      // 4) T1.5 debt & customer gates + mixed payment resolution + strict invariant check against server totalFinal.
      //    T1.7 replaces these gates with real customer registry lookup and `customer_ledger` insert in this tx.
      const debtTiyin = moneyToTiyin(debtAmount);
      if (debtTiyin < 0n || debtTiyin > MAX_MONEY_TIYIN) {
        throw new DomainError(
          'VALIDATION_ERROR',
          `debtAmount must be between 0 and ${MAX_MONEY_TIYIN.toString()} tiyin`,
        );
      }
      if (debtTiyin > 0n) {
        throw new DomainError(
          'CUSTOMER_REQUIRED',
          'Partial or full debt requires a customer ledger (available in T1.7)',
        );
      }
      if (customerId !== null) {
        throw new DomainError(
          'VALIDATION_ERROR',
          'customerId is not supported in T1.5 until T1.7 adds customer registry',
        );
      }

      const resolvedPayments = resolveSalePayments({
        totalFinal: detail.totalFinal,
        debtAmount,
        customerId,
        payments: input.payments,
      });
      validateSalePaymentsInvariant({
        totalFinal: detail.totalFinal,
        debtAmount,
        customerId,
        payments: resolvedPayments.payments,
      });

      // F3 HOOK POINT (`packages/rules`, PF-246 compliance):
      // Evaluate signed legal rule bundle here (banned MXIK cash block, mixed receipt cash ban,
      // 25M UZS limit, prescription/expiry checks) AFTER server totals & payment invariants pass and
      // BEFORE allocating `receipt_no` or modifying inventory/sales/payments/cash_moves.

      // 5) Validate catalog integrity & batch-prefetch full mutable pool states via stock-repo's single loader
      const negativeStockPolicy = parseNegativeStockPolicy(hubConfig.negativeStockPolicy);
      const trackedTargets: StockPoolPrefetchTarget[] = [];

      for (const line of detail.lines) {
        if (line.lineKind !== 'catalog' || line.productId === null) {
          continue;
        }
        const prod = productsById.get(line.productId);
        if (!prod) {
          throw new DomainError(
            'PRODUCT_NOT_FOUND',
            `Catalog product "${line.productId}" is missing or deleted`,
          );
        }
        if (line.variantId !== null) {
          const variant = variantsById.get(line.variantId);
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
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        targets: trackedTargets,
      });

      // Cumulative check in 'block' mode so ALL short lines (including duplicate-product lines) fail clearly
      if (negativeStockPolicy === 'block' && sessionPoolCache.size > 0) {
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

        for (const line of detail.lines) {
          if (line.lineKind !== 'catalog' || line.productId === null) {
            continue;
          }
          const prod = productsById.get(line.productId);
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

      // 6) Allocate gapless device receipt_no inside same transaction (auto-rolled back on abort)
      const receiptNo = advanceReceiptSeqSync(session.internalGetSqlite(), {
        deviceId: ctx.uow.deviceId,
        updatedAtMs: nowMs,
      });
      const receiptCode = formatReceiptCode(ctx.uow.deviceId, receiptNo);

      // 7) Insert `sales` (MONOTONE) first so `sale_lines`, `payments`, and `cash_moves` reference valid saleId
      const saleWrite = insertMonotone(session, sales, {
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        values: {
          receiptNo,
          receiptCode,
          sourceCartId: cartId,
          cashierUserId: cartRow.cashierUserId,
          completedByUserId: actorUserId,
          customerId: null,
          shiftId: null,
          clientRequestId,
          requestHash: incomingRequestHash,
          subtotalGross: detail.subtotalGross,
          totalPromoDiscount: detail.totalPromoDiscount,
          subtotalAfterPromo: detail.subtotalAfterPromo,
          manualDiscountMode: detail.manualDiscountMode,
          manualDiscountValue: detail.manualDiscountValue,
          manualDiscountReason: detail.manualDiscountReason,
          orderDiscountAmount: detail.effectiveOrderDiscount,
          totalFinal: detail.totalFinal,
          totalNetExVat: detail.totalNetExVat,
          totalVat: detail.totalVat,
          totalPaid: resolvedPayments.totalPaid,
          debtAmount: resolvedPayments.debtAmount,
          changeAmount: resolvedPayments.changeAmount,
          overrideApprovedByUserId: detail.overrideApprovedByUserId,
          overrideApprovedAmount: detail.overrideApprovedAmount,
          overrideApprovedAtMs: detail.overrideApprovedAtMs,
          voidedAtMs: null,
          voidedByUserId: null,
          voidReason: null,
        },
        eventType: 'sale.completed',
        schemaVersion: 1,
      });
      const saleId = saleWrite.entityId;

      // 8) Deduct stock (for tracked catalog lines) and insert immutable `sale_lines` (`FACT`)
      const allWarnings: StockMoveWarningRecord[] = [];
      const insertedLines: (typeof saleLines.$inferSelect)[] = [];

      for (const line of detail.lines) {
        let lineCostTiyin = 0n;

        if (line.lineKind === 'catalog' && line.productId !== null) {
          const prod = productsById.get(line.productId)!;
          if (!prod.unlimited) {
            const stockOut = applyOutboundStockMoveSync(session, {
              organizationId: ctx.organizationId,
              storeId: ctx.storeId,
              productId: prod.id,
              variantId: line.variantId,
              reason: 'sale',
              needQty: line.qty,
              overridePolicy: negativeStockPolicy,
              sourceType: 'sale',
              sourceId: saleId,
              note: `Sale receipt ${receiptCode}`,
              actorUserId,
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
          organizationId: ctx.organizationId,
          storeId: ctx.storeId,
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

      // 9) Insert immutable `payments` (`FACT`) & atomic `cash_moves` (`FACT`) in the same transaction
      const insertedPayments: (typeof payments.$inferSelect)[] = [];
      for (const item of resolvedPayments.payments) {
        const paymentWrite = insertFact(session, payments, {
          organizationId: ctx.organizationId,
          storeId: ctx.storeId,
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
            organizationId: ctx.organizationId,
            storeId: ctx.storeId,
            values: {
              shiftId: null,
              type: 'sale_cash_in',
              amountDelta: item.tenderedAmount,
              sourceType: 'sale',
              sourceId: saleId,
              paymentId: paymentWrite.entityId,
              reason: `Sale receipt ${receiptCode} cash in`,
              createdByUserId: actorUserId,
            },
            eventType: 'cash_move.created',
            schemaVersion: 1,
          });

          if (moneyToTiyin(item.changeAmount) > 0n) {
            insertFact(session, cashMoves, {
              organizationId: ctx.organizationId,
              storeId: ctx.storeId,
              values: {
                shiftId: null,
                type: 'sale_change_out',
                amountDelta: negateMoney(item.changeAmount),
                sourceType: 'sale',
                sourceId: saleId,
                paymentId: paymentWrite.entityId,
                reason: `Sale receipt ${receiptCode} change out`,
                createdByUserId: actorUserId,
              },
              eventType: 'cash_move.created',
              schemaVersion: 1,
            });
          }
        }
      }

      // 10) Mark cart `'completed'` inside the same transaction so subsequent conflicting requests get CART_NOT_OPEN
      session.db
        .update(localCarts)
        .set({
          status: 'completed',
          parkedAtMs: null,
          completedSaleId: saleId,
          completedAtMs: nowMs,
          completionWarningsJson: serializeWarnings(allWarnings),
          updatedAtMs: nowMs,
        })
        .where(eq(localCarts.id, cartId))
        .run();

      // Test-only crash injection hook (`C1`): never wired in Hub/Electron production binaries
      this.testHooks?.onBeforeCommit?.();

      return Promise.resolve({
        sale: toStoredSale(saleWrite.row, insertedLines, insertedPayments),
        warnings: allWarnings,
        idempotentReplay: false,
      });
    });
  }
}

export function createSqliteSaleStore(options: CreateSqliteSaleStoreOptions): SqliteSaleStore {
  return new SqliteSaleStore(options);
}
