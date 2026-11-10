import type {
  AddCartLineRequestDto,
  CartDetailDto,
  CartLineDto,
  CartResponseDto,
  CartSettingsResponseDto,
  CartSummaryDto,
  CreatePromotionRequestDto,
  DeleteCartResponseDto,
  DeletePromotionResponseDto,
  ListCartsResponseDto,
  ListPromotionsQueryDto,
  ListPromotionsResponseDto,
  PromotionResponseDto,
  PromotionSummaryDto,
  SetCartDiscountRequestDto,
  UpdateCartLineRequestDto,
  UpdateCartSettingsRequestDto,
  UpdatePromotionRequestDto,
} from '@mezon/contracts';
import type {
  SqliteCartStore,
  StoredCartDetailRecord,
  StoredCartDiscountSettings,
  StoredCartLineRecord,
  StoredCartSummaryRecord,
  StoredPromotionRecord,
} from '@mezon/db-local';
import {
  DomainError,
  type UuidV7,
  moneyFromTiyin,
  quantityFromMilli,
  unixMsFromBigInt,
} from '@mezon/domain';
import type { HubAuthService } from './auth-service.js';

function toPromotionDto(p: StoredPromotionRecord): PromotionSummaryDto {
  return {
    id: p.id,
    organizationId: p.organizationId,
    storeId: p.storeId,
    name: p.name,
    type: p.type,
    scope: p.scope,
    targetProductId: p.targetProductId,
    targetCategoryId: p.targetCategoryId,
    discountPercentBp: p.discountPercentBp,
    discountAmount: p.discountAmount !== null ? p.discountAmount.toString() : null,
    buyQty: p.buyQty,
    freeQty: p.freeQty,
    startsAtMs: p.startsAtMs.toString(),
    endsAtMs: p.endsAtMs !== null ? p.endsAtMs.toString() : null,
    isActive: p.isActive,
    createdAtMs: p.createdAtMs.toString(),
    updatedAtMs: p.updatedAtMs.toString(),
  };
}

function toCartSettingsDto(s: StoredCartDiscountSettings): CartSettingsResponseDto {
  return {
    cashierDiscountLimit: {
      percentUnlimited: s.cashierDiscountLimit.percentUnlimited,
      maxPercentBp: Number(s.cashierDiscountLimit.maxPercentBp),
      amountUnlimited: s.cashierDiscountLimit.amountUnlimited,
      maxAmount: s.cashierDiscountLimit.maxAmount.toString(),
    },
    unlimitedDiscountEnabled: s.unlimitedDiscountEnabled,
    quickSaleDefaultMxik: s.quickSaleDefaultMxik,
    quickSaleDefaultVatRateBp: s.quickSaleDefaultVatRateBp,
  };
}

function toCartLineDto(l: StoredCartLineRecord): CartLineDto {
  return {
    id: l.id,
    sortOrder: l.sortOrder,
    lineKind: l.lineKind,
    productId: l.productId,
    variantId: l.variantId,
    categoryIdSnapshot: l.categoryIdSnapshot,
    name: l.name,
    unit: l.unit,
    qty: l.qty.toString(),
    unitPriceSnapshot: l.unitPriceSnapshot.toString(),
    mxikSnapshot: l.mxikSnapshot,
    packageCodeSnapshot: l.packageCodeSnapshot,
    vatRateBpSnapshot: l.vatRateBpSnapshot,
    appliedPromotionId: l.appliedPromotionId,
    appliedPromotionName: l.appliedPromotionName,
    freeUnits: l.freeUnits,
    grossTotal: l.grossTotal.toString(),
    promoDiscount: l.promoDiscount.toString(),
    subtotalAfterPromo: l.subtotalAfterPromo.toString(),
    allocatedOrderDiscount: l.allocatedOrderDiscount.toString(),
    finalTotal: l.finalTotal.toString(),
    netExVat: l.netExVat.toString(),
    vatTotal: l.vatTotal.toString(),
    priceChangeWarning: l.priceChangeWarning
      ? {
          snapshotUnitPrice: l.priceChangeWarning.snapshotUnitPrice.toString(),
          currentUnitPrice:
            l.priceChangeWarning.currentUnitPrice !== null
              ? l.priceChangeWarning.currentUnitPrice.toString()
              : null,
          catalogDeleted: l.priceChangeWarning.catalogDeleted,
        }
      : null,
  };
}

