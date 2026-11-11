import type {
  CreateReturnRequestDto,
  CreateReturnResponseDto,
  ListSaleReturnsResponseDto,
  ReturnDto,
  ReturnLineDto,
  ReturnPaymentDto,
  SalesLinesReportQueryDto,
  SalesLinesReportSummaryDto,
  VoidSaleRequestDto,
  VoidSaleResponseDto,
  VoidedSaleDto,
} from '@mezon/contracts';
import type {
  AuthenticatedSessionSnapshot,
  SqliteReturnStore,
  StoredReturnLineRecord,
  StoredReturnPaymentRecord,
  StoredReturnRecord,
  StoredVoidedSaleRecord,
} from '@mezon/db-local';
import {
  DomainError,
  type ReturnPaymentInput,
  type UuidV7,
  ZERO_MONEY,
  moneyFromTiyin,
  quantityFromMilli,
  roleHasPermission,
} from '@mezon/domain';
import type { HubAuthService } from './auth-service.js';
import { toSaleLineDto, toSalePaymentDto } from './sale-service.js';

/**
 * Maps a persisted `StoredReturnLineRecord` to HTTP DTO using an explicit allow-list
 * so internal `costValue` and profit NEVER appear in POS/cashier API responses.
 */
function toReturnLineDto(line: StoredReturnLineRecord): ReturnLineDto {
  return {
    id: line.id,
    returnId: line.returnId,
    saleId: line.saleId,
    saleLineId: line.saleLineId,
    sortOrder: line.sortOrder,
    lineKind: line.lineKind,
    productId: line.productId,
    variantId: line.variantId,
    itemName: line.itemName,
    unit: line.unit,
    qty: line.qty.toString(),
    unitPriceSnapshot: line.unitPriceSnapshot.toString(),
    vatRateBpSnapshot: line.vatRateBpSnapshot,
    mxikSnapshot: line.mxikSnapshot,
    packageCodeSnapshot: line.packageCodeSnapshot,
    refundAmount: line.refundAmount.toString(),
    netExVat: line.netExVat.toString(),
    vatTotal: line.vatTotal.toString(),
  };
}

function toReturnPaymentDto(payment: StoredReturnPaymentRecord): ReturnPaymentDto {
  return {
    id: payment.id,
    method: payment.method,
    amount: payment.amount.toString(),
    providerRef: payment.providerRef,
    createdAtMs: payment.createdAtMs.toString(),
  };
}

function toReturnDto(doc: StoredReturnRecord): ReturnDto {
  return {
    id: doc.id,
    returnNo: doc.returnNo.toString(),
    returnCode: doc.returnCode,
    organizationId: doc.organizationId,
    storeId: doc.storeId,
    deviceId: doc.deviceId,
    saleId: doc.saleId,
    shiftId: doc.shiftId,
    shiftCashierSessionId: doc.shiftCashierSessionId,
    processedByUserId: doc.processedByUserId,
    overrideApprovedByUserId: doc.overrideApprovedByUserId,
    overrideApprovedAtMs:
      doc.overrideApprovedAtMs !== null ? doc.overrideApprovedAtMs.toString() : null,
    reason: doc.reason,
    clientRequestId: doc.clientRequestId,
    totalRefund: doc.totalRefund.toString(),
    totalNetExVat: doc.totalNetExVat.toString(),
    totalVat: doc.totalVat.toString(),
    cashRefundAmount: doc.cashRefundAmount.toString(),
    nonCashRefundAmount: doc.nonCashRefundAmount.toString(),
    debtOffsetAmount: doc.debtOffsetAmount.toString(),
    createdAtMs: doc.createdAtMs.toString(),
    lines: doc.lines.map(toReturnLineDto),
    payments: doc.payments.map(toReturnPaymentDto),
  };
}

function toVoidedSaleDto(sale: StoredVoidedSaleRecord): VoidedSaleDto {
  return {
    id: sale.id,
    receiptNo: sale.receiptNo.toString(),
    receiptCode: sale.receiptCode,
    organizationId: sale.organizationId,
    storeId: sale.storeId,
    deviceId: sale.deviceId,
    sourceCartId: sale.sourceCartId,
    cashierUserId: sale.cashierUserId,
    completedByUserId: sale.completedByUserId,
    customerId: sale.customerId,
    shiftId: sale.shiftId,
    shiftCashierSessionId: sale.shiftCashierSessionId,
    clientRequestId: sale.clientRequestId,
    status: 'voided',
    subtotalGross: sale.subtotalGross.toString(),
    totalPromoDiscount: sale.totalPromoDiscount.toString(),
    subtotalAfterPromo: sale.subtotalAfterPromo.toString(),
    manualDiscountMode: sale.manualDiscountMode,
    manualDiscountValue: sale.manualDiscountValue.toString(),
    manualDiscountReason: sale.manualDiscountReason,
    orderDiscountAmount: sale.orderDiscountAmount.toString(),
    totalFinal: sale.totalFinal.toString(),
    totalNetExVat: sale.totalNetExVat.toString(),
    totalVat: sale.totalVat.toString(),
    totalPaid: sale.totalPaid.toString(),
    debtAmount: sale.debtAmount.toString(),
    changeAmount: sale.changeAmount.toString(),
    overrideApprovedByUserId: sale.overrideApprovedByUserId,
    overrideApprovedAmount:
      sale.overrideApprovedAmount !== null ? sale.overrideApprovedAmount.toString() : null,
    overrideApprovedAtMs:
      sale.overrideApprovedAtMs !== null ? sale.overrideApprovedAtMs.toString() : null,
    createdAtMs: sale.createdAtMs.toString(),
    voidedAtMs: sale.voidedAtMs.toString(),
    voidedByUserId: sale.voidedByUserId,
    voidReason: sale.voidReason,
    lines: sale.lines.map(toSaleLineDto),
    payments: sale.payments.map(toSalePaymentDto),
  };
}

