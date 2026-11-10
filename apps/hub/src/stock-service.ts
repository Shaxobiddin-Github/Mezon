import type {
  BatchSummaryDto,
  CashierStockBalanceDto,
  CreateInboundStockMoveRequestDto,
  CreateOutboundStockMoveRequestDto,
  CreateStockMovesResponseDto,
  FinalizeInventoryCountResponseDto,
  InventoryCountDetailResponseDto,
  InventoryCountLineDto,
  InventoryCountSummaryDto,
  ListBatchesQueryDto,
  ListBatchesResponseDto,
  ListCashierStockBalancesResponseDto,
  ListStockConflictsResponseDto,
  ListStockMovesQueryDto,
  ListStockMovesResponseDto,
  ListStockValuationResponseDto,
  NegativeStockPolicyResponseDto,
  RebuildStockProjectionsResponseDto,
  RecordInventoryCountLinesRequestDto,
  StartInventoryCountRequestDto,
  StockConflictSummaryDto,
  StockMoveSummaryDto,
  StockValuationItemDto,
  UpdateNegativeStockPolicyRequestDto,
} from '@mezon/contracts';
import type {
  SqliteStockStore,
  StoredBatchRecord,
  StoredCashierBalanceRecord,
  StoredInventoryCountLineRecord,
  StoredInventoryCountRecord,
  StoredStockConflictRecord,
  StoredStockMoveRecord,
  StoredStockValuationRecord,
} from '@mezon/db-local';
import type { UuidV7 } from '@mezon/domain';

function toCashierBalanceDto(bal: StoredCashierBalanceRecord): CashierStockBalanceDto {
  return {
    productId: bal.productId,
    variantId: bal.variantId,
    productName: bal.productName,
    unit: bal.unit,
    unlimited: bal.unlimited,
    trackBatches: bal.trackBatches,
    minStock: bal.minStock !== null ? bal.minStock.toString() : null,
    qtyOnHand: bal.qtyOnHand !== null ? bal.qtyOnHand.toString() : null,
    isLowStock: bal.isLowStock,
  };
}

function toValuationDto(v: StoredStockValuationRecord): StockValuationItemDto {
  return {
    productId: v.productId,
    variantId: v.variantId,
    productName: v.productName,
    unit: v.unit,
    trackBatches: v.trackBatches,
    qtyOnHand: v.qtyOnHand.toString(),
    totalValue: v.totalValue.toString(),
    deficitQty: v.deficitQty.toString(),
    provisionalDeficitValue: v.provisionalDeficitValue.toString(),
    costVarianceValue: v.costVarianceValue.toString(),
    lastUnitCost: v.lastUnitCost !== null ? v.lastUnitCost.toString() : null,
    updatedAtMs: v.updatedAtMs.toString(),
  };
}

function toBatchDto(b: StoredBatchRecord): BatchSummaryDto {
  return {
    id: b.id,
    organizationId: b.organizationId,
    storeId: b.storeId,
    productId: b.productId,
    variantId: b.variantId,
    batchNumber: b.batchNumber,
    expiryDateMs: b.expiryDateMs !== null ? b.expiryDateMs.toString() : null,
    initialQty: b.initialQty.toString(),
    initialCostValue: b.initialCostValue.toString(),
    remainingQty: b.remainingQty.toString(),
    remainingValue: b.remainingValue.toString(),
    createdAtMs: b.createdAtMs.toString(),
  };
}

function toMoveDto(m: StoredStockMoveRecord): StockMoveSummaryDto {
  return {
    id: m.id,
    organizationId: m.organizationId,
    storeId: m.storeId,
    productId: m.productId,
    variantId: m.variantId,
    batchId: m.batchId,
    qtyDelta: m.qtyDelta.toString(),
    costValueDelta: m.costValueDelta.toString(),
    reason: m.reason,
    sourceType: m.sourceType,
    sourceId: m.sourceId,
    createdByUserId: m.createdByUserId,
    note: m.note,
    createdAtMs: m.createdAtMs.toString(),
  };
}

function toConflictDto(c: StoredStockConflictRecord): StockConflictSummaryDto {
  return {
    id: c.id,
    productId: c.productId,
    variantId: c.variantId,
    batchId: c.batchId,
    moveId: c.moveId,
    conflictQty: c.conflictQty.toString(),
    reason: c.reason,
    detail: c.detail,
    resolvedAtMs: c.resolvedAtMs !== null ? c.resolvedAtMs.toString() : null,
    createdAtMs: c.createdAtMs.toString(),
  };
}

function toInventoryCountDto(c: StoredInventoryCountRecord): InventoryCountSummaryDto {
  return {
    id: c.id,
    organizationId: c.organizationId,
    storeId: c.storeId,
    status: c.status,
    startedByUserId: c.startedByUserId,
    finalizedByUserId: c.finalizedByUserId,
    finalizedAtMs: c.finalizedAtMs !== null ? c.finalizedAtMs.toString() : null,
    note: c.note,
    createdAtMs: c.createdAtMs.toString(),
    updatedAtMs: c.updatedAtMs.toString(),
  };
}

