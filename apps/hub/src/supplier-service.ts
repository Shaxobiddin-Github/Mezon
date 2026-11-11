import type {
  ArchiveSupplierResponseDto,
  ConfirmReceivingCostResponseDto,
  ConfirmReceivingLineCostRequestDto,
  CreateReceivingDraftRequestDto,
  CreateSupplierAdjustmentRequestDto,
  CreateSupplierOpeningBalanceRequestDto,
  CreateSupplierPaymentRequestDto,
  CreateSupplierRequestDto,
  CreateSupplierReturnRequestDto,
  CreateSupplierReturnResponseDto,
  ListSupplierReturnsResponseDto,
  PostReceivingRequestDto,
  PostReceivingResponseDto,
  ReceivingCostConfirmationDto,
  ReceivingDraftDto,
  ReceivingDraftLineDto,
  ReceivingDraftResponseDto,
  ReceivingDto,
  ReceivingLineDto,
  ReceivingLineInputDto,
  ReceivingListItemDto,
  ReceivingListQueryDto,
  ReceivingListResponseDto,
  SupplierDetailResponseDto,
  SupplierLedgerEntryDto,
  SupplierLedgerMutationResponseDto,
  SupplierLedgerQueryDto,
  SupplierLedgerResponseDto,
  SupplierListQueryDto,
  SupplierListResponseDto,
  SupplierMutationResponseDto,
  SupplierOpenObligationDto,
  SupplierReturnDto,
  SupplierReturnLineDto,
  SupplierSummaryDto,
  UpdateReceivingDraftRequestDto,
  UpdateSupplierRequestDto,
} from '@mezon/contracts';
import type {
  ReceivingLineInput,
  SqliteSupplierStore,
  StoredReceivingCostConfirmationRecord,
  StoredReceivingDraftLineRecord,
  StoredReceivingDraftRecord,
  StoredReceivingLineRecord,
  StoredReceivingRecord,
  StoredSupplierLedgerEntryRecord,
  StoredSupplierReturnLineRecord,
  StoredSupplierReturnRecord,
  SupplierDetailRecord,
  SupplierSummaryRecord,
} from '@mezon/db-local';
import {
  type Money,
  type SupplierDebtObligationSummary,
  type UuidV7,
  moneyFromTiyin,
  quantityFromMilli,
  unixMsFromBigInt,
} from '@mezon/domain';
import { toCashMoveDto } from './customer-service.js';

function toSupplierSummaryDto(record: SupplierSummaryRecord): SupplierSummaryDto {
  return {
    id: record.id,
    organizationId: record.organizationId,
    name: record.name,
    tin: record.tin,
    phoneNormalized: record.phoneNormalized,
    contactPerson: record.contactPerson,
    defaultDueDays: record.defaultDueDays,
    note: record.note,
    isActive: record.isActive,
    balance: record.balance.toString(),
    debtBalance: record.debtBalance.toString(),
    advanceBalance: record.advanceBalance.toString(),
    totalDebtAccrued: record.totalDebtAccrued.toString(),
    totalCredited: record.totalCredited.toString(),
    overdueAmount: record.overdueAmount.toString(),
    oldestOverdueDays: record.oldestOverdueDays,
    lastActivityAtMs: record.lastActivityAtMs !== null ? record.lastActivityAtMs.toString() : null,
    createdAtMs: record.createdAtMs.toString(),
    updatedAtMs: record.updatedAtMs.toString(),
  };
}

function toSupplierOpenObligationDto(
  item: SupplierDebtObligationSummary,
): SupplierOpenObligationDto {
  return {
    ledgerEntryId: item.ledgerEntryId,
    entryType: item.entryType,
    createdAtMs: item.createdAtMs.toString(),
    receivingId: item.receivingId,
    dueAtMs: item.dueAtMs !== null ? item.dueAtMs.toString() : null,
    initialDebt: item.initialDebt.toString(),
    advanceApplied: item.advanceApplied.toString(),
    paidOrReturnedTotal: item.paidOrReturnedTotal.toString(),
    waivedTotal: item.waivedTotal.toString(),
    remainingDebt: item.remainingDebt.toString(),
    isOverdue: item.isOverdue,
    daysOverdue: Number(item.daysOverdue),
  };
}

