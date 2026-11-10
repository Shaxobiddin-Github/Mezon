import {
  DomainError,
  type InventoryCountStatus,
  type Money,
  type NegativeStockPolicy,
  type ProductUnit,
  type Quantity,
  type ReplayStockConflict,
  type ReplayStockPoolState,
  type StockConflictReason,
  type StockMoveReason,
  type StockSourceType,
  type UnixMs,
  type UuidV7,
  ZERO_MONEY,
  ZERO_QUANTITY,
  applyReplayStockMove,
  computeSurplusCostValue,
  createEmptyStockPoolState,
  moneyFromTiyin,
  moneyToTiyin,
  parseNegativeStockPolicy,
  parseProductUnit,
  parseStockMoveReason,
  parseUuidV7,
  planAverageOutboundCost,
  planFifoOutboundLegs,
  quantityFromMilli,
  quantityToMilli,
  validateNonNegativeCountQuantity,
  validatePositiveStockQuantity,
  validateStockMoveDirection,
} from '@mezon/domain';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { LocalSqliteConnection } from './connection.js';
import {
  batches,
  categories,
  inventoryCountLines,
  inventoryCounts,
  localBatchBalances,
  localHubConfig,
  localStockBalances,
  localStockConflicts,
  productVariants,
  products,
  stockMoves,
} from './schema/index.js';
import {
  type SqliteUnitOfWork,
  type SqliteUnitOfWorkSession,
  runConnectionProjectionMaintenance,
} from './uow.js';
import { insertFact, insertMonotone, updateMonotone } from './writers.js';

export interface StockRuntimeContext {
  readonly uow: SqliteUnitOfWork;
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7;
}

export interface CreateSqliteStockStoreOptions {
  readonly connection: LocalSqliteConnection;
  readonly getRuntimeContext: () => StockRuntimeContext | null;
}

export interface StoredCashierBalanceRecord {
  readonly productId: UuidV7;
  readonly variantId: UuidV7 | null;
  readonly productName: string;
  readonly unit: ProductUnit;
  readonly unlimited: boolean;
  readonly trackBatches: boolean;
  readonly minStock: Quantity | null;
  readonly qtyOnHand: Quantity | null;
  readonly isLowStock: boolean;
}

export interface StoredStockValuationRecord {
  readonly productId: UuidV7;
  readonly variantId: UuidV7 | null;
  readonly productName: string;
  readonly unit: ProductUnit;
  readonly trackBatches: boolean;
  readonly qtyOnHand: Quantity;
  readonly totalValue: Money;
  readonly deficitQty: Quantity;
  readonly provisionalDeficitValue: Money;
  readonly costVarianceValue: Money;
  readonly lastUnitCost: Money | null;
  readonly updatedAtMs: UnixMs;
}

export interface StoredBatchRecord {
  readonly id: UuidV7;
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7;
  readonly productId: UuidV7;
  readonly variantId: UuidV7 | null;
  readonly batchNumber: string | null;
  readonly expiryDateMs: UnixMs | null;
  readonly initialQty: Quantity;
  readonly initialCostValue: Money;
  readonly remainingQty: Quantity;
  readonly remainingValue: Money;
  readonly createdAtMs: UnixMs;
}

export interface StoredStockMoveRecord {
  readonly id: UuidV7;
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7;
  readonly productId: UuidV7;
  readonly variantId: UuidV7 | null;
  readonly batchId: UuidV7 | null;
  readonly qtyDelta: Quantity;
  readonly costValueDelta: Money;
  readonly reason: StockMoveReason;
  readonly sourceType: string;
  readonly sourceId: UuidV7;
  readonly createdByUserId: UuidV7;
  readonly note: string | null;
  readonly createdAtMs: UnixMs;
}

export interface StockMoveWarningRecord {
  readonly code: 'NEGATIVE_STOCK';
  readonly productId: UuidV7;
  readonly variantId: UuidV7 | null;
  readonly deficitQty: Quantity;
}

export interface CreateStockMovesOutcome {
  readonly moves: readonly StoredStockMoveRecord[];
  readonly batch: StoredBatchRecord | null;
  readonly warnings: readonly StockMoveWarningRecord[];
}

export interface StoredStockConflictRecord {
  readonly id: UuidV7;
  readonly productId: UuidV7;
  readonly variantId: UuidV7 | null;
  readonly batchId: UuidV7 | null;
  readonly moveId: UuidV7 | null;
  readonly conflictQty: Quantity;
  readonly reason: StockConflictReason;
  readonly detail: string | null;
  readonly resolvedAtMs: UnixMs | null;
  readonly createdAtMs: UnixMs;
}

export interface StoredInventoryCountRecord {
  readonly id: UuidV7;
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7;
  readonly status: InventoryCountStatus;
  readonly startedByUserId: UuidV7;
  readonly finalizedByUserId: UuidV7 | null;
  readonly finalizedAtMs: UnixMs | null;
  readonly note: string | null;
  readonly createdAtMs: UnixMs;
  readonly updatedAtMs: UnixMs;
}

export interface StoredInventoryCountLineRecord {
  readonly id: UuidV7;
  readonly countId: UuidV7;
  readonly productId: UuidV7;
  readonly variantId: UuidV7 | null;
  readonly expectedQtyAtCount: Quantity | null;
  readonly countedQty: Quantity | null;
  readonly adjustmentQty: Quantity | null;
  readonly updatedAtMs: UnixMs;
}

export interface StoredInventoryCountDetailRecord {
  readonly count: StoredInventoryCountRecord;
  readonly lines: readonly StoredInventoryCountLineRecord[];
}

export interface FinalizeInventoryCountOutcome {
  readonly count: StoredInventoryCountRecord;
  readonly lines: readonly StoredInventoryCountLineRecord[];
  readonly adjustmentMoves: readonly StoredStockMoveRecord[];
  readonly conflicts: readonly StoredStockConflictRecord[];
}

export interface RebuildStockProjectionsResult {
  readonly balancesRebuilt: number;
  readonly batchesRebuilt: number;
  readonly movesReplayed: number;
  readonly conflictsDetected: number;
}

function poolKey(productId: UuidV7, variantId: UuidV7 | null): string {
  return `${productId}:${variantId ?? ''}`;
}

function toStoredMove(row: typeof stockMoves.$inferSelect): StoredStockMoveRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    storeId: row.storeId,
    productId: row.productId,
    variantId: row.variantId,
    batchId: row.batchId,
    qtyDelta: row.qtyDelta,
    costValueDelta: row.costValueDelta,
    reason: parseStockMoveReason(row.reason),
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    createdByUserId: row.createdByUserId,
    note: row.note,
    createdAtMs: row.createdAtMs,
  };
}

function toStoredInventoryCount(
  row: typeof inventoryCounts.$inferSelect,
): StoredInventoryCountRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    storeId: row.storeId,
    status: row.status as InventoryCountStatus,
    startedByUserId: row.startedByUserId,
    finalizedByUserId: row.finalizedByUserId,
    finalizedAtMs: row.finalizedAtMs,
    note: row.note,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

function toStoredInventoryCountLine(
  row: typeof inventoryCountLines.$inferSelect,
): StoredInventoryCountLineRecord {
  return {
    id: row.id,
    countId: row.countId,
    productId: row.productId,
    variantId: row.variantId,
    expectedQtyAtCount: row.expectedQtyAtCount,
    countedQty: row.countedQty,
    adjustmentQty: row.adjustmentQty,
    updatedAtMs: row.updatedAtMs,
  };
}

function toStoredConflict(row: typeof localStockConflicts.$inferSelect): StoredStockConflictRecord {
  return {
    id: row.id,
    productId: row.productId,
    variantId: row.variantId,
    batchId: row.batchId,
    moveId: row.moveId,
    conflictQty: row.conflictQty,
    reason: row.reason as StockConflictReason,
    detail: row.detail,
    resolvedAtMs: row.resolvedAtMs,
    createdAtMs: row.createdAtMs,
  };
}

