import type {
  CompleteSaleRequestDto,
  CompleteSaleResponseDto,
  SaleDto,
  SaleLineDto,
  SaleNegativeStockWarningDto,
  SalePaymentDto,
} from '@mezon/contracts';
import type {
  SqliteSaleStore,
  StockMoveWarningRecord,
  StoredSaleLineRecord,
  StoredSalePaymentRecord,
  StoredSaleRecord,
} from '@mezon/db-local';
import {
  type SalePaymentInput,
  type UuidV7,
  ZERO_MONEY,
  moneyFromTiyin,
  quantityToMilli,
} from '@mezon/domain';

/**
 * Maps a persisted `StoredSaleLineRecord` to the HTTP DTO using an explicit allow-list so internal
 * COGS (`costValue`), unit cost, and profit margin can NEVER leak to cashier/API responses.
 */
function toSaleLineDto(line: StoredSaleLineRecord): SaleLineDto {
  return {
    id: line.id,
    sortOrder: line.sortOrder,
    lineKind: line.lineKind,
    productId: line.productId,
    variantId: line.variantId,
    categoryIdSnapshot: line.categoryIdSnapshot,
    itemName: line.itemName,
    unit: line.unit,
    qty: line.qty.toString(),
    unitPriceSnapshot: line.unitPriceSnapshot.toString(),
    appliedPromotionId: line.appliedPromotionId,
    appliedPromotionName: line.appliedPromotionName,
    freeUnits: line.freeUnits,
    grossTotal: line.grossTotal.toString(),
    promoDiscount: line.promoDiscount.toString(),
    subtotalAfterPromo: line.subtotalAfterPromo.toString(),
    allocatedOrderDiscount: line.allocatedOrderDiscount.toString(),
    finalTotal: line.finalTotal.toString(),
    vatRateBpSnapshot: line.vatRateBpSnapshot,
    netExVat: line.netExVat.toString(),
    vatTotal: line.vatTotal.toString(),
    mxikSnapshot: line.mxikSnapshot,
    packageCodeSnapshot: line.packageCodeSnapshot,
  };
}

function toSalePaymentDto(payment: StoredSalePaymentRecord): SalePaymentDto {
  return {
    id: payment.id,
    method: payment.method,
    amount: payment.amount.toString(),
    tenderedAmount: payment.tenderedAmount !== null ? payment.tenderedAmount.toString() : null,
    changeAmount: payment.changeAmount.toString(),
    providerRef: payment.providerRef,
    createdAtMs: payment.createdAtMs.toString(),
  };
}

function toSaleDto(sale: StoredSaleRecord): SaleDto {
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
    clientRequestId: sale.clientRequestId,
    status: sale.status,
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
    lines: sale.lines.map(toSaleLineDto),
    payments: sale.payments.map(toSalePaymentDto),
  };
}

function toWarningDto(warning: StockMoveWarningRecord): SaleNegativeStockWarningDto {
  return {
    code: warning.code,
    productId: warning.productId,
    variantId: warning.variantId,
    deficitQty: quantityToMilli(warning.deficitQty).toString(),
  };
}

export class HubSaleService {
  private readonly store: SqliteSaleStore;

  constructor(store: SqliteSaleStore) {
    this.store = store;
  }

  async completeSale(
    cartId: UuidV7,
    actorUserId: UuidV7,
    input: CompleteSaleRequestDto,
  ): Promise<CompleteSaleResponseDto> {
    const mappedPayments: SalePaymentInput[] = input.payments.map((p) => {
      if (p.method === 'cash') {
        return {
          method: 'cash',
          tenderedAmount: moneyFromTiyin(BigInt(p.tenderedAmount)),
          ...(p.amount !== undefined ? { amount: moneyFromTiyin(BigInt(p.amount)) } : {}),
        };
      }
      return {
        method: p.method,
        amount: moneyFromTiyin(BigInt(p.amount)),
        ...(p.providerRef !== undefined ? { providerRef: p.providerRef } : {}),
      };
    });

    const outcome = await this.store.completeSale({
      cartId,
      actorUserId,
      clientRequestId: input.clientRequestId,
      expectedTotal: moneyFromTiyin(BigInt(input.expectedTotal)),
      debtAmount:
        input.debtAmount !== undefined ? moneyFromTiyin(BigInt(input.debtAmount)) : ZERO_MONEY,
      customerId: input.customerId ?? null,
      payments: mappedPayments,
    });

    return {
      sale: toSaleDto(outcome.sale),
      warnings: outcome.warnings.map(toWarningDto),
    };
  }
}