function toSupplierDetailResponseDto(detail: SupplierDetailRecord): SupplierDetailResponseDto {
  return {
    supplier: toSupplierSummaryDto(detail.supplier),
    openObligations: detail.openObligations.map(toSupplierOpenObligationDto),
  };
}

function toReceivingLineInputs(
  lines: readonly ReceivingLineInputDto[],
): readonly ReceivingLineInput[] {
  return lines.map((l) => ({
    productId: l.productId,
    variantId: l.variantId ?? null,
    qty: quantityFromMilli(BigInt(l.qty)),
    costUnknown: l.costUnknown,
    totalCostValue: l.totalCostValue !== null ? moneyFromTiyin(BigInt(l.totalCostValue)) : null,
    vatRateBp: l.vatRateBp ?? null,
    vatAmount:
      l.vatAmount !== undefined && l.vatAmount !== null
        ? moneyFromTiyin(BigInt(l.vatAmount))
        : null,
    batchNumber: l.batchNumber ?? null,
    expiryDateMs:
      l.expiryDateMs !== undefined && l.expiryDateMs !== null
        ? unixMsFromBigInt(BigInt(l.expiryDateMs))
        : null,
  }));
}

function toReceivingDraftLineDto(line: StoredReceivingDraftLineRecord): ReceivingDraftLineDto {
  return {
    id: line.id,
    draftId: line.draftId,
    sortOrder: line.sortOrder,
    productId: line.productId,
    variantId: line.variantId,
    productName: line.productName,
    unit: line.unit,
    qty: line.qty.toString(),
    costUnknown: line.costUnknown,
    totalCostValue: line.totalCostValue !== null ? line.totalCostValue.toString() : null,
    vatRateBp: line.vatRateBp,
    vatAmount: line.vatAmount !== null ? line.vatAmount.toString() : null,
    batchNumber: line.batchNumber,
    expiryDateMs: line.expiryDateMs !== null ? line.expiryDateMs.toString() : null,
  };
}

function toReceivingDraftDto(draft: StoredReceivingDraftRecord): ReceivingDraftDto {
  return {
    id: draft.id,
    organizationId: draft.organizationId,
    storeId: draft.storeId,
    supplierId: draft.supplierId,
    supplierInvoiceNo: draft.supplierInvoiceNo,
    dueDays: draft.dueDays,
    note: draft.note,
    status: draft.status,
    createdByUserId: draft.createdByUserId,
    createdAtMs: draft.createdAtMs.toString(),
    updatedAtMs: draft.updatedAtMs.toString(),
    postedAtMs: draft.postedAtMs !== null ? draft.postedAtMs.toString() : null,
    cancelledAtMs: draft.cancelledAtMs !== null ? draft.cancelledAtMs.toString() : null,
    lines: draft.lines.map(toReceivingDraftLineDto),
  };
}

function toCostConfirmationDto(
  conf: StoredReceivingCostConfirmationRecord,
): ReceivingCostConfirmationDto {
  return {
    id: conf.id,
    organizationId: conf.organizationId,
    storeId: conf.storeId,
    deviceId: conf.deviceId,
    receivingId: conf.receivingId,
    receivingLineId: conf.receivingLineId,
    supplierId: conf.supplierId,
    productId: conf.productId,
    variantId: conf.variantId,
    batchId: conf.batchId,
    receivedQty: conf.receivedQty.toString(),
    confirmedTotalCost: conf.confirmedTotalCost.toString(),
    dueDays: conf.dueDays,
    dueAtMs: conf.dueAtMs !== null ? conf.dueAtMs.toString() : null,
    reason: conf.reason,
    confirmedByUserId: conf.confirmedByUserId,
    clientRequestId: conf.clientRequestId,
    createdAtMs: conf.createdAtMs.toString(),
  };
}