export interface OutboundStockMoveSessionParams {
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7;
  readonly productId: UuidV7;
  readonly variantId: UuidV7 | null;
  readonly reason: StockMoveReason;
  readonly needQty: Quantity;
  readonly overridePolicy?: NegativeStockPolicy;
  readonly sourceType: StockSourceType;
  readonly sourceId: UuidV7;
  readonly note: string | null;
  readonly actorUserId: UuidV7;
  /** Optional prefetched tracked product row from the same UoW session (avoids N+1 queries). */
  readonly prefetchedProduct?: typeof products.$inferSelect;
  /** Optional prefetched pool-state cache shared across multiple lines in one transaction. */
  readonly sessionPoolCache?: Map<string, ReplayStockPoolState>;
}

export interface OutboundStockMoveSessionOutcome {
  readonly moves: readonly StoredStockMoveRecord[];
  readonly warnings: readonly StockMoveWarningRecord[];
}

function requireTrackedProductSync(
  session: SqliteUnitOfWorkSession,
  organizationId: UuidV7,
  productId: UuidV7,
  variantId: UuidV7 | null,
  prefetchedProduct?: typeof products.$inferSelect,
): {
  readonly product: typeof products.$inferSelect;
  readonly variant: typeof productVariants.$inferSelect | null;
} {
  const product =
    prefetchedProduct ??
    session.db
      .select()
      .from(products)
      .where(
        and(
          eq(products.id, productId),
          eq(products.organizationId, organizationId),
          isNull(products.deletedAtMs),
        ),
      )
      .limit(1)
      .all()[0];
  if (!product || product.deletedAtMs !== null) {
    throw new DomainError('PRODUCT_NOT_FOUND', `Product "${productId}" was not found`);
  }
  if (Boolean(product.unlimited)) {
    throw new DomainError(
      'UNLIMITED_PRODUCT_STOCK_NOT_TRACKED',
      `Unlimited product "${product.name}" does not track stock`,
    );
  }

  let variant: typeof productVariants.$inferSelect | null = null;
  if (variantId !== null && prefetchedProduct === undefined) {
    variant =
      session.db
        .select()
        .from(productVariants)
        .where(
          and(
            eq(productVariants.id, variantId),
            eq(productVariants.organizationId, organizationId),
            eq(productVariants.productId, productId),
            isNull(productVariants.deletedAtMs),
          ),
        )
        .limit(1)
        .all()[0] ?? null;
    if (!variant) {
      throw new DomainError(
        'VARIANT_NOT_FOUND',
        `Variant "${variantId}" was not found for product "${productId}"`,
      );
    }
  }

  return { product, variant };
}

function readPoolRowSync(
  session: SqliteUnitOfWorkSession,
  organizationId: UuidV7,
  storeId: UuidV7,
  productId: UuidV7,
  variantId: UuidV7 | null,
): typeof localStockBalances.$inferSelect | null {
  return (
    session.db
      .select()
      .from(localStockBalances)
      .where(
        and(
          eq(localStockBalances.organizationId, organizationId),
          eq(localStockBalances.storeId, storeId),
          eq(localStockBalances.productId, productId),
          variantId === null
            ? isNull(localStockBalances.variantId)
            : eq(localStockBalances.variantId, variantId),
        ),
      )
      .limit(1)
      .all()[0] ?? null
  );
}

function loadMutablePoolStateSync(
  session: SqliteUnitOfWorkSession,
  organizationId: UuidV7,
  storeId: UuidV7,
  productId: UuidV7,
  variantId: UuidV7 | null,
  trackBatches: boolean,
): ReplayStockPoolState {
  const state = createEmptyStockPoolState();
  const row = readPoolRowSync(session, organizationId, storeId, productId, variantId);
  if (row) {
    state.qtyOnHand = row.qtyOnHand;
    state.totalValue = row.totalValue;
    state.deficitQty = row.deficitQty;
    state.provisionalDeficitValue = row.provisionalDeficitValue;
    state.costVarianceValue = row.costVarianceValue;
    state.lastUnitCost = row.lastUnitCost;
  }

  if (trackBatches) {
    const batchRows = session.db
      .select()
      .from(localBatchBalances)
      .where(
        and(
          eq(localBatchBalances.organizationId, organizationId),
          eq(localBatchBalances.storeId, storeId),
          eq(localBatchBalances.productId, productId),
          variantId === null
            ? isNull(localBatchBalances.variantId)
            : eq(localBatchBalances.variantId, variantId),
        ),
      )
      .orderBy(asc(localBatchBalances.hlc), asc(localBatchBalances.batchId))
      .all();

    for (const b of batchRows) {
      state.batches.set(b.batchId, {
        batchId: b.batchId,
        hlc: b.hlc,
        remainingQty: b.remainingQty,
        remainingValue: b.remainingValue,
      });
    }
  }

  return state;
}

function savePoolAndBatchesSync(
  session: SqliteUnitOfWorkSession,
  organizationId: UuidV7,
  storeId: UuidV7,
  productId: UuidV7,
  variantId: UuidV7 | null,
  state: ReplayStockPoolState,
  nowMs: UnixMs,
  touchedBatchIds: readonly UuidV7[],
): void {
  const existing = readPoolRowSync(session, organizationId, storeId, productId, variantId);
  if (existing) {
    session.db
      .update(localStockBalances)
      .set({
        qtyOnHand: state.qtyOnHand,
        totalValue: state.totalValue,
        deficitQty: state.deficitQty,
        provisionalDeficitValue: state.provisionalDeficitValue,
        costVarianceValue: state.costVarianceValue,
        lastUnitCost: state.lastUnitCost,
        updatedAtMs: nowMs,
      })
      .where(eq(localStockBalances.id, existing.id))
      .run();
  } else {
    session.db
      .insert(localStockBalances)
      .values({
        id: session.nextId(),
        organizationId,
        storeId,
        productId,
        variantId,
        qtyOnHand: state.qtyOnHand,
        totalValue: state.totalValue,
        deficitQty: state.deficitQty,
        provisionalDeficitValue: state.provisionalDeficitValue,
        costVarianceValue: state.costVarianceValue,
        lastUnitCost: state.lastUnitCost,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      })
      .run();
  }

  for (const batchId of touchedBatchIds) {
    const mem = state.batches.get(batchId);
    if (!mem) {
      continue;
    }
    const existingBatch = session.db
      .select({ id: localBatchBalances.id })
      .from(localBatchBalances)
      .where(eq(localBatchBalances.batchId, batchId))
      .limit(1)
      .all()[0];
    if (existingBatch) {
      session.db
        .update(localBatchBalances)
        .set({
          remainingQty: mem.remainingQty,
          remainingValue: mem.remainingValue,
          updatedAtMs: nowMs,
        })
        .where(eq(localBatchBalances.id, existingBatch.id))
        .run();
    } else {
      session.db
        .insert(localBatchBalances)
        .values({
          id: session.nextId(),
          organizationId,
          storeId,
          batchId: mem.batchId,
          productId,
          variantId,
          hlc: mem.hlc,
          remainingQty: mem.remainingQty,
          remainingValue: mem.remainingValue,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
        })
        .run();
    }
  }
}

/**
 * Authoritative internal session helper for outbound stock moves (FIFO batch & average costing,
 * negative stock policy, balance projections, and `stock_move.created` outbox event).
 * Shared directly by standalone `SqliteStockStore.recordOutboundMove` and `completeSale` so
 * there is no nested `uow.execute` and no duplicated stock logic.
 */