function toCartSummaryDto(c: StoredCartSummaryRecord): CartSummaryDto {
  return {
    id: c.id,
    organizationId: c.organizationId,
    storeId: c.storeId,
    cashierUserId: c.cashierUserId,
    status: c.status,
    parkLabel: c.parkLabel,
    parkedAtMs: c.parkedAtMs !== null ? c.parkedAtMs.toString() : null,
    manualDiscountMode: c.manualDiscountMode,
    manualDiscountValue: c.manualDiscountValue.toString(),
    manualDiscountReason: c.manualDiscountReason,
    overrideApprovedByUserId: c.overrideApprovedByUserId,
    overrideApprovedAmount:
      c.overrideApprovedAmount !== null ? c.overrideApprovedAmount.toString() : null,
    overrideApprovedAtMs:
      c.overrideApprovedAtMs !== null ? c.overrideApprovedAtMs.toString() : null,
    lineCount: c.lineCount,
    totalFinal: c.totalFinal.toString(),
    priceWarningsCount: c.priceWarningsCount,
    discountOverrideRequired: c.discountOverrideRequired,
    createdAtMs: c.createdAtMs.toString(),
    updatedAtMs: c.updatedAtMs.toString(),
  };
}

function toCartDetailDto(c: StoredCartDetailRecord): CartDetailDto {
  return {
    id: c.id,
    organizationId: c.organizationId,
    storeId: c.storeId,
    cashierUserId: c.cashierUserId,
    status: c.status,
    parkLabel: c.parkLabel,
    parkedAtMs: c.parkedAtMs !== null ? c.parkedAtMs.toString() : null,
    manualDiscountMode: c.manualDiscountMode,
    manualDiscountValue: c.manualDiscountValue.toString(),
    manualDiscountReason: c.manualDiscountReason,
    overrideApprovedByUserId: c.overrideApprovedByUserId,
    overrideApprovedAmount:
      c.overrideApprovedAmount !== null ? c.overrideApprovedAmount.toString() : null,
    overrideApprovedAtMs:
      c.overrideApprovedAtMs !== null ? c.overrideApprovedAtMs.toString() : null,
    subtotalGross: c.subtotalGross.toString(),
    totalPromoDiscount: c.totalPromoDiscount.toString(),
    subtotalAfterPromo: c.subtotalAfterPromo.toString(),
    requestedOrderDiscount: c.requestedOrderDiscount.toString(),
    effectiveOrderDiscount: c.effectiveOrderDiscount.toString(),
    totalFinal: c.totalFinal.toString(),
    totalNetExVat: c.totalNetExVat.toString(),
    totalVat: c.totalVat.toString(),
    totalFreeUnits: c.totalFreeUnits,
    exceedsCashierLimit: c.exceedsCashierLimit,
    discountAuthorized: c.discountAuthorized,
    discountOverrideRequired: c.discountOverrideRequired,
    priceWarningsCount: c.priceWarningsCount,
    lines: c.lines.map(toCartLineDto),
    createdAtMs: c.createdAtMs.toString(),
    updatedAtMs: c.updatedAtMs.toString(),
  };
}

export class HubCartService {
  private readonly store: SqliteCartStore;
  private readonly authService: HubAuthService;

  constructor(store: SqliteCartStore, authService: HubAuthService) {
    this.store = store;
    this.authService = authService;
  }