function toReceivingLineDto(line: StoredReceivingLineRecord): ReceivingLineDto {
  return {
    id: line.id,
    receivingId: line.receivingId,
    sortOrder: line.sortOrder,
    productId: line.productId,
    variantId: line.variantId,
    productName: line.productName,
    unit: line.unit,
    qty: line.qty.toString(),
    returnedQty: line.returnedQty.toString(),
    costUnknown: line.costUnknown,
    costStatus: line.costStatus,
    effectiveTotalCost: line.effectiveTotalCost.toString(),
    unitCostPreview: line.unitCostPreview.toString(),
    vatRateBp: line.vatRateBp,
    vatAmount: line.vatAmount !== null ? line.vatAmount.toString() : null,
    stockMoveId: line.stockMoveId,
    batchId: line.batchId,
    batchNumber: line.batchNumber,
    expiryDateMs: line.expiryDateMs !== null ? line.expiryDateMs.toString() : null,
    confirmation: line.confirmation !== null ? toCostConfirmationDto(line.confirmation) : null,
  };
}

function toReceivingDto(rec: StoredReceivingRecord): ReceivingDto {
  return {
    id: rec.id,
    organizationId: rec.organizationId,
    storeId: rec.storeId,
    deviceId: rec.deviceId,
    receivingNo: rec.receivingNo.toString(),
    receivingCode: rec.receivingCode,
    supplierId: rec.supplierId,
    supplierInvoiceNo: rec.supplierInvoiceNo,
    dueDays: rec.dueDays,
    dueAtMs: rec.dueAtMs !== null ? rec.dueAtMs.toString() : null,
    knownCostTotal: rec.knownCostTotal.toString(),
    unknownCostLineCount: rec.unknownCostLineCount,
    note: rec.note,
    postedByUserId: rec.postedByUserId,
    clientRequestId: rec.clientRequestId,
    createdAtMs: rec.createdAtMs.toString(),
    lines: rec.lines.map(toReceivingLineDto),
  };
}

function toSupplierReturnLineDto(line: StoredSupplierReturnLineRecord): SupplierReturnLineDto {
  return {
    id: line.id,
    supplierReturnId: line.supplierReturnId,
    receivingLineId: line.receivingLineId,
    sortOrder: line.sortOrder,
    productId: line.productId,
    variantId: line.variantId,
    batchId: line.batchId,
    stockMoveId: line.stockMoveId,
    qty: line.qty.toString(),
    returnCostValue: line.returnCostValue.toString(),
  };
}

function toSupplierReturnDto(ret: StoredSupplierReturnRecord): SupplierReturnDto {
  return {
    id: ret.id,
    organizationId: ret.organizationId,
    storeId: ret.storeId,
    deviceId: ret.deviceId,
    returnNo: ret.returnNo.toString(),
    returnCode: ret.returnCode,
    receivingId: ret.receivingId,
    supplierId: ret.supplierId,
    reason: ret.reason,
    totalReturnCost: ret.totalReturnCost.toString(),
    createdByUserId: ret.createdByUserId,
    clientRequestId: ret.clientRequestId,
    createdAtMs: ret.createdAtMs.toString(),
    lines: ret.lines.map(toSupplierReturnLineDto),
  };
}

function toSupplierLedgerEntryDto(entry: StoredSupplierLedgerEntryRecord): SupplierLedgerEntryDto {
  return {
    id: entry.id,
    organizationId: entry.organizationId,
    storeId: entry.storeId,
    deviceId: entry.deviceId,
    supplierId: entry.supplierId,
    entryType: entry.entryType,
    amountDelta: entry.amountDelta.toString(),
    balanceAfter: entry.balanceAfter.toString(),
    sourceType: entry.sourceType,
    sourceId: entry.sourceId,
    receivingId: entry.receivingId,
    supplierReturnId: entry.supplierReturnId,
    paymentMethod: entry.paymentMethod,
    providerRef: entry.providerRef,
    cashMoveId: entry.cashMoveId,
    dueAtMs: entry.dueAtMs !== null ? entry.dueAtMs.toString() : null,
    reason: entry.reason,
    createdByUserId: entry.createdByUserId,
    createdAtMs: entry.createdAtMs.toString(),
  };
}