export function applyOutboundStockMoveSync(
  session: SqliteUnitOfWorkSession,
  params: OutboundStockMoveSessionParams,
): OutboundStockMoveSessionOutcome {
  session.assertActiveTransaction();
  const { product } = requireTrackedProductSync(
    session,
    params.organizationId,
    params.productId,
    params.variantId,
    params.prefetchedProduct,
  );
  const unit = parseProductUnit(product.unit);
  const needQty = validatePositiveStockQuantity(unit, params.needQty);
  const trackBatches = Boolean(product.trackBatches);
  const nowMs = session.nowUnixMs();

  const policy =
    params.overridePolicy ??
    parseNegativeStockPolicy(
      session.db
        .select({ policy: localHubConfig.negativeStockPolicy })
        .from(localHubConfig)
        .limit(1)
        .all()[0]?.policy ?? 'warn',
    );

  const key = poolKey(params.productId, params.variantId);
  const cachedState = params.sessionPoolCache?.get(key);
  const poolState =
    cachedState ??
    loadMutablePoolStateSync(
      session,
      params.organizationId,
      params.storeId,
      params.productId,
      params.variantId,
      trackBatches,
    );
  if (params.sessionPoolCache && !cachedState) {
    params.sessionPoolCache.set(key, poolState);
  }

  const writtenMoves: StoredStockMoveRecord[] = [];
  const warnings: StockMoveWarningRecord[] = [];
  const touchedBatchIds: UuidV7[] = [];

  if (trackBatches) {
    const orderedBatches = [...poolState.batches.values()]
      .filter((b) => quantityToMilli(b.remainingQty) > 0n)
      .sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : a.batchId < b.batchId ? -1 : 1));

    const plan = planFifoOutboundLegs({
      batches: orderedBatches,
      needQty,
      lastUnitCost: poolState.lastUnitCost,
      negativePolicy: policy,
    });

    for (const leg of plan.legs) {
      const moveWrite = insertFact(session, stockMoves, {
        organizationId: params.organizationId,
        storeId: params.storeId,
        values: {
          productId: params.productId,
          variantId: params.variantId,
          batchId: leg.batchId,
          qtyDelta: quantityFromMilli(-quantityToMilli(leg.qty)),
          costValueDelta: moneyFromTiyin(-moneyToTiyin(leg.costValue)),
          reason: params.reason,
          sourceType: params.sourceType,
          sourceId: params.sourceId,
          createdByUserId: params.actorUserId,
          note: params.note,
        },
        eventType: 'stock_move.created',
        schemaVersion: 1,
      });

      applyReplayStockMove(poolState, {
        moveId: moveWrite.entityId,
        productId: params.productId,
        variantId: params.variantId,
        batchId: leg.batchId,
        hlc: moveWrite.hlc,
        reason: params.reason,
        qtyDelta: quantityFromMilli(-quantityToMilli(leg.qty)),
        costValueDelta: moneyFromTiyin(-moneyToTiyin(leg.costValue)),
        trackBatches: true,
      });
      if (leg.batchId !== null) {
        touchedBatchIds.push(leg.batchId);
      }
      writtenMoves.push(toStoredMove(moveWrite.row));
    }

    if (plan.negativeStockWarning) {
      warnings.push({
        code: 'NEGATIVE_STOCK',
        productId: params.productId,
        variantId: params.variantId,
        deficitQty: poolState.deficitQty,
      });
    }
  } else {
    const plan = planAverageOutboundCost({
      qtyOnHand: poolState.qtyOnHand,
      totalValue: poolState.totalValue,
      lastUnitCost: poolState.lastUnitCost,
      needQty,
      negativePolicy: policy,
    });

    const moveWrite = insertFact(session, stockMoves, {
      organizationId: params.organizationId,
      storeId: params.storeId,
      values: {
        productId: params.productId,
        variantId: params.variantId,
        batchId: null,
        qtyDelta: quantityFromMilli(-quantityToMilli(needQty)),
        costValueDelta: moneyFromTiyin(-moneyToTiyin(plan.costValue)),
        reason: params.reason,
        sourceType: params.sourceType,
        sourceId: params.sourceId,
        createdByUserId: params.actorUserId,
        note: params.note,
      },
      eventType: 'stock_move.created',
      schemaVersion: 1,
    });

    applyReplayStockMove(poolState, {
      moveId: moveWrite.entityId,
      productId: params.productId,
      variantId: params.variantId,
      batchId: null,
      hlc: moveWrite.hlc,
      reason: params.reason,
      qtyDelta: quantityFromMilli(-quantityToMilli(needQty)),
      costValueDelta: moneyFromTiyin(-moneyToTiyin(plan.costValue)),
      trackBatches: false,
    });
    writtenMoves.push(toStoredMove(moveWrite.row));

    if (plan.negativeStockWarning) {
      warnings.push({
        code: 'NEGATIVE_STOCK',
        productId: params.productId,
        variantId: params.variantId,
        deficitQty: poolState.deficitQty,
      });
    }
  }

  savePoolAndBatchesSync(
    session,
    params.organizationId,
    params.storeId,
    params.productId,
    params.variantId,
    poolState,
    nowMs,
    touchedBatchIds,
  );

  return { moves: writtenMoves, warnings };
}

function parsePositiveBigInt(
  raw: string,
  code: 'INVALID_UNIT_QUANTITY' | 'VALIDATION_ERROR',
): bigint {
  if (!/^\d+$/.test(raw)) {
    throw new DomainError(code, 'Must be a non-negative integer string');
  }
  return BigInt(raw);
}

function formatConflictDetail(conflict: ReplayStockConflict): string {
  switch (conflict.reason) {
    case 'BATCH_OVERCONSUMED':
      return `Batch "${conflict.batchId ?? 'unknown'}" over-consumed by ${quantityToMilli(conflict.conflictQty).toString()} milli-units at move "${conflict.moveId}"`;
    case 'UNKNOWN_COST_SURPLUS':
      return `Positive inventory surplus of ${quantityToMilli(conflict.conflictQty).toString()} milli-units recorded with zero cost because prior cost is unknown (move "${conflict.moveId}")`;
    case 'ORPHAN_BATCH_REFERENCE':
      return `Outbound move "${conflict.moveId}" references missing batch "${conflict.batchId ?? 'unknown'}"`;
  }
}

/**
 * Rebuilds all local stock projection tables (`local_stock_balances`, `local_batch_balances`,
 * `local_stock_conflicts`) cleanly from authoritative FACT `stock_moves` + `batches` ordered
 * deterministically by `(hlc ASC, id ASC)` (`S2`, never emits outbox events, never fails on CHECKs).
 */