  async getSettings(): Promise<CartSettingsResponseDto> {
    const res = await this.store.getDiscountSettings();
    return toCartSettingsDto(res);
  }

  async updateSettings(input: UpdateCartSettingsRequestDto): Promise<CartSettingsResponseDto> {
    const res = await this.store.updateDiscountSettings({
      cashierDiscountLimit: {
        percentUnlimited: input.cashierDiscountLimit.percentUnlimited,
        maxPercentBp: BigInt(input.cashierDiscountLimit.maxPercentBp),
        amountUnlimited: input.cashierDiscountLimit.amountUnlimited,
        maxAmount: moneyFromTiyin(BigInt(input.cashierDiscountLimit.maxAmount)),
      },
      quickSaleDefaultMxik: input.quickSaleDefaultMxik,
      quickSaleDefaultVatRateBp: input.quickSaleDefaultVatRateBp,
    });
    return toCartSettingsDto(res);
  }

  async listPromotions(query: ListPromotionsQueryDto): Promise<ListPromotionsResponseDto> {
    const res = await this.store.listPromotions({ activeOnly: query.activeOnly });
    return { promotions: res.map(toPromotionDto) };
  }

  async createPromotion(input: CreatePromotionRequestDto): Promise<PromotionResponseDto> {
    const res = await this.store.createPromotion({
      storeId: input.storeId,
      name: input.name,
      type: input.type,
      scope: input.scope,
      targetProductId: input.targetProductId,
      targetCategoryId: input.targetCategoryId,
      discountPercentBp: input.discountPercentBp,
      discountAmount:
        input.discountAmount !== null ? moneyFromTiyin(BigInt(input.discountAmount)) : null,
      buyQty: input.buyQty,
      freeQty: input.freeQty,
      startsAtMs: unixMsFromBigInt(BigInt(input.startsAtMs)),
      endsAtMs: input.endsAtMs !== null ? unixMsFromBigInt(BigInt(input.endsAtMs)) : null,
      isActive: input.isActive,
    });
    return { promotion: toPromotionDto(res) };
  }

  async updatePromotion(
    promotionId: UuidV7,
    input: UpdatePromotionRequestDto,
  ): Promise<PromotionResponseDto> {
    const res = await this.store.updatePromotion(promotionId, {
      name: input.name,
      startsAtMs:
        input.startsAtMs !== undefined ? unixMsFromBigInt(BigInt(input.startsAtMs)) : undefined,
      endsAtMs:
        input.endsAtMs !== undefined
          ? input.endsAtMs !== null
            ? unixMsFromBigInt(BigInt(input.endsAtMs))
            : null
          : undefined,
      isActive: input.isActive,
      discountPercentBp: input.discountPercentBp,
      discountAmount:
        input.discountAmount !== undefined
          ? moneyFromTiyin(BigInt(input.discountAmount))
          : undefined,
      buyQty: input.buyQty,
      freeQty: input.freeQty,
    });
    return { promotion: toPromotionDto(res) };
  }

  async deletePromotion(promotionId: UuidV7): Promise<DeletePromotionResponseDto> {
    await this.store.deletePromotion(promotionId);
    return { deletedId: promotionId };
  }

  async openCart(cashierUserId: UuidV7): Promise<CartResponseDto> {
    const res = await this.store.openCart(cashierUserId);
    return { cart: toCartDetailDto(res) };
  }

  async listCarts(): Promise<ListCartsResponseDto> {
    const res = await this.store.listCarts();
    return { carts: res.map(toCartSummaryDto) };
  }

  async getCart(cartId: UuidV7): Promise<CartResponseDto> {
    const res = await this.store.getCart(cartId);
    return { cart: toCartDetailDto(res) };
  }

  async deleteCart(cartId: UuidV7): Promise<DeleteCartResponseDto> {
    await this.store.deleteCart(cartId);
    return { deletedId: cartId };
  }

