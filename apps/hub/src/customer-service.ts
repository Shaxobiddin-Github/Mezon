import type {
  ArchiveCustomerResponseDto,
  CashMoveDto,
  CreateCustomerRequestDto,
  CreateDebtAdjustmentRequestDto,
  CreateDebtPaymentRequestDto,
  CreateOpeningBalanceRequestDto,
  CustomerDetailResponseDto,
  CustomerLedgerEntryDto,
  CustomerLedgerMutationResponseDto,
  CustomerLedgerQueryDto,
  CustomerLedgerResponseDto,
  CustomerListQueryDto,
  CustomerListResponseDto,
  CustomerMutationResponseDto,
  CustomerOpenObligationDto,
  CustomerSummaryDto,
  UpdateCustomerRequestDto,
} from '@mezon/contracts';
import type {
  CustomerDetailRecord,
  CustomerSummaryRecord,
  SqliteCustomerStore,
  StoredCashMoveRecord,
  StoredCustomerLedgerEntryRecord,
} from '@mezon/db-local';
import {
  type CustomerDebtObligationSummary,
  type Money,
  type UuidV7,
  moneyFromTiyin,
} from '@mezon/domain';

function toCustomerSummaryDto(record: CustomerSummaryRecord): CustomerSummaryDto {
  return {
    id: record.id,
    organizationId: record.organizationId,
    fullName: record.fullName,
    phoneNormalized: record.phoneNormalized,
    creditLimit: record.creditLimit !== null ? record.creditLimit.toString() : null,
    defaultDueDays: record.defaultDueDays,
    note: record.note,
    isActive: record.isActive,
    balance: record.balance.toString(),
    totalDebtAccrued: record.totalDebtAccrued.toString(),
    totalSettled: record.totalSettled.toString(),
    overdueAmount: record.overdueAmount.toString(),
    oldestOverdueDays: record.oldestOverdueDays,
    lastActivityAtMs: record.lastActivityAtMs !== null ? record.lastActivityAtMs.toString() : null,
    createdAtMs: record.createdAtMs.toString(),
    updatedAtMs: record.updatedAtMs.toString(),
  };
}

function toCustomerOpenObligationDto(
  item: CustomerDebtObligationSummary,
): CustomerOpenObligationDto {
  return {
    ledgerEntryId: item.ledgerEntryId,
    entryType: item.entryType,
    createdAtMs: item.createdAtMs.toString(),
    saleId: item.saleId,
    dueAtMs: item.dueAtMs !== null ? item.dueAtMs.toString() : null,
    initialDebt: item.initialDebt.toString(),
    remainingDebt: item.remainingDebt.toString(),
    returnOffsetTotal: item.returnOffsetTotal.toString(),
    fifoPaidTotal: item.fifoPaidTotal.toString(),
    fifoWaivedTotal: item.fifoWaivedTotal.toString(),
    isOverdue: item.isOverdue,
    daysOverdue: Number(item.daysOverdue),
  };
}

function toCustomerDetailResponseDto(detail: CustomerDetailRecord): CustomerDetailResponseDto {
  return {
    customer: toCustomerSummaryDto(detail.customer),
    openObligations: detail.openObligations.map(toCustomerOpenObligationDto),
  };
}

function toCustomerLedgerEntryDto(entry: StoredCustomerLedgerEntryRecord): CustomerLedgerEntryDto {
  return {
    id: entry.id,
    organizationId: entry.organizationId,
    storeId: entry.storeId,
    deviceId: entry.deviceId,
    customerId: entry.customerId,
    entryType: entry.entryType,
    amountDelta: entry.amountDelta.toString(),
    balanceAfter: entry.balanceAfter.toString(),
    sourceType: entry.sourceType,
    sourceId: entry.sourceId,
    saleId: entry.saleId,
    paymentMethod: entry.paymentMethod,
    providerRef: entry.providerRef,
    cashMoveId: entry.cashMoveId,
    dueAtMs: entry.dueAtMs !== null ? entry.dueAtMs.toString() : null,
    reason: entry.reason,
    createdByUserId: entry.createdByUserId,
    overrideApprovedByUserId: entry.overrideApprovedByUserId,
    createdAtMs: entry.createdAtMs.toString(),
  };
}

function toCashMoveDto(move: StoredCashMoveRecord): CashMoveDto {
  return {
    id: move.id,
    organizationId: move.organizationId,
    storeId: move.storeId,
    deviceId: move.deviceId,
    shiftId: move.shiftId,
    type: move.type,
    amountDelta: move.amountDelta.toString(),
    sourceType: move.sourceType,
    sourceId: move.sourceId,
    paymentId: move.paymentId,
    reason: move.reason,
    createdByUserId: move.createdByUserId,
    createdAtMs: move.createdAtMs.toString(),
  };
}

export class HubCustomerService {
  private readonly store: SqliteCustomerStore;

  constructor(store: SqliteCustomerStore) {
    this.store = store;
  }

  async listCustomers(query: CustomerListQueryDto): Promise<CustomerListResponseDto> {
    const res = await this.store.listCustomers({
      ...(query.q !== undefined ? { q: query.q } : {}),
      ...(query.overdueOnly !== undefined ? { overdueOnly: query.overdueOnly } : {}),
      ...(query.includeInactive !== undefined ? { includeInactive: query.includeInactive } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.offset !== undefined ? { offset: query.offset } : {}),
    });

    return {
      items: res.items.map(toCustomerSummaryDto),
      total: res.total,
      limit: res.limit,
      offset: res.offset,
    };
  }