export async function rebuildStockProjections(
  connection: LocalSqliteConnection,
  scope: {
    readonly organizationId: UuidV7;
    readonly storeId: UuidV7;
    readonly nextId: () => UuidV7;
    readonly nowUnixMs: () => UnixMs;
  },
): Promise<RebuildStockProjectionsResult> {
  const organizationId = parseUuidV7(scope.organizationId);
  const storeId = parseUuidV7(scope.storeId);

  return runConnectionProjectionMaintenance(connection, (_sqlite, db) => {
    const nowMs = scope.nowUnixMs();

    const prodRows = db
      .select({
        id: products.id,
        trackBatches: products.trackBatches,
      })
      .from(products)
      .where(eq(products.organizationId, organizationId))
      .all();

    const trackBatchesByProduct = new Map<UuidV7, boolean>();
    for (const p of prodRows) {
      trackBatchesByProduct.set(p.id, Boolean(p.trackBatches));
    }

    const moveRows = db
      .select()
      .from(stockMoves)
      .where(and(eq(stockMoves.organizationId, organizationId), eq(stockMoves.storeId, storeId)))
      .orderBy(asc(stockMoves.hlc), asc(stockMoves.id))
      .all();

    const pools = new Map<
      string,
      {
        readonly productId: UuidV7;
        readonly variantId: UuidV7 | null;
        readonly state: ReplayStockPoolState;
      }
    >();
    const allConflicts: ReplayStockConflict[] = [];

    for (const m of moveRows) {
      const key = poolKey(m.productId, m.variantId);
      let entry = pools.get(key);
      if (!entry) {
        entry = {
          productId: m.productId,
          variantId: m.variantId,
          state: createEmptyStockPoolState(),
        };
        pools.set(key, entry);
      }

      const trackBatches = trackBatchesByProduct.get(m.productId) ?? false;
      const emitted = applyReplayStockMove(entry.state, {
        moveId: m.id,
        productId: m.productId,
        variantId: m.variantId,
        batchId: m.batchId,
        hlc: m.hlc,
        reason: parseStockMoveReason(m.reason),
        qtyDelta: m.qtyDelta,
        costValueDelta: m.costValueDelta,
        trackBatches,
      });
      allConflicts.push(...emitted);
    }

    // Clear existing LOCAL projection & conflict cache for this store only
    db.delete(localBatchBalances)
      .where(
        and(
          eq(localBatchBalances.organizationId, organizationId),
          eq(localBatchBalances.storeId, storeId),
        ),
      )
      .run();
    db.delete(localStockBalances)
      .where(
        and(
          eq(localStockBalances.organizationId, organizationId),
          eq(localStockBalances.storeId, storeId),
        ),
      )
      .run();
    db.delete(localStockConflicts)
      .where(
        and(
          eq(localStockConflicts.organizationId, organizationId),
          eq(localStockConflicts.storeId, storeId),
        ),
      )
      .run();

    let balancesRebuilt = 0;
    let batchesRebuilt = 0;

    for (const entry of pools.values()) {
      const s = entry.state;
      db.insert(localStockBalances)
        .values({
          id: scope.nextId(),
          organizationId,
          storeId,
          productId: entry.productId,
          variantId: entry.variantId,
          qtyOnHand: s.qtyOnHand,
          totalValue: s.totalValue,
          deficitQty: s.deficitQty,
          provisionalDeficitValue: s.provisionalDeficitValue,
          costVarianceValue: s.costVarianceValue,
          lastUnitCost: s.lastUnitCost,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
        })
        .run();
      balancesRebuilt += 1;

      for (const b of s.batches.values()) {
        db.insert(localBatchBalances)
          .values({
            id: scope.nextId(),
            organizationId,
            storeId,
            batchId: b.batchId,
            productId: entry.productId,
            variantId: entry.variantId,
            hlc: b.hlc,
            remainingQty: b.remainingQty,
            remainingValue: b.remainingValue,
            createdAtMs: nowMs,
            updatedAtMs: nowMs,
          })
          .run();
        batchesRebuilt += 1;
      }
    }

    for (const c of allConflicts) {
      db.insert(localStockConflicts)
        .values({
          id: scope.nextId(),
          organizationId,
          storeId,
          productId: c.productId,
          variantId: c.variantId,
          batchId: c.batchId,
          moveId: c.moveId,
          conflictQty: c.conflictQty,
          reason: c.reason,
          detail: formatConflictDetail(c),
          resolvedAtMs: null,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
        })
        .run();
    }

    return {
      balancesRebuilt,
      batchesRebuilt,
      movesReplayed: moveRows.length,
      conflictsDetected: allConflicts.length,
    };
  });
}

export class SqliteStockStore {
  private readonly connection: LocalSqliteConnection;
  private readonly getRuntimeContext: () => StockRuntimeContext | null;

  constructor(options: CreateSqliteStockStoreOptions) {
    this.connection = options.connection;
    this.getRuntimeContext = options.getRuntimeContext;
  }

  private requireContext(): StockRuntimeContext {
    const ctx = this.getRuntimeContext();
    if (ctx === null) {
      throw new DomainError('AUTH_UNAUTHORIZED', 'Hub setup has not been completed');
    }
    return ctx;
  }

  async getNegativeStockPolicy(): Promise<NegativeStockPolicy> {
    const { uow } = this.requireContext();
    return uow.runReadOnly(() => {
      const row = this.connection.db
        .select({ policy: localHubConfig.negativeStockPolicy })
        .from(localHubConfig)
        .limit(1)
        .all()[0];
      return Promise.resolve(parseNegativeStockPolicy(row?.policy ?? 'warn'));
    });
  }

  async setNegativeStockPolicy(policy: NegativeStockPolicy): Promise<NegativeStockPolicy> {
    const { uow } = this.requireContext();
    const valid = parseNegativeStockPolicy(policy);

    return uow.execute((session) => {
      const nowMs = session.nowUnixMs();
      session.db
        .update(localHubConfig)
        .set({
          negativeStockPolicy: valid,
          updatedAtMs: nowMs,
        })
        .where(eq(localHubConfig.singletonGuard, 1))
        .run();
      return Promise.resolve(valid);
    });
  }

  async listCashierBalances(): Promise<readonly StoredCashierBalanceRecord[]> {
    const { uow, organizationId, storeId } = this.requireContext();

    return uow.runReadOnly(() => {
      const activeProds = this.connection.db
        .select()
        .from(products)
        .where(and(eq(products.organizationId, organizationId), isNull(products.deletedAtMs)))
        .orderBy(asc(products.nameSearch), asc(products.id))
        .all();

      const balanceRows = this.connection.db
        .select()
        .from(localStockBalances)
        .where(
          and(
            eq(localStockBalances.organizationId, organizationId),
            eq(localStockBalances.storeId, storeId),
          ),
        )
        .all();

      const balanceByKey = new Map<string, typeof localStockBalances.$inferSelect>();
      const variantsByProd = new Map<UuidV7, (typeof localStockBalances.$inferSelect)[]>();
      for (const b of balanceRows) {
        balanceByKey.set(poolKey(b.productId, b.variantId), b);
        if (b.variantId !== null) {
          const list = variantsByProd.get(b.productId) ?? [];
          list.push(b);
          variantsByProd.set(b.productId, list);
        }
      }

      const result: StoredCashierBalanceRecord[] = [];
      for (const p of activeProds) {
        const unit = parseProductUnit(p.unit);
        const unlimited = Boolean(p.unlimited);
        const trackBatches = Boolean(p.trackBatches);
        const minStock = p.minStock;
        const baseBal = balanceByKey.get(poolKey(p.id, null));
        const varBals = variantsByProd.get(p.id);

        if (unlimited || !varBals || varBals.length === 0 || baseBal) {
          const qtyOnHand = unlimited ? null : (baseBal?.qtyOnHand ?? ZERO_QUANTITY);
          const isLowStock =
            !unlimited &&
            minStock !== null &&
            qtyOnHand !== null &&
            quantityToMilli(qtyOnHand) <= quantityToMilli(minStock);
          result.push({
            productId: p.id,
            variantId: null,
            productName: p.name,
            unit,
            unlimited,
            trackBatches,
            minStock,
            qtyOnHand,
            isLowStock,
          });
        }

        if (!unlimited && varBals) {
          for (const vb of varBals) {
            const isLowStock =
              minStock !== null && quantityToMilli(vb.qtyOnHand) <= quantityToMilli(minStock);
            result.push({
              productId: p.id,
              variantId: vb.variantId,
              productName: p.name,
              unit,
              unlimited: false,
              trackBatches,
              minStock,
              qtyOnHand: vb.qtyOnHand,
              isLowStock,
            });
          }
        }
      }

      return Promise.resolve(result);
    });
  }