export class HubSupplierService {
  private readonly store: SqliteSupplierStore;

  constructor(store: SqliteSupplierStore) {
    this.store = store;
  }

  async listSuppliers(query: SupplierListQueryDto): Promise<SupplierListResponseDto> {
    const res = await this.store.listSuppliers({
      ...(query.q !== undefined ? { q: query.q } : {}),
      ...(query.overdueOnly !== undefined ? { overdueOnly: query.overdueOnly } : {}),
      ...(query.advanceOnly !== undefined ? { advanceOnly: query.advanceOnly } : {}),
      ...(query.includeInactive !== undefined ? { includeInactive: query.includeInactive } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.offset !== undefined ? { offset: query.offset } : {}),
    });

    return {
      items: res.items.map(toSupplierSummaryDto),
      total: res.total,
      limit: res.limit,
      offset: res.offset,
    };
  }

  async listOverdueSuppliers(query: SupplierListQueryDto): Promise<SupplierListResponseDto> {
    const res = await this.store.listOverdueSuppliers({
      ...(query.q !== undefined ? { q: query.q } : {}),
      ...(query.includeInactive !== undefined ? { includeInactive: query.includeInactive } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.offset !== undefined ? { offset: query.offset } : {}),
    });

    return {
      items: res.items.map(toSupplierSummaryDto),
      total: res.total,
      limit: res.limit,
      offset: res.offset,
    };
  }

  async getSupplierDetail(supplierId: UuidV7): Promise<SupplierDetailResponseDto> {
    const detail = await this.store.getSupplierDetail(supplierId);
    return toSupplierDetailResponseDto(detail);
  }

  async createSupplier(input: CreateSupplierRequestDto): Promise<SupplierMutationResponseDto> {
    const supplier = await this.store.createSupplier({
      name: input.name,
      ...(input.tin !== undefined ? { tin: input.tin } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.contactPerson !== undefined ? { contactPerson: input.contactPerson } : {}),
      ...(input.defaultDueDays !== undefined ? { defaultDueDays: input.defaultDueDays } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    });

    return { supplier: toSupplierSummaryDto(supplier) };
  }

  async updateSupplier(
    supplierId: UuidV7,
    input: UpdateSupplierRequestDto,
  ): Promise<SupplierMutationResponseDto> {
    const supplier = await this.store.updateSupplier(supplierId, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.tin !== undefined ? { tin: input.tin } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.contactPerson !== undefined ? { contactPerson: input.contactPerson } : {}),
      ...(input.defaultDueDays !== undefined ? { defaultDueDays: input.defaultDueDays } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    });

    return { supplier: toSupplierSummaryDto(supplier) };
  }

  async archiveSupplier(supplierId: UuidV7): Promise<ArchiveSupplierResponseDto> {
    const res = await this.store.archiveSupplier(supplierId);
    return {
      supplierId: res.supplierId,
      deletedAtMs: res.deletedAtMs.toString(),
    };
  }

  async createReceivingDraft(
    actorUserId: UuidV7,
    input: CreateReceivingDraftRequestDto,
  ): Promise<ReceivingDraftResponseDto> {
    const draft = await this.store.createReceivingDraft({
      supplierId: input.supplierId,
      actorUserId,
      ...(input.supplierInvoiceNo !== undefined
        ? { supplierInvoiceNo: input.supplierInvoiceNo }
        : {}),
      ...(input.dueDays !== undefined ? { dueDays: input.dueDays } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.lines !== undefined ? { lines: toReceivingLineInputs(input.lines) } : {}),
    });

    return { draft: toReceivingDraftDto(draft) };
  }

  async getReceivingDraft(draftId: UuidV7): Promise<ReceivingDraftResponseDto> {
    const draft = await this.store.getReceivingDraft(draftId);
    return { draft: toReceivingDraftDto(draft) };
  }