export class HubReturnService {
  private readonly store: SqliteReturnStore;
  private readonly authService: HubAuthService;

  constructor(store: SqliteReturnStore, authService: HubAuthService) {
    this.store = store;
    this.authService = authService;
  }

  private async resolvePrivilegeOrSupervisorOverride(
    session: AuthenticatedSessionSnapshot,
    permission: 'sale:void' | 'sale:return',
    override: VoidSaleRequestDto['override'],
  ): Promise<UuidV7 | null> {
    if (roleHasPermission(session.user.role, permission)) {
      return null;
    }
    if (!override) {
      throw new DomainError(
        'SUPERVISOR_OVERRIDE_REQUIRED',
        `Role "${session.user.role}" requires owner or manager PIN approval for "${permission}"`,
      );
    }
    const supervisor = await this.authService.verifySupervisorPin(override);
    return supervisor.id;
  }

  async voidSale(
    saleId: UuidV7,
    session: AuthenticatedSessionSnapshot,
    input: VoidSaleRequestDto,
  ): Promise<{
    readonly response: VoidSaleResponseDto;
    readonly overrideApprovedByUserId: UuidV7 | null;
  }> {
    const overrideApprovedByUserId = await this.resolvePrivilegeOrSupervisorOverride(
      session,
      'sale:void',
      input.override,
    );

    const outcome = await this.store.voidSale({
      saleId,
      actorUserId: session.user.id,
      reason: input.reason,
      clientRequestId: input.clientRequestId,
    });

    return {
      response: {
        sale: toVoidedSaleDto(outcome.sale),
        cashRefundAmount: outcome.cashRefundAmount.toString(),
        idempotentReplay: outcome.idempotentReplay,
      },
      overrideApprovedByUserId,
    };
  }

  async createReturn(
    saleId: UuidV7,
    session: AuthenticatedSessionSnapshot,
    input: CreateReturnRequestDto,
  ): Promise<{
    readonly response: CreateReturnResponseDto;
    readonly overrideApprovedByUserId: UuidV7 | null;
  }> {
    const overrideApprovedByUserId = await this.resolvePrivilegeOrSupervisorOverride(
      session,
      'sale:return',
      input.override,
    );

    const mappedPayments: ReturnPaymentInput[] = input.payments.map((p) => {
      if (p.method === 'cash') {
        return {
          method: 'cash',
          amount: moneyFromTiyin(BigInt(p.amount)),
        };
      }
      return {
        method: p.method,
        amount: moneyFromTiyin(BigInt(p.amount)),
        ...(p.providerRef !== undefined ? { providerRef: p.providerRef } : {}),
      };
    });

    const outcome = await this.store.createReturn({
      saleId,
      actorUserId: session.user.id,
      overrideApprovedByUserId,
      reason: input.reason,
      clientRequestId: input.clientRequestId,
      items: input.items.map((i) => ({
        saleLineId: i.saleLineId,
        qty: quantityFromMilli(BigInt(i.qty)),
      })),
      payments: mappedPayments,
      debtOffsetAmount:
        input.debtOffsetAmount !== undefined
          ? moneyFromTiyin(BigInt(input.debtOffsetAmount))
          : ZERO_MONEY,
    });

    return {
      response: {
        returnDoc: toReturnDto(outcome.returnDoc),
        idempotentReplay: outcome.idempotentReplay,
      },
      overrideApprovedByUserId,
    };
  }

  async listSaleReturns(saleId: UuidV7): Promise<ListSaleReturnsResponseDto> {
    const rows = await this.store.listSaleReturns(saleId);
    return {
      returns: rows.map(toReturnDto),
    };
  }

  async getReturnById(returnId: UuidV7): Promise<ReturnDto> {
    const row = await this.store.getReturnById(returnId);
    if (!row) {
      throw new DomainError('RETURN_NOT_FOUND', `Return "${returnId}" was not found`);
    }
    return toReturnDto(row);
  }

  async getSalesLinesReportSummary(
    query: SalesLinesReportQueryDto,
  ): Promise<SalesLinesReportSummaryDto> {
    const summary = await this.store.querySalesLinesReport({
      fromMs: query.fromMs !== undefined ? BigInt(query.fromMs) : undefined,
      toMs: query.toMs !== undefined ? BigInt(query.toMs) : undefined,
    });

    return {
      lineCount: summary.lineCount,
      signedQtyTotal: summary.signedQtyTotal.toString(),
      revenue: summary.revenue.toString(),
      netRevenue: summary.netRevenue.toString(),
      vatTotal: summary.vatTotal.toString(),
      costValue: summary.costValue.toString(),
      grossProfit: summary.grossProfit.toString(),
    };
  }
}