  async listStockValuations(): Promise<readonly StoredStockValuationRecord[]> {
    const { uow, organizationId, storeId } = this.requireContext();

    return uow.runReadOnly(() => {
      const balRows = this.connection.db
        .select()
        .from(localStockBalances)
        .where(
          and(
            eq(localStockBalances.organizationId, organizationId),
            eq(localStockBalances.storeId, storeId),
          ),
        )
        .all();

      const prodRows = this.connection.db
        .select()
        .from(products)
        .where(and(eq(products.organizationId, organizationId), isNull(products.deletedAtMs)))
        .all();

      const prodMap = new Map<UuidV7, typeof products.$inferSelect>();
      for (const p of prodRows) {
        prodMap.set(p.id, p);
      }

      const items: StoredStockValuationRecord[] = [];
      for (const b of balRows) {
        const p = prodMap.get(b.productId);
        if (!p) {
          continue;
        }
        items.push({
          productId: b.productId,
          variantId: b.variantId,
          productName: p.name,
          unit: parseProductUnit(p.unit),
          trackBatches: Boolean(p.trackBatches),
          qtyOnHand: b.qtyOnHand,
          totalValue: b.totalValue,
          deficitQty: b.deficitQty,
          provisionalDeficitValue: b.provisionalDeficitValue,
          costVarianceValue: b.costVarianceValue,
          lastUnitCost: b.lastUnitCost,
          updatedAtMs: b.updatedAtMs,
        });
      }

      items.sort((a, b) =>
        a.productName < b.productName ? -1 : a.productName > b.productName ? 1 : 0,
      );
      return Promise.resolve(items);
    });
  }

  async listBatches(
    filter: {
      readonly productId?: UuidV7;
      readonly includeEmpty?: boolean;
      readonly limit?: number;
      readonly offset?: number;
    } = {},
  ): Promise<readonly StoredBatchRecord[]> {
    const { uow, organizationId, storeId } = this.requireContext();
    const limit = filter.limit ?? 50;
    const offset = filter.offset ?? 0;

    return uow.runReadOnly(() => {
      const conds = [eq(batches.organizationId, organizationId), eq(batches.storeId, storeId)];
      if (filter.productId !== undefined) {
        conds.push(eq(batches.productId, parseUuidV7(filter.productId)));
      }

      const rows = this.connection.db
        .select({
          batch: batches,
          remainingQty: localBatchBalances.remainingQty,
          remainingValue: localBatchBalances.remainingValue,
        })
        .from(batches)
        .leftJoin(localBatchBalances, eq(localBatchBalances.batchId, batches.id))
        .where(and(...conds))
        .orderBy(asc(batches.hlc), asc(batches.id))
        .all();

      const filtered = filter.includeEmpty
        ? rows
        : rows.filter((r) => quantityToMilli(r.remainingQty ?? ZERO_QUANTITY) > 0n);

      return Promise.resolve(
        filtered.slice(offset, offset + limit).map((r) => ({
          id: r.batch.id,
          organizationId: r.batch.organizationId,
          storeId: r.batch.storeId,
          productId: r.batch.productId,
          variantId: r.batch.variantId,
          batchNumber: r.batch.batchNumber,
          expiryDateMs: r.batch.expiryDateMs,
          initialQty: r.batch.initialQty,
          initialCostValue: r.batch.initialCostValue,
          remainingQty: r.remainingQty ?? ZERO_QUANTITY,
          remainingValue: r.remainingValue ?? ZERO_MONEY,
          createdAtMs: r.batch.createdAtMs,
        })),
      );
    });
  }

  async listStockMoves(
    filter: {
      readonly productId?: UuidV7;
      readonly limit?: number;
      readonly offset?: number;
    } = {},
  ): Promise<readonly StoredStockMoveRecord[]> {
    const { uow, organizationId, storeId } = this.requireContext();
    const limit = filter.limit ?? 50;
    const offset = filter.offset ?? 0;

    return uow.runReadOnly(() => {
      const conds = [
        eq(stockMoves.organizationId, organizationId),
        eq(stockMoves.storeId, storeId),
      ];
      if (filter.productId !== undefined) {
        conds.push(eq(stockMoves.productId, parseUuidV7(filter.productId)));
      }

      const rows = this.connection.db
        .select()
        .from(stockMoves)
        .where(and(...conds))
        .orderBy(desc(stockMoves.hlc), desc(stockMoves.id))
        .limit(limit)
        .offset(offset)
        .all();

      return Promise.resolve(rows.map(toStoredMove));
    });
  }

  async listConflicts(): Promise<readonly StoredStockConflictRecord[]> {
    const { uow, organizationId, storeId } = this.requireContext();

    return uow.runReadOnly(() => {
      const rows = this.connection.db
        .select()
        .from(localStockConflicts)
        .where(
          and(
            eq(localStockConflicts.organizationId, organizationId),
            eq(localStockConflicts.storeId, storeId),
          ),
        )
        .orderBy(desc(localStockConflicts.createdAtMs), desc(localStockConflicts.id))
        .all();

      return Promise.resolve(rows.map(toStoredConflict));
    });
  }

  async recordInboundMove(input: {
    readonly productId: UuidV7;
    readonly variantId?: UuidV7 | null;
    readonly reason: StockMoveReason;
    readonly qty: string;
    readonly totalCostValue: string;
    readonly batchNumber?: string | null;
    readonly expiryDateMs?: string | null;
    readonly sourceType?: StockSourceType;
    readonly sourceId?: UuidV7;
    readonly note?: string | null;
    readonly actorUserId: UuidV7;
  }): Promise<CreateStockMovesOutcome> {
    const { uow, organizationId, storeId } = this.requireContext();
    const productId = parseUuidV7(input.productId);
    const variantId = input.variantId ? parseUuidV7(input.variantId) : null;
    const actorUserId = parseUuidV7(input.actorUserId);
    const reason = parseStockMoveReason(input.reason);
    validateStockMoveDirection(reason, 'in');

    const qty = quantityFromMilli(parsePositiveBigInt(input.qty, 'INVALID_UNIT_QUANTITY'));
    const totalCostValue = moneyFromTiyin(
      parsePositiveBigInt(input.totalCostValue, 'VALIDATION_ERROR'),
    );
    const expiryDateMs =
      input.expiryDateMs !== undefined && input.expiryDateMs !== null
        ? (parsePositiveBigInt(input.expiryDateMs, 'VALIDATION_ERROR') as UnixMs)
        : null;
    const batchNumber = input.batchNumber?.trim() ? input.batchNumber.trim() : null;
    const note = input.note?.trim() ? input.note.trim() : null;

    return uow.execute((session) => {
      const outcome = this.applyInboundInsideSessionSync(session, {
        organizationId,
        storeId,
        productId,
        variantId,
        reason,
        qty,
        totalCostValue,
        batchNumber,
        expiryDateMs,
        sourceType: input.sourceType ?? 'stock_entry',
        sourceId: input.sourceId ? parseUuidV7(input.sourceId) : session.nextId(),
        note,
        actorUserId,
      });
      return Promise.resolve({
        moves: [outcome.move],
        batch: outcome.batch,
        warnings: [],
      });
    });
  }

