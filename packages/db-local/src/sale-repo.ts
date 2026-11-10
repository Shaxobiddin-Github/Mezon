import {
  type CartLineKind,
  DomainError,
  type ManualDiscountMode,
  type Money,
  type PaymentMethod,
  type ProductUnit,
  type Quantity,
  type ReplayStockPoolState,
  type UnixMs,
  type UuidV7,
  ZERO_MONEY,
  assertCartDiscountAuthorized,
  createEmptyStockPoolState,
  formatReceiptCode,
  moneyFromTiyin,
  moneyToTiyin,
  parseNegativeStockPolicy,
  parseProductUnit,
  parseUuidV7,
  quantityFromMilli,
  quantityToMilli,
  validateCashSalePayment,
  validateSalePaymentsInvariant,
} from '@mezon/domain';
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  evaluateCartRowInDbSync,
  readCartLineRowsInDbSync,
  requireCartRowInDbSync,
} from './cart-repo.js';
import type { LocalSqliteConnection } from './connection.js';
import { advanceReceiptSeqSync } from './device-state.js';
import {
  localBatchBalances,
  localCarts,
  localStockBalances,
  payments,
  saleLines,
  sales,
} from './schema/index.js';
import { type StockMoveWarningRecord, applyOutboundStockMoveSync } from './stock-repo.js';
import type { SqliteUnitOfWork } from './uow.js';
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
  readonly payments: readonly {
    readonly method: 'cash';
    readonly tenderedAmount: Money;
  }[];
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

