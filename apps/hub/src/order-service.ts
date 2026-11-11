import type {
  CancelOrderRequestDto,
  ConfirmOrderRequestDto,
  CreateOrderRequestDto,
  DeliverOrderRequestDto,
  DeliverOrderResponseDto,
  ListOrdersQueryDto,
  ListOrdersResponseDto,
  LoginRequestDto,
  MarkOrderReadyRequestDto,
  MethodAdvanceBreakdownDto,
  OpenAdvancesResponseDto,
  OrderActionResponseDto,
  OrderDto,
  OrderLineDto,
  OrderPaymentDto,
  RecordOrderAdvanceRequestDto,
  RefundOrderAdvanceRequestDto,
} from '@mezon/contracts';
import type {
  AuthenticatedSessionSnapshot,
  CreateOrderLineInput,
  SetCartDiscountInput,
  SqliteOrderStore,
  StoredOrderLineRecord,
  StoredOrderPaymentRecord,
  StoredOrderRecord,
} from '@mezon/db-local';
import {
  DomainError,
  type Money,
  type PaymentMethod,
  type ReturnPaymentInput,
  type SalePaymentInput,
  type UuidV7,
  ZERO_MONEY,
  moneyFromTiyin,
  quantityFromMilli,
  roleHasPermission,
  unixMsFromBigInt,
} from '@mezon/domain';
import type { HubAuthService } from './auth-service.js';
import { toSaleDto, toWarningDto } from './sale-service.js';

/**
 * Explicit allow-list mapper for order lines (ZERO internal COGS / margin fields).
 */