  async recordOutboundMove(input: {
    readonly productId: UuidV7;
    readonly variantId?: UuidV7 | null;
    readonly reason: StockMoveReason;
    readonly qty: string;
    readonly policy?: NegativeStockPolicy;
    readonly sourceType?: StockSourceType;
    readonly sourceId?: UuidV7;
    readonly note?: string | null;
    readonly actorUserId: UuidV7;
  }): Promise<CreateStockMovesOutcome> {
    const { uow, organizationId, storeId } = this.requireContext();
    const productId = parseUuidV7(input.productId);
    const variantId = input.variantId ? parseUuidV7(input.variantId) : null;
    const actorUserId = parseUuidV7(input.actorUserId);
    const reason = parseStockMoveReason(input.reason);
    validateStockMoveDirection(reason, 'out');
    const needQty = quantityFromMilli(parsePositiveBigInt(input.qty, 'INVALID_UNIT_QUANTITY'));
    const overridePolicy =
      input.policy !== undefined ? parseNegativeStockPolicy(input.policy) : undefined;
    const note = input.note?.trim() ? input.note.trim() : null;

    return uow.execute((session) => {
      const outcome = applyOutboundStockMoveSync(session, {
        organizationId,
        storeId,
        productId,
        variantId,
        reason,
        needQty,
        overridePolicy,
        sourceType: input.sourceType ?? 'adjustment',
        sourceId: input.sourceId ? parseUuidV7(input.sourceId) : session.nextId(),
        note,
        actorUserId,
      });
      return Promise.resolve({
        moves: outcome.moves,
        batch: null,
        warnings: outcome.warnings,
      });
    });
  }

  async startInventoryCount(input: {
    readonly productIds?: readonly UuidV7[];
    readonly categoryId?: UuidV7;
    readonly note?: string | null;
    readonly actorUserId: UuidV7;
  }): Promise<StoredInventoryCountDetailRecord> {
    const { uow, organizationId, storeId } = this.requireContext();
    const actorUserId = parseUuidV7(input.actorUserId);
    const categoryId = input.categoryId ? parseUuidV7(input.categoryId) : undefined;
    const explicitProductIds = input.productIds?.map((id) => parseUuidV7(id));
    const note = input.note?.trim() ? input.note.trim() : null;

    return uow.execute((session) => {
      const countRes = insertMonotone(session, inventoryCounts, {
        organizationId,
        storeId,
        values: {
          status: 'open',
          startedByUserId: actorUserId,
          finalizedByUserId: null,
          finalizedAtMs: null,
          note,
        },
        eventType: 'inventory_count.started',
        schemaVersion: 1,
      });

      const targetProducts = this.resolveInventoryCountProductsSync(session, organizationId, {
        productIds: explicitProductIds,
        categoryId,
      });

      const createdLines: StoredInventoryCountLineRecord[] = [];
      for (const p of targetProducts) {
        if (Boolean(p.unlimited)) {
          if (explicitProductIds !== undefined) {
            throw new DomainError(
              'UNLIMITED_PRODUCT_STOCK_NOT_TRACKED',
              `Unlimited product "${p.name}" cannot be included in stock inventory counts`,
            );
          }
          continue;
        }

        const lineRes = insertMonotone(session, inventoryCountLines, {
          organizationId,
          storeId,
          values: {
            countId: countRes.entityId,
            productId: p.id,
            variantId: null,
            expectedQtyAtCount: null,
            countedQty: null,
            adjustmentQty: null,
          },
          eventType: 'inventory_count_line.created',
          schemaVersion: 1,
        });
        createdLines.push(toStoredInventoryCountLine(lineRes.row));
      }

      return Promise.resolve({
        count: toStoredInventoryCount(countRes.row),
        lines: createdLines,
      });
    });
  }

  async getInventoryCountDetail(countId: UuidV7): Promise<StoredInventoryCountDetailRecord> {
    const { uow, organizationId, storeId } = this.requireContext();
    const targetId = parseUuidV7(countId);

    return uow.runReadOnly(() => {
      const countRow = this.connection.db
        .select()
        .from(inventoryCounts)
        .where(
          and(
            eq(inventoryCounts.id, targetId),
            eq(inventoryCounts.organizationId, organizationId),
            eq(inventoryCounts.storeId, storeId),
          ),
        )
        .limit(1)
        .all()[0];

      if (!countRow) {
        throw new DomainError(
          'INVENTORY_COUNT_NOT_FOUND',
          `Inventory count "${targetId}" was not found`,
        );
      }

      const lineRows = this.connection.db
        .select()
        .from(inventoryCountLines)
        .where(eq(inventoryCountLines.countId, targetId))
        .orderBy(asc(inventoryCountLines.id))
        .all();

      return Promise.resolve({
        count: toStoredInventoryCount(countRow),
        lines: lineRows.map(toStoredInventoryCountLine),
      });
    });
  }

  /**
   * Records physical counts for lines inside an open inventory count (`S1`):
   * At the exact moment `countedQty` is entered or re-entered, queries the authoritative ledger
   * balance (`SUM(qty_delta)` from `stock_moves`) in the same active UoW transaction and stores
   * it in `expected_qty_at_count`. Re-counting overwrites `expected_qty_at_count` with the latest
   * snapshot; `countedQty: null` leaves the line uncounted.
   */
  async recordInventoryCountLines(
    countId: UuidV7,
    lines: ReadonlyArray<{
      readonly productId: UuidV7;
      readonly variantId?: UuidV7 | null;
      readonly countedQty: string | null;
    }>,
  ): Promise<StoredInventoryCountDetailRecord> {
    const { uow, organizationId, storeId } = this.requireContext();
    const targetCountId = parseUuidV7(countId);

    return uow.execute((session) => {
      const countRow = this.requireOpenInventoryCountSync(
        session,
        organizationId,
        storeId,
        targetCountId,
      );

      for (const item of lines) {
        const productId = parseUuidV7(item.productId);
        const variantId = item.variantId ? parseUuidV7(item.variantId) : null;
        const { product } = requireTrackedProductSync(
          session,
          organizationId,
          productId,
          variantId,
        );
        const unit = parseProductUnit(product.unit);

        const existingLine = this.findInventoryCountLineSync(
          session,
          targetCountId,
          productId,
          variantId,
        );

        if (item.countedQty === null) {
          if (existingLine) {
            updateMonotone(session, inventoryCountLines, {
              id: existingLine.id,
              organizationId,
              storeId,
              values: {
                expectedQtyAtCount: null,
                countedQty: null,
                adjustmentQty: null,
              },
              eventType: 'inventory_count_line.updated',
              schemaVersion: 1,
            });
          } else {
            insertMonotone(session, inventoryCountLines, {
              organizationId,
              storeId,
              values: {
                countId: targetCountId,
                productId,
                variantId,
                expectedQtyAtCount: null,
                countedQty: null,
                adjustmentQty: null,
              },
              eventType: 'inventory_count_line.created',
              schemaVersion: 1,
            });
          }
          continue;
        }

        const countedQty = validateNonNegativeCountQuantity(
          unit,
          quantityFromMilli(parsePositiveBigInt(item.countedQty, 'INVALID_UNIT_QUANTITY')),
        );
        const expectedAtCount = this.readLedgerQtySumSync(
          session,
          organizationId,
          storeId,
          productId,
          variantId,
        );

        if (existingLine) {
          updateMonotone(session, inventoryCountLines, {
            id: existingLine.id,
            organizationId,
            storeId,
            values: {
              expectedQtyAtCount: expectedAtCount,
              countedQty,
              adjustmentQty: null,
            },
            eventType: 'inventory_count_line.updated',
            schemaVersion: 1,
          });
        } else {
          insertMonotone(session, inventoryCountLines, {
            organizationId,
            storeId,
            values: {
              countId: targetCountId,
              productId,
              variantId,
              expectedQtyAtCount: expectedAtCount,
              countedQty,
              adjustmentQty: null,
            },
            eventType: 'inventory_count_line.created',
            schemaVersion: 1,
          });
        }
      }

      const updatedLines = session.db
        .select()
        .from(inventoryCountLines)
        .where(eq(inventoryCountLines.countId, targetCountId))
        .orderBy(asc(inventoryCountLines.id))
        .all();

      return Promise.resolve({
        count: toStoredInventoryCount(countRow),
        lines: updatedLines.map(toStoredInventoryCountLine),
      });
    });
  }