export interface StoredSaleRecord {
  readonly id: UuidV7;
  readonly receiptNo: bigint;
  readonly receiptCode: string;
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7;
  readonly deviceId: UuidV7;
  readonly sourceCartId: UuidV7 | null;
  readonly cashierUserId: UuidV7;
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

function poolKey(productId: UuidV7, variantId: UuidV7 | null): string {
  return `${productId}:${variantId ?? ''}`;
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

export class SqliteSaleStore {
  private readonly getRuntimeContext: () => SaleRuntimeContext | null;
  private readonly testHooks?: SaleStoreTestHooks;

  constructor(options: CreateSqliteSaleStoreOptions) {
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

  /**
   * Executes the sole authoritative `completeSale` transaction (`GEMINI.md` 3.1.9–3.1.10):
   * - Idempotency check by `(organization_id, client_request_id)` inside `BEGIN IMMEDIATE`.
   * - Re-evaluates cart totals at commit timestamp (`evaluateCartRowInDbSync`) and checks `expectedTotal`.
   * - Enforces cashier/supervisor discount approval (`DISCOUNT_OVERRIDE_REQUIRED`) and payment balance.
   * - Deducts stock via shared `applyOutboundStockMoveSync` without nested `uow.execute`.
   * - Allocates gapless per-device `receipt_no` atomically (`last_receipt_seq`).
   * - Inserts `sales` (`MONOTONE`), `sale_lines` (`FACT`), `payments` (`FACT`), `stock_moves`,
   *   updates `local_carts.status = 'completed'`, and emits all `local_outbox` rows in 1 tx.
   */
  async completeSale(input: CompleteSaleInput): Promise<CompleteSaleOutcome> {
    const ctx = this.requireContext();
    const cartId = parseUuidV7(input.cartId);
    const actorUserId = parseUuidV7(input.actorUserId);
    const clientRequestId = parseUuidV7(input.clientRequestId);

    if (input.payments.length !== 1 || input.payments[0]?.method !== 'cash') {
      throw new DomainError('VALIDATION_ERROR', 'T1.4 supports exactly one cash payment');
    }
    const tenderedAmount = input.payments[0].tenderedAmount;

    return ctx.uow.execute<CompleteSaleOutcome>((session) => {
      // 1) Idempotent replay lookup inside BEGIN IMMEDIATE (prevents double-click/parallel duplicate)
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
        if (existingSale.storeId !== ctx.storeId || existingSale.sourceCartId !== cartId) {
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            `clientRequestId "${clientRequestId}" was already used for another cart or store`,
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

      // 3) Server-side recomputation at current clock time + price/promo/override/payment checks
      const nowMs = session.nowUnixMs();
      const { detail, hubConfig, productsById, variantsById } = evaluateCartRowInDbSync({
        db: session.db,
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        cartRow,
        nowMs,
      });

      const expectedTiyin = moneyToTiyin(input.expectedTotal);
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

      const validatedPayment = validateCashSalePayment({
        totalFinal: detail.totalFinal,
        tenderedAmount,
      });
      validateSalePaymentsInvariant({
        totalFinal: detail.totalFinal,
        debtAmount: ZERO_MONEY,
        payments: [validatedPayment],
      });

      // 4) Validate catalog integrity & batch-prefetch stock pools for all tracked lines
      const negativeStockPolicy = parseNegativeStockPolicy(hubConfig.negativeStockPolicy);
      const trackedProdIds: UuidV7[] = [];
      const batchedProdIds: UuidV7[] = [];
      const trackedKeys = new Set<string>();

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
          trackedProdIds.push(prod.id);
          trackedKeys.add(poolKey(prod.id, line.variantId));
          if (Boolean(prod.trackBatches)) {
            batchedProdIds.push(prod.id);
          }
        }
      }

      const uniqueTrackedProdIds = [...new Set(trackedProdIds)];
      const uniqueBatchedProdIds = [...new Set(batchedProdIds)];
      const sessionPoolCache = new Map<string, ReplayStockPoolState>();

      if (uniqueTrackedProdIds.length > 0) {
        for (const key of trackedKeys) {
          sessionPoolCache.set(key, createEmptyStockPoolState());
        }

        const poolRows = session.db
          .select()
          .from(localStockBalances)
          .where(
            and(
              eq(localStockBalances.organizationId, ctx.organizationId),
              eq(localStockBalances.storeId, ctx.storeId),
              inArray(localStockBalances.productId, uniqueTrackedProdIds),
            ),
          )
          .all();

        for (const row of poolRows) {
          const key = poolKey(row.productId, row.variantId);
          const state = sessionPoolCache.get(key);
          if (state) {
            state.qtyOnHand = row.qtyOnHand;
            state.totalValue = row.totalValue;
            state.deficitQty = row.deficitQty;
            state.provisionalDeficitValue = row.provisionalDeficitValue;
            state.costVarianceValue = row.costVarianceValue;
            state.lastUnitCost = row.lastUnitCost;
          }
        }

        if (uniqueBatchedProdIds.length > 0) {
          const batchRows = session.db
            .select()
            .from(localBatchBalances)
            .where(
              and(
                eq(localBatchBalances.organizationId, ctx.organizationId),
                eq(localBatchBalances.storeId, ctx.storeId),
                inArray(localBatchBalances.productId, uniqueBatchedProdIds),
              ),
            )
            .orderBy(asc(localBatchBalances.hlc), asc(localBatchBalances.batchId))
            .all();

          for (const b of batchRows) {
            const key = poolKey(b.productId, b.variantId);
            const state = sessionPoolCache.get(key);
            if (state) {
              state.batches.set(b.batchId, {
                batchId: b.batchId,
                hlc: b.hlc,
                remainingQty: b.remainingQty,
                remainingValue: b.remainingValue,
              });
            }
          }
        }
      }

      // Cumulative check in 'block' mode so ALL short lines (including duplicate-product lines) fail clearly
      if (negativeStockPolicy === 'block' && trackedKeys.size > 0) {
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
          const key = poolKey(prod.id, line.variantId);
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

      // 5) Allocate gapless device receipt_no inside same transaction (auto-rolled back on abort)
      const receiptNo = advanceReceiptSeqSync(session.internalGetSqlite(), {
        deviceId: ctx.uow.deviceId,
        updatedAtMs: nowMs,
      });
      const receiptCode = formatReceiptCode(ctx.uow.deviceId, receiptNo);

      // 6) Insert `sales` (MONOTONE) first so `sale_lines`, `payments`, and `stock_moves` reference valid saleId
      const saleWrite = insertMonotone(session, sales, {
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        values: {
          receiptNo,
          receiptCode,
          sourceCartId: cartId,
          cashierUserId: cartRow.cashierUserId,
          customerId: null,
          shiftId: null,
          clientRequestId,
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
          totalPaid: validatedPayment.amount,
          debtAmount: ZERO_MONEY,
          changeAmount: validatedPayment.changeAmount,
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

      // 7) Deduct stock (for tracked catalog lines) and insert immutable `sale_lines` (`FACT`)
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

      // 8) Insert immutable cash `payments` row (`FACT`)
      const paymentWrite = insertFact(session, payments, {
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        values: {
          saleId,
          method: validatedPayment.method,
          amount: validatedPayment.amount,
          tenderedAmount: validatedPayment.tenderedAmount,
          changeAmount: validatedPayment.changeAmount,
          providerRef: null,
          providerMetaJson: null,
        },
        eventType: 'payment.created',
        schemaVersion: 1,
      });

      // 9) Mark cart `'completed'` inside the same transaction so subsequent conflicting requests get CART_NOT_OPEN
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
        sale: toStoredSale(saleWrite.row, insertedLines, [paymentWrite.row]),
        warnings: allWarnings,
        idempotentReplay: false,
      });
    });
  }
}

export function createSqliteSaleStore(options: CreateSqliteSaleStoreOptions): SqliteSaleStore {
  return new SqliteSaleStore(options);
}