  async addLine(cartId: UuidV7, input: AddCartLineRequestDto): Promise<CartResponseDto> {
    const res =
      input.kind === 'catalog'
        ? await this.store.addLine(cartId, {
            kind: 'catalog',
            productId: input.productId,
            variantId: input.variantId,
            qty: quantityFromMilli(BigInt(input.qty)),
          })
        : input.kind === 'scan'
          ? await this.store.addLine(cartId, {
              kind: 'scan',
              barcode: input.barcode,
              qty: quantityFromMilli(BigInt(input.qty)),
            })
          : await this.store.addLine(cartId, {
              kind: 'quick_sale',
              name: input.name,
              unit: input.unit,
              qty: quantityFromMilli(BigInt(input.qty)),
              unitPrice: moneyFromTiyin(BigInt(input.unitPrice)),
              mxik: input.mxik,
              packageCode: input.packageCode,
              vatRateBp: input.vatRateBp,
            });
    return { cart: toCartDetailDto(res) };
  }

  async updateLine(
    cartId: UuidV7,
    lineId: UuidV7,
    input: UpdateCartLineRequestDto,
  ): Promise<CartResponseDto> {
    const res = await this.store.updateLine(cartId, lineId, {
      qty: input.qty !== undefined ? quantityFromMilli(BigInt(input.qty)) : undefined,
      name: input.name,
      unitPrice:
        input.unitPrice !== undefined ? moneyFromTiyin(BigInt(input.unitPrice)) : undefined,
    });
    return { cart: toCartDetailDto(res) };
  }

  async removeLine(cartId: UuidV7, lineId: UuidV7): Promise<CartResponseDto> {
    const res = await this.store.removeLine(cartId, lineId);
    return { cart: toCartDetailDto(res) };
  }

  async refreshPrices(cartId: UuidV7): Promise<CartResponseDto> {
    const res = await this.store.refreshPrices(cartId);
    return { cart: toCartDetailDto(res) };
  }

  async setDiscount(cartId: UuidV7, input: SetCartDiscountRequestDto): Promise<CartResponseDto> {
    if (input.mode === 'none') {
      const res = await this.store.setDiscount(cartId, { mode: 'none' });
      return { cart: toCartDetailDto(res) };
    }

    const previewInput =
      input.mode === 'percent'
        ? { mode: 'percent' as const, percentBp: input.percentBp }
        : { mode: 'amount' as const, amount: moneyFromTiyin(BigInt(input.amount)) };

    const { requiresOverride } = await this.store.previewDiscountRequiresOverride(
      cartId,
      previewInput,
    );

    let approvedSupervisorUserId: UuidV7 | null = null;
    if (requiresOverride) {
      if (!input.override) {
        throw new DomainError(
          'DISCOUNT_OVERRIDE_REQUIRED',
          'Manual discount exceeds cashier limit and requires supervisor PIN approval',
        );
      }
      const supervisor = await this.authService.verifySupervisorPin(input.override);
      approvedSupervisorUserId = supervisor.id;
    }

    const res =
      input.mode === 'percent'
        ? await this.store.setDiscount(cartId, {
            mode: 'percent',
            percentBp: input.percentBp,
            reason: input.reason,
            approvedSupervisorUserId,
          })
        : await this.store.setDiscount(cartId, {
            mode: 'amount',
            amount: moneyFromTiyin(BigInt(input.amount)),
            reason: input.reason,
            approvedSupervisorUserId,
          });

    return { cart: toCartDetailDto(res) };
  }

  async parkCart(cartId: UuidV7, label: string | null): Promise<CartResponseDto> {
    const res = await this.store.parkCart(cartId, label);
    return { cart: toCartDetailDto(res) };
  }

  async resumeCart(cartId: UuidV7): Promise<CartResponseDto> {
    const res = await this.store.resumeCart(cartId);
    return { cart: toCartDetailDto(res) };
  }
}