  async updateReceivingDraft(
    draftId: UuidV7,
    input: UpdateReceivingDraftRequestDto,
  ): Promise<ReceivingDraftResponseDto> {
    const draft = await this.store.updateReceivingDraft(draftId, {
      ...(input.supplierId !== undefined ? { supplierId: input.supplierId } : {}),
      ...(input.supplierInvoiceNo !== undefined
        ? { supplierInvoiceNo: input.supplierInvoiceNo }
        : {}),
      ...(input.dueDays !== undefined ? { dueDays: input.dueDays } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.lines !== undefined ? { lines: toReceivingLineInputs(input.lines) } : {}),
    });

    return { draft: toReceivingDraftDto(draft) };
  }

  async cancelReceivingDraft(draftId: UuidV7): Promise<ReceivingDraftResponseDto> {
    const draft = await this.store.cancelReceivingDraft(draftId);
    return { draft: toReceivingDraftDto(draft) };
  }

  async postReceiving(
    draftId: UuidV7,
    actorUserId: UuidV7,
    input: PostReceivingRequestDto,
  ): Promise<PostReceivingResponseDto> {
    const outcome = await this.store.postReceiving(draftId, {
      actorUserId,
      clientRequestId: input.clientRequestId,
    });

    return {
      receiving: toReceivingDto(outcome.receiving),
      supplier: toSupplierSummaryDto(outcome.supplier),
      idempotentReplay: outcome.idempotentReplay,
    };
  }

  async getReceiving(receivingId: UuidV7): Promise<ReceivingDto> {
    const rec = await this.store.getReceiving(receivingId);
    return toReceivingDto(rec);
  }

  async listReceivings(query: ReceivingListQueryDto): Promise<ReceivingListResponseDto> {
    const res = await this.store.listReceivings({
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.supplierId !== undefined ? { supplierId: query.supplierId } : {}),
      ...(query.costUnknownOnly !== undefined ? { costUnknownOnly: query.costUnknownOnly } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.offset !== undefined ? { offset: query.offset } : {}),
    });

    const items: ReceivingListItemDto[] = res.items.map((r) => ({
      id: r.id,
      status: r.status,
      receivingNo: r.receivingNo !== null ? r.receivingNo.toString() : null,
      receivingCode: r.receivingCode,
      supplierId: r.supplierId,
      supplierInvoiceNo: r.supplierInvoiceNo,
      knownCostTotal: r.knownCostTotal.toString(),
      unknownCostLineCount: r.unknownCostLineCount,
      lineCount: r.lineCount,
      createdAtMs: r.createdAtMs.toString(),
      postedAtMs: r.postedAtMs !== null ? r.postedAtMs.toString() : null,
    }));