function toInventoryCountLineDto(l: StoredInventoryCountLineRecord): InventoryCountLineDto {
  return {
    id: l.id,
    countId: l.countId,
    productId: l.productId,
    variantId: l.variantId,
    expectedQtyAtCount: l.expectedQtyAtCount !== null ? l.expectedQtyAtCount.toString() : null,
    countedQty: l.countedQty !== null ? l.countedQty.toString() : null,
    adjustmentQty: l.adjustmentQty !== null ? l.adjustmentQty.toString() : null,
    updatedAtMs: l.updatedAtMs.toString(),
  };
}

export class HubStockService {
  private readonly store: SqliteStockStore;

  constructor(store: SqliteStockStore) {
    this.store = store;
  }

  async listCashierBalances(): Promise<ListCashierStockBalancesResponseDto> {
    const rows = await this.store.listCashierBalances();
    return { balances: rows.map(toCashierBalanceDto) };
  }

  async listValuations(): Promise<ListStockValuationResponseDto> {
    const rows = await this.store.listStockValuations();
    return { valuations: rows.map(toValuationDto) };
  }

  async listBatches(query: ListBatchesQueryDto): Promise<ListBatchesResponseDto> {
    const rows = await this.store.listBatches(query);
    return { batches: rows.map(toBatchDto) };
  }

  async listMoves(query: ListStockMovesQueryDto): Promise<ListStockMovesResponseDto> {
    const rows = await this.store.listStockMoves(query);
    return { moves: rows.map(toMoveDto) };
  }

  async recordInboundMove(
    input: CreateInboundStockMoveRequestDto,
    actorUserId: UuidV7,
  ): Promise<CreateStockMovesResponseDto> {
    const res = await this.store.recordInboundMove({
      ...input,
      actorUserId,
    });
    return {
      moves: res.moves.map(toMoveDto),
      batch: res.batch !== null ? toBatchDto(res.batch) : null,
      warnings: res.warnings.map((w) => ({
        code: w.code,
        productId: w.productId,
        variantId: w.variantId,
        deficitQty: w.deficitQty.toString(),
      })),
    };
  }

  async recordOutboundMove(
    input: CreateOutboundStockMoveRequestDto,
    actorUserId: UuidV7,
  ): Promise<CreateStockMovesResponseDto> {
    const res = await this.store.recordOutboundMove({
      ...input,
      actorUserId,
    });
    return {
      moves: res.moves.map(toMoveDto),
      batch: null,
      warnings: res.warnings.map((w) => ({
        code: w.code,
        productId: w.productId,
        variantId: w.variantId,
        deficitQty: w.deficitQty.toString(),
      })),
    };
  }

  async listConflicts(): Promise<ListStockConflictsResponseDto> {
    const rows = await this.store.listConflicts();
    return { conflicts: rows.map(toConflictDto) };
  }

  async getNegativeStockPolicy(): Promise<NegativeStockPolicyResponseDto> {
    return { policy: await this.store.getNegativeStockPolicy() };
  }

  async setNegativeStockPolicy(
    input: UpdateNegativeStockPolicyRequestDto,
  ): Promise<NegativeStockPolicyResponseDto> {
    return { policy: await this.store.setNegativeStockPolicy(input.policy) };
  }

  async rebuildProjections(): Promise<RebuildStockProjectionsResponseDto> {
    return this.store.rebuildProjections();
  }

  async startInventoryCount(
    input: StartInventoryCountRequestDto,
    actorUserId: UuidV7,
  ): Promise<InventoryCountDetailResponseDto> {
    const detail = await this.store.startInventoryCount({
      ...input,
      actorUserId,
    });
    return {
      count: toInventoryCountDto(detail.count),
      lines: detail.lines.map(toInventoryCountLineDto),
    };
  }

  async getInventoryCount(countId: UuidV7): Promise<InventoryCountDetailResponseDto> {
    const detail = await this.store.getInventoryCountDetail(countId);
    return {
      count: toInventoryCountDto(detail.count),
      lines: detail.lines.map(toInventoryCountLineDto),
    };
  }

  async recordInventoryCountLines(
    countId: UuidV7,
    input: RecordInventoryCountLinesRequestDto,
  ): Promise<InventoryCountDetailResponseDto> {
    const detail = await this.store.recordInventoryCountLines(countId, input.lines);
    return {
      count: toInventoryCountDto(detail.count),
      lines: detail.lines.map(toInventoryCountLineDto),
    };
  }

  async finalizeInventoryCount(
    countId: UuidV7,
    actorUserId: UuidV7,
  ): Promise<FinalizeInventoryCountResponseDto> {
    const res = await this.store.finalizeInventoryCount(countId, actorUserId);
    return {
      count: toInventoryCountDto(res.count),
      lines: res.lines.map(toInventoryCountLineDto),
      adjustmentMoves: res.adjustmentMoves.map(toMoveDto),
      conflicts: res.conflicts.map(toConflictDto),
    };
  }

  async cancelInventoryCount(
    countId: UuidV7,
    actorUserId: UuidV7,
  ): Promise<{ readonly count: InventoryCountSummaryDto }> {
    const closed = await this.store.cancelInventoryCount(countId, actorUserId);
    return { count: toInventoryCountDto(closed) };
  }
}