  async listOverdueCustomers(query: CustomerListQueryDto): Promise<CustomerListResponseDto> {
    const res = await this.store.listOverdueCustomers({
      ...(query.q !== undefined ? { q: query.q } : {}),
      ...(query.includeInactive !== undefined ? { includeInactive: query.includeInactive } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.offset !== undefined ? { offset: query.offset } : {}),
    });

    return {
      items: res.items.map(toCustomerSummaryDto),
      total: res.total,
      limit: res.limit,
      offset: res.offset,
    };
  }

  async getCustomerDetail(customerId: UuidV7): Promise<CustomerDetailResponseDto> {
    const detail = await this.store.getCustomerDetail(customerId);
    return toCustomerDetailResponseDto(detail);
  }

  async createCustomer(input: CreateCustomerRequestDto): Promise<CustomerMutationResponseDto> {
    const creditLimit =
      input.creditLimit !== undefined
        ? input.creditLimit !== null
          ? moneyFromTiyin(BigInt(input.creditLimit))
          : null
        : undefined;
    const customer = await this.store.createCustomer({
      fullName: input.fullName,
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(creditLimit !== undefined ? { creditLimit } : {}),
      ...(input.defaultDueDays !== undefined ? { defaultDueDays: input.defaultDueDays } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    });

    return {
      customer: toCustomerSummaryDto(customer),
    };
  }

  async updateCustomer(
    customerId: UuidV7,
    input: UpdateCustomerRequestDto,
  ): Promise<CustomerMutationResponseDto> {
    const creditLimit =
      input.creditLimit !== undefined
        ? input.creditLimit !== null
          ? moneyFromTiyin(BigInt(input.creditLimit))
          : null
        : undefined;
    const customer = await this.store.updateCustomer(customerId, {
      ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(creditLimit !== undefined ? { creditLimit } : {}),
      ...(input.defaultDueDays !== undefined ? { defaultDueDays: input.defaultDueDays } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    });

    return {
      customer: toCustomerSummaryDto(customer),
    };
  }

  async archiveCustomer(customerId: UuidV7): Promise<ArchiveCustomerResponseDto> {
    const res = await this.store.archiveCustomer(customerId);
    return {
      customerId: res.customerId,
      deletedAtMs: res.deletedAtMs.toString(),
    };
  }

  async listCustomerLedger(
    customerId: UuidV7,
    query: CustomerLedgerQueryDto,
  ): Promise<CustomerLedgerResponseDto> {
    const res = await this.store.listCustomerLedger(customerId, {
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.offset !== undefined ? { offset: query.offset } : {}),
      ...(query.order !== undefined ? { order: query.order } : {}),
      ...(query.entryType !== undefined ? { entryType: query.entryType } : {}),
    });

    return {
      customerId: res.customerId,
      currentBalance: res.currentBalance.toString(),
      items: res.items.map(toCustomerLedgerEntryDto),
      total: res.total,
      limit: res.limit,
      offset: res.offset,
    };
  }

  async recordOpeningBalance(
    customerId: UuidV7,
    actorUserId: UuidV7,
    input: CreateOpeningBalanceRequestDto,
  ): Promise<CustomerLedgerMutationResponseDto> {
    const outcome = await this.store.recordOpeningBalance({
      customerId,
      actorUserId,
      clientRequestId: input.clientRequestId,
      amount: moneyFromTiyin(BigInt(input.amount)),
      reason: input.reason,
      ...(input.dueDays !== undefined ? { dueDays: input.dueDays } : {}),
    });

    return {
      customer: toCustomerSummaryDto(outcome.customer),
      entry: toCustomerLedgerEntryDto(outcome.entry),
      cashMove: outcome.cashMove !== null ? toCashMoveDto(outcome.cashMove) : null,
      idempotentReplay: outcome.idempotentReplay,
    };
  }

  async recordDebtPayment(
    customerId: UuidV7,
    actorUserId: UuidV7,
    input: CreateDebtPaymentRequestDto,
  ): Promise<CustomerLedgerMutationResponseDto> {
    const outcome = await this.store.recordDebtPayment({
      customerId,
      actorUserId,
      clientRequestId: input.clientRequestId,
      method: input.method,
      amount: moneyFromTiyin(BigInt(input.amount)),
      ...(input.providerRef !== undefined ? { providerRef: input.providerRef } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });

    return {
      customer: toCustomerSummaryDto(outcome.customer),
      entry: toCustomerLedgerEntryDto(outcome.entry),
      cashMove: outcome.cashMove !== null ? toCashMoveDto(outcome.cashMove) : null,
      idempotentReplay: outcome.idempotentReplay,
    };
  }

  async recordDebtAdjustment(
    customerId: UuidV7,
    actorUserId: UuidV7,
    input: CreateDebtAdjustmentRequestDto,
  ): Promise<CustomerLedgerMutationResponseDto> {
    const outcome = await this.store.recordDebtAdjustment({
      customerId,
      actorUserId,
      clientRequestId: input.clientRequestId,
      amountDelta: BigInt(input.amountDelta) as Money,
      reason: input.reason,
      ...(input.dueDays !== undefined ? { dueDays: input.dueDays } : {}),
    });

    return {
      customer: toCustomerSummaryDto(outcome.customer),
      entry: toCustomerLedgerEntryDto(outcome.entry),
      cashMove: outcome.cashMove !== null ? toCashMoveDto(outcome.cashMove) : null,
      idempotentReplay: outcome.idempotentReplay,
    };
  }
}