    return {
      items,
      total: res.total,
      limit: res.limit,
      offset: res.offset,
    };
  }

  async confirmReceivingLineCost(
    receivingId: UuidV7,
    receivingLineId: UuidV7,
    actorUserId: UuidV7,
    input: ConfirmReceivingLineCostRequestDto,
  ): Promise<ConfirmReceivingCostResponseDto> {
    const outcome = await this.store.confirmReceivingLineCost(receivingId, receivingLineId, {
      actorUserId,
      clientRequestId: input.clientRequestId,
      confirmedTotalCost: moneyFromTiyin(BigInt(input.confirmedTotalCost)),
      reason: input.reason,
      ...(input.dueDays !== undefined ? { dueDays: input.dueDays } : {}),
    });

    return {
      confirmation: toCostConfirmationDto(outcome.confirmation),
      receiving: toReceivingDto(outcome.receiving),
      supplier: toSupplierSummaryDto(outcome.supplier),
      idempotentReplay: outcome.idempotentReplay,
    };
  }

  async createSupplierReturn(
    receivingId: UuidV7,
    actorUserId: UuidV7,
    input: CreateSupplierReturnRequestDto,
  ): Promise<CreateSupplierReturnResponseDto> {
    const outcome = await this.store.createSupplierReturn(receivingId, {
      actorUserId,
      clientRequestId: input.clientRequestId,
      reason: input.reason,
      items: input.items.map((item) => ({
        receivingLineId: item.receivingLineId,
        qty: quantityFromMilli(BigInt(item.qty)),
      })),
    });

    return {
      supplierReturn: toSupplierReturnDto(outcome.supplierReturn),
      supplier: toSupplierSummaryDto(outcome.supplier),
      idempotentReplay: outcome.idempotentReplay,
    };
  }

  async listReturnsForReceiving(receivingId: UuidV7): Promise<ListSupplierReturnsResponseDto> {
    const list = await this.store.listReturnsForReceiving(receivingId);
    return {
      returns: list.map(toSupplierReturnDto),
    };
  }

  async getSupplierReturn(returnId: UuidV7): Promise<SupplierReturnDto> {
    const ret = await this.store.getSupplierReturn(returnId);
    return toSupplierReturnDto(ret);
  }

  async listSupplierLedger(
    supplierId: UuidV7,
    query: SupplierLedgerQueryDto,
  ): Promise<SupplierLedgerResponseDto> {
    const res = await this.store.listSupplierLedger(supplierId, {
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.offset !== undefined ? { offset: query.offset } : {}),
      ...(query.order !== undefined ? { order: query.order } : {}),
      ...(query.entryType !== undefined ? { entryType: query.entryType } : {}),
    });

    return {
      supplierId: res.supplierId,
      currentBalance: res.currentBalance.toString(),
      items: res.items.map(toSupplierLedgerEntryDto),
      total: res.total,
      limit: res.limit,
      offset: res.offset,
    };
  }

  async recordOpeningBalance(
    supplierId: UuidV7,
    actorUserId: UuidV7,
    input: CreateSupplierOpeningBalanceRequestDto,
  ): Promise<SupplierLedgerMutationResponseDto> {
    const outcome = await this.store.recordOpeningBalance({
      supplierId,
      actorUserId,
      clientRequestId: input.clientRequestId,
      amount: moneyFromTiyin(BigInt(input.amount)),
      reason: input.reason,
      ...(input.dueDays !== undefined ? { dueDays: input.dueDays } : {}),
    });

    return {
      supplier: toSupplierSummaryDto(outcome.supplier),
      entry: toSupplierLedgerEntryDto(outcome.entry),
      cashMove: outcome.cashMove !== null ? toCashMoveDto(outcome.cashMove) : null,
      idempotentReplay: outcome.idempotentReplay,
    };
  }

  async recordPayment(
    supplierId: UuidV7,
    actorUserId: UuidV7,
    input: CreateSupplierPaymentRequestDto,
  ): Promise<SupplierLedgerMutationResponseDto> {
    const outcome = await this.store.recordPayment({
      supplierId,
      actorUserId,
      clientRequestId: input.clientRequestId,
      method: input.method,
      amount: moneyFromTiyin(BigInt(input.amount)),
      ...(input.providerRef !== undefined ? { providerRef: input.providerRef } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });

    return {
      supplier: toSupplierSummaryDto(outcome.supplier),
      entry: toSupplierLedgerEntryDto(outcome.entry),
      cashMove: outcome.cashMove !== null ? toCashMoveDto(outcome.cashMove) : null,
      idempotentReplay: outcome.idempotentReplay,
    };
  }

  async recordAdjustment(
    supplierId: UuidV7,
    actorUserId: UuidV7,
    input: CreateSupplierAdjustmentRequestDto,
  ): Promise<SupplierLedgerMutationResponseDto> {
    const outcome = await this.store.recordAdjustment({
      supplierId,
      actorUserId,
      clientRequestId: input.clientRequestId,
      amountDelta: BigInt(input.amountDelta) as Money,
      reason: input.reason,
      ...(input.dueDays !== undefined ? { dueDays: input.dueDays } : {}),
    });

    return {
      supplier: toSupplierSummaryDto(outcome.supplier),
      entry: toSupplierLedgerEntryDto(outcome.entry),
      cashMove: outcome.cashMove !== null ? toCashMoveDto(outcome.cashMove) : null,
      idempotentReplay: outcome.idempotentReplay,
    };
  }
}