  /**
   * Atomically finalizes an open inventory count (`S1`, `S3`, `S4`):
   * - Uncounted lines (`counted_qty IS NULL`) emit NO adjustments.
   * - Counted lines compute `adjustment = counted_qty - expected_qty_at_count`.
   * - Positive adjustments create surplus stock moves (and batches for FIFO items) using `S4`
   *   valuation (`UNKNOWN_COST_SURPLUS` logged to `local_stock_conflicts` when prior cost unknown).
   * - Negative adjustments consume via FIFO/average (`warn` policy).
   * - Lines are finalized BEFORE closing `inventory_counts.status = 'finalized'` to obey S3 trigger.
   */
  async finalizeInventoryCount(
    countId: UuidV7,
    actorUserId: UuidV7,
  ): Promise<FinalizeInventoryCountOutcome> {
    const { uow, organizationId, storeId } = this.requireContext();
    const targetCountId = parseUuidV7(countId);
    const actorId = parseUuidV7(actorUserId);

    return uow.execute((session) => {
      this.requireOpenInventoryCountSync(session, organizationId, storeId, targetCountId);

      const lineRows = session.db
        .select()
        .from(inventoryCountLines)
        .where(eq(inventoryCountLines.countId, targetCountId))
        .orderBy(asc(inventoryCountLines.id))
        .all();

      const adjustmentMoves: StoredStockMoveRecord[] = [];
      const createdConflicts: StoredStockConflictRecord[] = [];
      const finalizedLines: StoredInventoryCountLineRecord[] = [];

      for (const line of lineRows) {
        if (line.countedQty === null) {
          finalizedLines.push(toStoredInventoryCountLine(line));
          continue;
        }

        const expected = line.expectedQtyAtCount ?? ZERO_QUANTITY;
        const adjMilli = quantityToMilli(line.countedQty) - quantityToMilli(expected);
        const adjustmentQty = quantityFromMilli(adjMilli);

        const updatedLineRes = updateMonotone(session, inventoryCountLines, {
          id: line.id,
          organizationId,
          storeId,
          values: {
            adjustmentQty,
          },
          eventType: 'inventory_count_line.finalized',
          schemaVersion: 1,
        });
        finalizedLines.push(toStoredInventoryCountLine(updatedLineRes.row));

        if (adjMilli === 0n) {
          continue;
        }

        if (adjMilli > 0n) {
          const { product } = requireTrackedProductSync(
            session,
            organizationId,
            line.productId,
            line.variantId,
          );
          const poolRow = readPoolRowSync(
            session,
            organizationId,
            storeId,
            line.productId,
            line.variantId,
          );
          const surplus = computeSurplusCostValue({
            trackBatches: Boolean(product.trackBatches),
            adjustmentQty,
            qtyOnHand: poolRow?.qtyOnHand ?? ZERO_QUANTITY,
            totalValue: poolRow?.totalValue ?? ZERO_MONEY,
            lastUnitCost: poolRow?.lastUnitCost ?? null,
          });

          const inboundOut = this.applyInboundInsideSessionSync(session, {
            organizationId,
            storeId,
            productId: line.productId,
            variantId: line.variantId,
            reason: 'inventory',
            qty: adjustmentQty,
            totalCostValue: surplus.costValue,
            batchNumber: null,
            expiryDateMs: null,
            sourceType: 'inventory_count',
            sourceId: targetCountId,
            note: 'Inventory surplus adjustment',
            actorUserId: actorId,
          });
          adjustmentMoves.push(inboundOut.move);
          createdConflicts.push(...inboundOut.conflicts);
        } else {
          const needQty = quantityFromMilli(-adjMilli);
          const outboundOut = applyOutboundStockMoveSync(session, {
            organizationId,
            storeId,
            productId: line.productId,
            variantId: line.variantId,
            reason: 'inventory',
            needQty,
            overridePolicy: 'warn',
            sourceType: 'inventory_count',
            sourceId: targetCountId,
            note: 'Inventory shortage adjustment',
            actorUserId: actorId,
          });
          adjustmentMoves.push(...outboundOut.moves);
        }
      }

      const closedCountRes = updateMonotone(session, inventoryCounts, {
        id: targetCountId,
        organizationId,
        storeId,
        values: {
          status: 'finalized',
          finalizedByUserId: actorId,
          finalizedAtMs: session.nowUnixMs(),
        },
        eventType: 'inventory_count.finalized',
        schemaVersion: 1,
      });

      return Promise.resolve({
        count: toStoredInventoryCount(closedCountRes.row),
        lines: finalizedLines,
        adjustmentMoves,
        conflicts: createdConflicts,
      });
    });
  }

  async cancelInventoryCount(
    countId: UuidV7,
    actorUserId: UuidV7,
  ): Promise<StoredInventoryCountRecord> {
    const { uow, organizationId, storeId } = this.requireContext();
    const targetCountId = parseUuidV7(countId);
    const actorId = parseUuidV7(actorUserId);

    return uow.execute((session) => {
      this.requireOpenInventoryCountSync(session, organizationId, storeId, targetCountId);

      const closed = updateMonotone(session, inventoryCounts, {
        id: targetCountId,
        organizationId,
        storeId,
        values: {
          status: 'cancelled',
          finalizedByUserId: actorId,
          finalizedAtMs: session.nowUnixMs(),
        },
        eventType: 'inventory_count.cancelled',
        schemaVersion: 1,
      });

      return Promise.resolve(toStoredInventoryCount(closed.row));
    });
  }

  async rebuildProjections(): Promise<RebuildStockProjectionsResult> {
    const { uow, organizationId, storeId } = this.requireContext();
    return rebuildStockProjections(this.connection, {
      organizationId,
      storeId,
      nextId: () => uow.internalNextId(),
      nowUnixMs: () => uow.internalCurrentUuidMs(),
    });
  }

  // --- Internal synchronous transactional helpers (invoked strictly inside active UoW session) ---