export function toOrderLineDto(line: StoredOrderLineRecord): OrderLineDto {
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

export function toOrderPaymentDto(payment: StoredOrderPaymentRecord): OrderPaymentDto {
  return {
    id: payment.id,
    orderId: payment.orderId,
    shiftId: payment.shiftId,
    shiftCashierSessionId: payment.shiftCashierSessionId,
    kind: payment.kind,
    method: payment.method,
    amount: payment.amount.toString(),
    tenderedAmount: payment.tenderedAmount !== null ? payment.tenderedAmount.toString() : null,
    changeAmount: payment.changeAmount.toString(),
    providerRef: payment.providerRef,
    reason: payment.reason,
    createdByUserId: payment.createdByUserId,
    overrideApprovedByUserId: payment.overrideApprovedByUserId,
    createdAtMs: payment.createdAtMs.toString(),
  };
}

export function toMethodAdvanceBreakdownDto(
  map: Readonly<Record<PaymentMethod, Money>>,
): MethodAdvanceBreakdownDto {
  return {
    cash: map.cash.toString(),
    card: map.card.toString(),
    uzqr: map.uzqr.toString(),
    payme: map.payme.toString(),
    click: map.click.toString(),
    uzum: map.uzum.toString(),
    social_card: map.social_card.toString(),
    other: map.other.toString(),
  };
}

export function toOrderDto(order: StoredOrderRecord): OrderDto {
  return {
    id: order.id,
    organizationId: order.organizationId,
    storeId: order.storeId,
    deviceId: order.deviceId,
    orderNo: order.orderNo.toString(),
    orderCode: order.orderCode,
    status: order.status,
    customerId: order.customerId,
    customerName: order.customerName,
    customerPhoneNormalized: order.customerPhoneNormalized,
    dueAtMs: order.dueAtMs !== null ? order.dueAtMs.toString() : null,
    note: order.note,
    subtotalGross: order.subtotalGross.toString(),
    totalPromoDiscount: order.totalPromoDiscount.toString(),
    subtotalAfterPromo: order.subtotalAfterPromo.toString(),
    manualDiscountMode: order.manualDiscountMode,
    manualDiscountValue: order.manualDiscountValue.toString(),
    manualDiscountReason: order.manualDiscountReason,
    orderDiscountAmount: order.orderDiscountAmount.toString(),
    totalAmount: order.totalAmount.toString(),
    totalNetExVat: order.totalNetExVat.toString(),
    totalVat: order.totalVat.toString(),
    netAdvance: order.netAdvance.toString(),
    remainingToPay: order.remainingToPay.toString(),
    netAdvanceByMethod: toMethodAdvanceBreakdownDto(order.netAdvanceByMethod),
    overrideApprovedByUserId: order.overrideApprovedByUserId,
    overrideApprovedAmount:
      order.overrideApprovedAmount !== null ? order.overrideApprovedAmount.toString() : null,
    createdByUserId: order.createdByUserId,
    createdAtMs: order.createdAtMs.toString(),
    confirmedAtMs: order.confirmedAtMs !== null ? order.confirmedAtMs.toString() : null,
    readyAtMs: order.readyAtMs !== null ? order.readyAtMs.toString() : null,
    deliveredAtMs: order.deliveredAtMs !== null ? order.deliveredAtMs.toString() : null,
    deliveredSaleId: order.deliveredSaleId,
    cancelledAtMs: order.cancelledAtMs !== null ? order.cancelledAtMs.toString() : null,
    cancelledByUserId: order.cancelledByUserId,
    cancelReason: order.cancelReason,
    lines: order.lines.map(toOrderLineDto),
    payments: order.payments.map(toOrderPaymentDto),
  };
}

function mapSalePaymentsInput(
  inputs: readonly DeliverOrderRequestDto['payments'][number][],
): SalePaymentInput[] {
  return inputs.map((p) => {
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
}

export class HubOrderService {
  private readonly store: SqliteOrderStore;
  private readonly authService: HubAuthService;

  constructor(store: SqliteOrderStore, authService: HubAuthService) {
    this.store = store;
    this.authService = authService;
  }

  private async resolveCancelOrRefundOverride(
    session: AuthenticatedSessionSnapshot,
    override: LoginRequestDto | undefined,
  ): Promise<UuidV7 | null> {
    if (roleHasPermission(session.user.role, 'orders:cancel')) {
      return null;
    }
    if (!override) {
      throw new DomainError(
        'SUPERVISOR_OVERRIDE_REQUIRED',
        `Role "${session.user.role}" requires owner or manager PIN approval to refund advance or cancel an order`,
      );
    }
    const supervisor = await this.authService.verifySupervisorPin(override);
    return supervisor.id;
  }

  async createOrder(
    actorUserId: UuidV7,
    input: CreateOrderRequestDto,
  ): Promise<{
    readonly response: OrderActionResponseDto;
    readonly overrideApprovedByUserId: UuidV7 | null;
  }> {
    let overrideApprovedByUserId: UuidV7 | null = null;
    let mappedDiscount: SetCartDiscountInput | undefined;

    if (input.discount !== undefined) {
      if (input.discount.mode === 'none') {
        mappedDiscount = { mode: 'none' };
      } else {
        if (input.discount.override !== undefined) {
          const supervisor = await this.authService.verifySupervisorPin(input.discount.override);
          overrideApprovedByUserId = supervisor.id;
        }
        mappedDiscount =
          input.discount.mode === 'percent'
            ? {
                mode: 'percent',
                percentBp: input.discount.percentBp,
                reason: input.discount.reason,
                approvedSupervisorUserId: overrideApprovedByUserId,
              }
            : {
                mode: 'amount',
                amount: moneyFromTiyin(BigInt(input.discount.amount)),
                reason: input.discount.reason,
                approvedSupervisorUserId: overrideApprovedByUserId,
              };
      }
    }

    const mappedLines: CreateOrderLineInput[] = input.lines.map((l) => {
      if (l.kind === 'catalog') {
        return {
          kind: 'catalog',
          productId: l.productId,
          variantId: l.variantId,
          qty: quantityFromMilli(BigInt(l.qty)),
        };
      }
      return {
        kind: 'quick_sale',
        name: l.name,
        unit: l.unit,
        qty: quantityFromMilli(BigInt(l.qty)),
        unitPrice: moneyFromTiyin(BigInt(l.unitPrice)),
        mxik: l.mxik,
        packageCode: l.packageCode,
        vatRateBp: l.vatRateBp,
      };
    });

    const outcome = await this.store.createOrder({
      actorUserId,
      clientRequestId: input.clientRequestId,
      customerId: input.customerId,
      ...(input.customerName !== undefined ? { customerName: input.customerName } : {}),
      ...(input.customerPhone !== undefined ? { customerPhone: input.customerPhone } : {}),
      dueAtMs: input.dueAtMs !== null ? unixMsFromBigInt(BigInt(input.dueAtMs)) : null,
      note: input.note,
      confirmImmediately: input.confirmImmediately,
      ...(input.expectedTotal !== undefined
        ? { expectedTotal: moneyFromTiyin(BigInt(input.expectedTotal)) }
        : {}),
      ...(mappedDiscount !== undefined ? { discount: mappedDiscount } : {}),
      overrideApprovedByUserId,
      lines: mappedLines,
    });

    return {
      response: {
        order: toOrderDto(outcome.order),
        idempotentReplay: outcome.idempotentReplay,
      },
      overrideApprovedByUserId: outcome.order.overrideApprovedByUserId,
    };
  }

  async confirmOrder(
    orderId: UuidV7,
    actorUserId: UuidV7,
    input: ConfirmOrderRequestDto,
  ): Promise<OrderActionResponseDto> {
    const outcome = await this.store.confirmOrder({
      orderId,
      actorUserId,
      clientRequestId: input.clientRequestId,
    });
    return {
      order: toOrderDto(outcome.order),
      idempotentReplay: outcome.idempotentReplay,
    };
  }

  async markOrderReady(
    orderId: UuidV7,
    actorUserId: UuidV7,
    input: MarkOrderReadyRequestDto,
  ): Promise<OrderActionResponseDto> {
    const outcome = await this.store.markOrderReady({
      orderId,
      actorUserId,
      clientRequestId: input.clientRequestId,
    });
    return {
      order: toOrderDto(outcome.order),
      idempotentReplay: outcome.idempotentReplay,
    };
  }

  async recordOrderAdvance(
    orderId: UuidV7,
    actorUserId: UuidV7,
    input: RecordOrderAdvanceRequestDto,
  ): Promise<OrderActionResponseDto> {
    const outcome = await this.store.recordOrderAdvance({
      orderId,
      actorUserId,
      clientRequestId: input.clientRequestId,
      payments: mapSalePaymentsInput(input.payments),
    });
    return {
      order: toOrderDto(outcome.order),
      idempotentReplay: outcome.idempotentReplay,
    };
  }

  async refundOrderAdvance(
    orderId: UuidV7,
    session: AuthenticatedSessionSnapshot,
    input: RefundOrderAdvanceRequestDto,
  ): Promise<{
    readonly response: OrderActionResponseDto;
    readonly overrideApprovedByUserId: UuidV7 | null;
  }> {
    const overrideApprovedByUserId = await this.resolveCancelOrRefundOverride(
      session,
      input.override,
    );

    const mappedRefunds: ReturnPaymentInput[] = input.refunds.map((r) => {
      if (r.method === 'cash') {
        return {
          method: 'cash',
          amount: moneyFromTiyin(BigInt(r.amount)),
        };
      }
      return {
        method: r.method,
        amount: moneyFromTiyin(BigInt(r.amount)),
        ...(r.providerRef !== undefined ? { providerRef: r.providerRef } : {}),
      };
    });

    const outcome = await this.store.refundOrderAdvance({
      orderId,
      actorUserId: session.user.id,
      overrideApprovedByUserId,
      clientRequestId: input.clientRequestId,
      reason: input.reason,
      refunds: mappedRefunds,
    });

    return {
      response: {
        order: toOrderDto(outcome.order),
        idempotentReplay: outcome.idempotentReplay,
      },
      overrideApprovedByUserId,
    };
  }

  async deliverOrder(
    orderId: UuidV7,
    actorUserId: UuidV7,
    input: DeliverOrderRequestDto,
  ): Promise<DeliverOrderResponseDto> {
    let creditOverrideApprovedByUserId: UuidV7 | null = null;
    if (input.creditOverride !== undefined) {
      const supervisor = await this.authService.verifySupervisorPin(input.creditOverride);
      creditOverrideApprovedByUserId = supervisor.id;
    }

    const outcome = await this.store.deliverOrder({
      orderId,
      actorUserId,
      clientRequestId: input.clientRequestId,
      expectedTotal: moneyFromTiyin(BigInt(input.expectedTotal)),
      debtAmount:
        input.debtAmount !== undefined ? moneyFromTiyin(BigInt(input.debtAmount)) : ZERO_MONEY,
      ...(input.customerId !== undefined ? { customerId: input.customerId } : {}),
      ...(input.dueDays !== undefined ? { dueDays: input.dueDays } : {}),
      creditOverrideApprovedByUserId,
      payments: mapSalePaymentsInput(input.payments),
    });

    return {
      order: toOrderDto(outcome.order),
      sale: toSaleDto(outcome.sale),
      warnings: outcome.warnings.map(toWarningDto),
      idempotentReplay: outcome.idempotentReplay,
    };
  }

  async cancelOrder(
    orderId: UuidV7,
    session: AuthenticatedSessionSnapshot,
    input: CancelOrderRequestDto,
  ): Promise<{
    readonly response: OrderActionResponseDto;
    readonly overrideApprovedByUserId: UuidV7 | null;
  }> {
    const overrideApprovedByUserId = await this.resolveCancelOrRefundOverride(
      session,
      input.override,
    );

    const outcome = await this.store.cancelOrder({
      orderId,
      actorUserId: session.user.id,
      overrideApprovedByUserId,
      clientRequestId: input.clientRequestId,
      reason: input.reason,
    });

    return {
      response: {
        order: toOrderDto(outcome.order),
        idempotentReplay: outcome.idempotentReplay,
      },
      overrideApprovedByUserId,
    };
  }

  async getOrder(orderId: UuidV7): Promise<OrderDto> {
    const order = await this.store.getOrder(orderId);
    return toOrderDto(order);
  }

  async listOrders(query: ListOrdersQueryDto): Promise<ListOrdersResponseDto> {
    const res = await this.store.listOrders({
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.customerId !== undefined ? { customerId: query.customerId } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.offset !== undefined ? { offset: query.offset } : {}),
    });
    return {
      orders: res.orders.map(toOrderDto),
      total: res.total,
    };
  }

  async getOpenAdvancesTotal(): Promise<OpenAdvancesResponseDto> {
    const res = await this.store.getOpenAdvancesTotal();
    return {
      totalOpenAdvance: res.totalOpenAdvance.toString(),
      byMethod: toMethodAdvanceBreakdownDto(res.byMethod),
      openOrdersCount: res.openOrdersCount,
    };
  }
}