  private applyInboundInsideSessionSync(
    session: SqliteUnitOfWorkSession,
    params: {
      readonly organizationId: UuidV7;
      readonly storeId: UuidV7;
      readonly productId: UuidV7;
      readonly variantId: UuidV7 | null;
      readonly reason: StockMoveReason;
      readonly qty: Quantity;
      readonly totalCostValue: Money;
      readonly batchNumber: string | null;
      readonly expiryDateMs: UnixMs | null;
      readonly sourceType: StockSourceType;
      readonly sourceId: UuidV7;
      readonly note: string | null;
      readonly actorUserId: UuidV7;
    },
  ): {
    readonly move: StoredStockMoveRecord;
    readonly batch: StoredBatchRecord | null;
    readonly conflicts: readonly StoredStockConflictRecord[];
  } {
    const { product } = requireTrackedProductSync(
      session,
      params.organizationId,
      params.productId,
      params.variantId,
    );
    const unit = parseProductUnit(product.unit);
    const validQty = validatePositiveStockQuantity(unit, params.qty);
    const trackBatches = Boolean(product.trackBatches);
    const nowMs = session.nowUnixMs();

    const poolState = loadMutablePoolStateSync(
      session,
      params.organizationId,
      params.storeId,
      params.productId,
      params.variantId,
      trackBatches,
    );

    let createdBatchRow: typeof batches.$inferSelect | null = null;
    if (trackBatches) {
      const batchWrite = insertFact(session, batches, {
        organizationId: params.organizationId,
        storeId: params.storeId,
        values: {
          productId: params.productId,
          variantId: params.variantId,
          batchNumber: params.batchNumber,
          expiryDateMs: params.expiryDateMs,
          initialQty: validQty,
          initialCostValue: params.totalCostValue,
          supplierId: null,
        },
        eventType: 'batch.created',
        schemaVersion: 1,
      });
      createdBatchRow = batchWrite.row;
    }

    const moveWrite = insertFact(session, stockMoves, {
      organizationId: params.organizationId,
      storeId: params.storeId,
      values: {
        productId: params.productId,
        variantId: params.variantId,
        batchId: createdBatchRow?.id ?? null,
        qtyDelta: validQty,
        costValueDelta: params.totalCostValue,
        reason: params.reason,
        sourceType: params.sourceType,
        sourceId: params.sourceId,
        createdByUserId: params.actorUserId,
        note: params.note,
      },
      eventType: 'stock_move.created',
      schemaVersion: 1,
    });

    const emittedConflicts = applyReplayStockMove(poolState, {
      moveId: moveWrite.entityId,
      productId: params.productId,
      variantId: params.variantId,
      batchId: createdBatchRow?.id ?? null,
      hlc: moveWrite.hlc,
      reason: params.reason,
      qtyDelta: validQty,
      costValueDelta: params.totalCostValue,
      trackBatches,
    });

    savePoolAndBatchesSync(
      session,
      params.organizationId,
      params.storeId,
      params.productId,
      params.variantId,
      poolState,
      nowMs,
      createdBatchRow !== null ? [createdBatchRow.id] : [],
    );

    const savedConflicts = this.persistConflictsSync(
      session,
      params.organizationId,
      params.storeId,
      emittedConflicts,
      nowMs,
    );

    let batchRecord: StoredBatchRecord | null = null;
    if (createdBatchRow !== null) {
      const batchBal = poolState.batches.get(createdBatchRow.id);
      batchRecord = {
        id: createdBatchRow.id,
        organizationId: createdBatchRow.organizationId,
        storeId: createdBatchRow.storeId,
        productId: createdBatchRow.productId,
        variantId: createdBatchRow.variantId,
        batchNumber: createdBatchRow.batchNumber,
        expiryDateMs: createdBatchRow.expiryDateMs,
        initialQty: createdBatchRow.initialQty,
        initialCostValue: createdBatchRow.initialCostValue,
        remainingQty: batchBal?.remainingQty ?? ZERO_QUANTITY,
        remainingValue: batchBal?.remainingValue ?? ZERO_MONEY,
        createdAtMs: createdBatchRow.createdAtMs,
      };
    }

    return {
      move: toStoredMove(moveWrite.row),
      batch: batchRecord,
      conflicts: savedConflicts,
    };
  }

  private persistConflictsSync(
    session: SqliteUnitOfWorkSession,
    organizationId: UuidV7,
    storeId: UuidV7,
    conflicts: readonly ReplayStockConflict[],
    nowMs: UnixMs,
  ): StoredStockConflictRecord[] {
    const out: StoredStockConflictRecord[] = [];
    for (const c of conflicts) {
      const id = session.nextId();
      const row = {
        id,
        organizationId,
        storeId,
        productId: c.productId,
        variantId: c.variantId,
        batchId: c.batchId,
        moveId: c.moveId,
        conflictQty: c.conflictQty,
        reason: c.reason,
        detail: formatConflictDetail(c),
        resolvedAtMs: null,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      };
      session.db.insert(localStockConflicts).values(row).run();
      out.push(toStoredConflict(row));
    }
    return out;
  }

  private readLedgerQtySumSync(
    session: SqliteUnitOfWorkSession,
    organizationId: UuidV7,
    storeId: UuidV7,
    productId: UuidV7,
    variantId: UuidV7 | null,
  ): Quantity {
    const row = session.db
      .select({
        totalMilli: sql<bigint>`coalesce(sum(${stockMoves.qtyDelta}), 0)`,
      })
      .from(stockMoves)
      .where(
        and(
          eq(stockMoves.organizationId, organizationId),
          eq(stockMoves.storeId, storeId),
          eq(stockMoves.productId, productId),
          variantId === null ? isNull(stockMoves.variantId) : eq(stockMoves.variantId, variantId),
        ),
      )
      .all()[0];

    const raw = row?.totalMilli ?? 0n;
    return quantityFromMilli(typeof raw === 'bigint' ? raw : BigInt(raw));
  }

  private requireOpenInventoryCountSync(
    session: SqliteUnitOfWorkSession,
    organizationId: UuidV7,
    storeId: UuidV7,
    countId: UuidV7,
  ): typeof inventoryCounts.$inferSelect {
    const row = session.db
      .select()
      .from(inventoryCounts)
      .where(
        and(
          eq(inventoryCounts.id, countId),
          eq(inventoryCounts.organizationId, organizationId),
          eq(inventoryCounts.storeId, storeId),
        ),
      )
      .limit(1)
      .all()[0];

    if (!row) {
      throw new DomainError(
        'INVENTORY_COUNT_NOT_FOUND',
        `Inventory count "${countId}" was not found`,
      );
    }
    if (row.status !== 'open') {
      throw new DomainError(
        'INVENTORY_COUNT_NOT_OPEN',
        `Inventory count "${countId}" is "${row.status}" and cannot be modified`,
      );
    }
    return row;
  }

  private findInventoryCountLineSync(
    session: SqliteUnitOfWorkSession,
    countId: UuidV7,
    productId: UuidV7,
    variantId: UuidV7 | null,
  ): typeof inventoryCountLines.$inferSelect | null {
    return (
      session.db
        .select()
        .from(inventoryCountLines)
        .where(
          and(
            eq(inventoryCountLines.countId, countId),
            eq(inventoryCountLines.productId, productId),
            variantId === null
              ? isNull(inventoryCountLines.variantId)
              : eq(inventoryCountLines.variantId, variantId),
          ),
        )
        .limit(1)
        .all()[0] ?? null
    );
  }

  private resolveInventoryCountProductsSync(
    session: SqliteUnitOfWorkSession,
    organizationId: UuidV7,
    filter: { readonly productIds?: readonly UuidV7[]; readonly categoryId?: UuidV7 },
  ): Array<typeof products.$inferSelect> {
    if (filter.productIds !== undefined) {
      const out: Array<typeof products.$inferSelect> = [];
      const seen = new Set<UuidV7>();
      for (const pid of filter.productIds) {
        if (seen.has(pid)) {
          continue;
        }
        seen.add(pid);
        const prod = session.db
          .select()
          .from(products)
          .where(
            and(
              eq(products.id, pid),
              eq(products.organizationId, organizationId),
              isNull(products.deletedAtMs),
            ),
          )
          .limit(1)
          .all()[0];
        if (!prod) {
          throw new DomainError('PRODUCT_NOT_FOUND', `Product "${pid}" was not found`);
        }
        out.push(prod);
      }
      return out;
    }

    if (filter.categoryId !== undefined) {
      const cat = session.db
        .select({ id: categories.id })
        .from(categories)
        .where(
          and(
            eq(categories.id, filter.categoryId),
            eq(categories.organizationId, organizationId),
            isNull(categories.deletedAtMs),
          ),
        )
        .limit(1)
        .all()[0];
      if (!cat) {
        throw new DomainError(
          'CATEGORY_NOT_FOUND',
          `Category "${filter.categoryId}" was not found`,
        );
      }

      return session.db
        .select()
        .from(products)
        .where(
          and(
            eq(products.organizationId, organizationId),
            eq(products.categoryId, filter.categoryId),
            isNull(products.deletedAtMs),
          ),
        )
        .orderBy(asc(products.nameSearch), asc(products.id))
        .all();
    }

    return session.db
      .select()
      .from(products)
      .where(and(eq(products.organizationId, organizationId), isNull(products.deletedAtMs)))
      .orderBy(asc(products.nameSearch), asc(products.id))
      .all();
  }
}

export function createSqliteStockStore(options: CreateSqliteStockStoreOptions): SqliteStockStore {
  return new SqliteStockStore(options);
}
