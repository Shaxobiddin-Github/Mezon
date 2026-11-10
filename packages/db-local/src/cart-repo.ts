import {
  type CartLineInput,
  type CartLineKind,
  type CartStatus,
  type CashierDiscountPolicy,
  DomainError,
  type ManualDiscountMode,
  type Money,
  type ProductUnit,
  type PromotionRule,
  type PromotionScope,
  type PromotionType,
  type Quantity,
  type UnixMs,
  type UuidV7,
  ZERO_MONEY,
  assertCartDiscountAuthorized,
  buildScanBarcodeCandidates,
  evaluateCart,
  isPromotionActiveAt,
  moneyFromTiyin,
  moneyToTiyin,
  normalizeCatalogDisplayName,
  normalizeFiscalCode,
  normalizePriceChangeReason,
  parseProductUnit,
  parseUuidV7,
  quantityFromMilli,
  quantityToMilli,
  unixMsFromBigInt,
  validateNonNegativeSalePrice,
  validatePromotionRuleInput,
  validateQuantityForUnit,
  vatRateFromBasisPoints,
} from '@mezon/domain';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { LocalSqliteConnection } from './connection.js';
import {
  categories,
  localCartLines,
  localCarts,
  localHubConfig,
  productBarcodes,
  productVariants,
  products,
  promotions,
} from './schema/index.js';
import type { SqliteUnitOfWork, SqliteUnitOfWorkSession } from './uow.js';
import { insertAttr, tombstoneAttr, updateAttr } from './writers.js';

export interface CartRuntimeContext {
  readonly uow: SqliteUnitOfWork;
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7;
}

export interface CreateSqliteCartStoreOptions {
  readonly connection: LocalSqliteConnection;
  readonly getRuntimeContext: () => CartRuntimeContext | null;
}

export interface StoredPromotionRecord {
  readonly id: UuidV7;
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7 | null;
  readonly name: string;
  readonly type: PromotionType;
  readonly scope: PromotionScope;
  readonly targetProductId: UuidV7 | null;
  readonly targetCategoryId: UuidV7 | null;
  readonly discountPercentBp: number | null;
  readonly discountAmount: Money | null;
  readonly buyQty: number | null;
  readonly freeQty: number | null;
  readonly startsAtMs: UnixMs;
  readonly endsAtMs: UnixMs | null;
  readonly isActive: boolean;
  readonly createdAtMs: UnixMs;
  readonly updatedAtMs: UnixMs;
}

export interface StoredCartDiscountSettings {
  readonly cashierDiscountLimit: CashierDiscountPolicy;
  readonly unlimitedDiscountEnabled: boolean;
  readonly quickSaleDefaultMxik: string | null;
  readonly quickSaleDefaultVatRateBp: number | null;
}

export interface StoredPriceChangeWarning {
  readonly snapshotUnitPrice: Money;
  readonly currentUnitPrice: Money | null;
  readonly catalogDeleted: boolean;
}

export interface StoredCartLineRecord {
  readonly id: UuidV7;
  readonly sortOrder: number;
  readonly lineKind: CartLineKind;
  readonly productId: UuidV7 | null;
  readonly variantId: UuidV7 | null;
  readonly categoryIdSnapshot: UuidV7 | null;
  readonly name: string;
  readonly unit: ProductUnit;
  readonly qty: Quantity;
  readonly unitPriceSnapshot: Money;
  readonly mxikSnapshot: string | null;
  readonly packageCodeSnapshot: string | null;
  readonly vatRateBpSnapshot: number;
  readonly appliedPromotionId: UuidV7 | null;
  readonly appliedPromotionName: string | null;
  readonly freeUnits: number;
  readonly grossTotal: Money;
  readonly promoDiscount: Money;
  readonly subtotalAfterPromo: Money;
  readonly allocatedOrderDiscount: Money;
  readonly finalTotal: Money;
  readonly netExVat: Money;
  readonly vatTotal: Money;
  readonly priceChangeWarning: StoredPriceChangeWarning | null;
}

export interface StoredCartSummaryRecord {
  readonly id: UuidV7;
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7;
  readonly cashierUserId: UuidV7;
  readonly status: CartStatus;
  readonly parkLabel: string | null;
  readonly parkedAtMs: UnixMs | null;
  readonly manualDiscountMode: ManualDiscountMode;
  readonly manualDiscountValue: bigint;
  readonly manualDiscountReason: string | null;
  readonly overrideApprovedByUserId: UuidV7 | null;
  readonly overrideApprovedAmount: Money | null;
  readonly overrideApprovedAtMs: UnixMs | null;
  readonly lineCount: number;
  readonly totalFinal: Money;
  readonly priceWarningsCount: number;
  readonly discountOverrideRequired: boolean;
  readonly createdAtMs: UnixMs;
  readonly updatedAtMs: UnixMs;
}

export interface StoredCartDetailRecord {
  readonly id: UuidV7;
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7;
  readonly cashierUserId: UuidV7;
  readonly status: CartStatus;
  readonly parkLabel: string | null;
  readonly parkedAtMs: UnixMs | null;
  readonly manualDiscountMode: ManualDiscountMode;
  readonly manualDiscountValue: bigint;
  readonly manualDiscountReason: string | null;
  readonly overrideApprovedByUserId: UuidV7 | null;
  readonly overrideApprovedAmount: Money | null;
  readonly overrideApprovedAtMs: UnixMs | null;
  readonly subtotalGross: Money;
  readonly totalPromoDiscount: Money;
  readonly subtotalAfterPromo: Money;
  readonly requestedOrderDiscount: Money;
  readonly effectiveOrderDiscount: Money;
  readonly totalFinal: Money;
  readonly totalNetExVat: Money;
  readonly totalVat: Money;
  readonly totalFreeUnits: number;
  readonly exceedsCashierLimit: boolean;
  readonly discountAuthorized: boolean;
  readonly discountOverrideRequired: boolean;
  readonly priceWarningsCount: number;
  readonly lines: readonly StoredCartLineRecord[];
  readonly createdAtMs: UnixMs;
  readonly updatedAtMs: UnixMs;
}

export type AddCartLineInput =
  | {
      readonly kind: 'catalog';
      readonly productId: UuidV7;
      readonly variantId: UuidV7 | null;
      readonly qty: Quantity;
    }
  | {
      readonly kind: 'scan';
      readonly barcode: string;
      readonly qty: Quantity;
    }
  | {
      readonly kind: 'quick_sale';
      readonly name: string;
      readonly unit: ProductUnit;
      readonly qty: Quantity;
      readonly unitPrice: Money;
      readonly mxik: string | null;
      readonly packageCode: string | null;
      readonly vatRateBp: number | null;
    };

export type SetCartDiscountInput =
  | { readonly mode: 'none' }
  | {
      readonly mode: 'percent';
      readonly percentBp: number;
      readonly reason: string | null;
      readonly approvedSupervisorUserId: UuidV7 | null;
    }
  | {
      readonly mode: 'amount';
      readonly amount: Money;
      readonly reason: string | null;
      readonly approvedSupervisorUserId: UuidV7 | null;
    };

function toStoredPromotion(row: typeof promotions.$inferSelect): StoredPromotionRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    storeId: row.targetStoreId,
    name: row.name,
    type: row.type as PromotionType,
    scope: row.scope as PromotionScope,
    targetProductId: row.targetProductId,
    targetCategoryId: row.targetCategoryId,
    discountPercentBp: row.discountPercentBp,
    discountAmount: row.discountAmount !== null ? moneyFromTiyin(row.discountAmount) : null,
    buyQty: row.buyQty,
    freeQty: row.freeQty,
    startsAtMs: row.startsAtMs,
    endsAtMs: row.endsAtMs,
    isActive: Boolean(row.isActive),
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

function toPromotionRule(row: StoredPromotionRecord): PromotionRule {
  return {
    id: row.id,
    storeId: row.storeId,
    name: row.name,
    type: row.type,
    scope: row.scope,
    targetProductId: row.targetProductId,
    targetCategoryId: row.targetCategoryId,
    discountPercentBp: row.discountPercentBp !== null ? BigInt(row.discountPercentBp) : null,
    discountAmount: row.discountAmount,
    buyQty: row.buyQty !== null ? BigInt(row.buyQty) : null,
    freeQty: row.freeQty !== null ? BigInt(row.freeQty) : null,
    startsAtMs: row.startsAtMs,
    endsAtMs: row.endsAtMs,
    isActive: row.isActive,
  };
}

function toDiscountSettings(row: typeof localHubConfig.$inferSelect): StoredCartDiscountSettings {
  const percentUnlimited = Boolean(row.cashierDiscountPercentUnlimited);
  const amountUnlimited = Boolean(row.cashierDiscountAmountUnlimited);
  return {
    cashierDiscountLimit: {
      percentUnlimited,
      maxPercentBp: BigInt(row.cashierMaxDiscountPercentBp),
      amountUnlimited,
      maxAmount: moneyFromTiyin(row.cashierMaxDiscountAmount),
    },
    unlimitedDiscountEnabled: percentUnlimited || amountUnlimited,
    quickSaleDefaultMxik: row.quickSaleDefaultMxik,
    quickSaleDefaultVatRateBp: row.quickSaleDefaultVatRateBp,
  };
}

function toManualDiscountInput(cartRow: typeof localCarts.$inferSelect): {
  readonly mode: ManualDiscountMode;
  readonly percentBp: number;
  readonly amount: Money;
} {
  const mode = cartRow.manualDiscountMode as ManualDiscountMode;
  if (mode === 'percent') {
    return {
      mode: 'percent',
      percentBp: Number(cartRow.manualDiscountValue),
      amount: ZERO_MONEY,
    };
  }
  if (mode === 'amount') {
    return {
      mode: 'amount',
      percentBp: 0,
      amount: moneyFromTiyin(cartRow.manualDiscountValue),
    };
  }
  return { mode: 'none', percentBp: 0, amount: ZERO_MONEY };
}

function isSqliteCheckOrConstraintError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const code = (err as { readonly code?: unknown }).code;
  return (
    code === 'SQLITE_CONSTRAINT_CHECK' ||
    code === 'SQLITE_CONSTRAINT_FOREIGNKEY' ||
    code === 'SQLITE_CONSTRAINT_TRIGGER'
  );
}

export class SqliteCartStore {
  private readonly connection: LocalSqliteConnection;
  private readonly getRuntimeContext: () => CartRuntimeContext | null;

  constructor(options: CreateSqliteCartStoreOptions) {
    this.connection = options.connection;
    this.getRuntimeContext = options.getRuntimeContext;
  }

  private requireContext(): CartRuntimeContext {
    const ctx = this.getRuntimeContext();
    if (ctx === null) {
      throw new DomainError('AUTH_UNAUTHORIZED', 'Hub setup has not been completed');
    }
    return ctx;
  }

  private readHubSettingsSync(organizationId: UuidV7): StoredCartDiscountSettings {
    const row = this.connection.db
      .select()
      .from(localHubConfig)
      .where(eq(localHubConfig.organizationId, organizationId))
      .limit(1)
      .all()[0];
    if (!row) {
      throw new DomainError('AUTH_UNAUTHORIZED', 'Hub setup configuration is missing');
    }
    return toDiscountSettings(row);
  }

  private readOrgPromotionsSync(organizationId: UuidV7): readonly StoredPromotionRecord[] {
    const rows = this.connection.db
      .select()
      .from(promotions)
      .where(and(eq(promotions.organizationId, organizationId), isNull(promotions.deletedAtMs)))
      .orderBy(asc(promotions.startsAtMs), asc(promotions.id))
      .all();
    return rows.map(toStoredPromotion);
  }

  private requireCartRowSync(
    ctx: CartRuntimeContext,
    cartId: UuidV7,
  ): typeof localCarts.$inferSelect {
    const validId = parseUuidV7(cartId);
    const row = this.connection.db
      .select()
      .from(localCarts)
      .where(
        and(
          eq(localCarts.id, validId),
          eq(localCarts.organizationId, ctx.organizationId),
          eq(localCarts.storeId, ctx.storeId),
        ),
      )
      .limit(1)
      .all()[0];
    if (!row) {
      throw new DomainError('CART_NOT_FOUND', `Cart "${cartId}" was not found`);
    }
    return row;
  }

  private requireOpenCartRowSync(
    ctx: CartRuntimeContext,
    cartId: UuidV7,
  ): typeof localCarts.$inferSelect {
    const row = this.requireCartRowSync(ctx, cartId);
    if (row.status !== 'open') {
      throw new DomainError('CART_NOT_OPEN', `Cart "${cartId}" is "${row.status}", not "open"`);
    }
    return row;
  }

  private readCartLineRowsSync(cartId: UuidV7): readonly (typeof localCartLines.$inferSelect)[] {
    return this.connection.db
      .select()
      .from(localCartLines)
      .where(eq(localCartLines.cartId, cartId))
      .orderBy(asc(localCartLines.sortOrder), asc(localCartLines.id))
      .all();
  }

  private buildPriceWarningsMapSync(
    organizationId: UuidV7,
    lineRows: readonly (typeof localCartLines.$inferSelect)[],
  ): Map<UuidV7, StoredPriceChangeWarning | null> {
    const result = new Map<UuidV7, StoredPriceChangeWarning | null>();
    const catalogLines = lineRows.filter((l) => l.lineKind === 'catalog' && l.productId !== null);
    if (catalogLines.length === 0) {
      return result;
    }

    const productIds = [...new Set(catalogLines.map((l) => l.productId!))];
    const prodRows = this.connection.db
      .select()
      .from(products)
      .where(
        and(
          eq(products.organizationId, organizationId),
          isNull(products.deletedAtMs),
          inArray(products.id, productIds),
        ),
      )
      .all();
    const prodMap = new Map(prodRows.map((p) => [p.id, p]));

    const variantIds = [
      ...new Set(catalogLines.map((l) => l.variantId).filter((v): v is UuidV7 => v !== null)),
    ];
    const varRows =
      variantIds.length > 0
        ? this.connection.db
            .select()
            .from(productVariants)
            .where(
              and(
                eq(productVariants.organizationId, organizationId),
                isNull(productVariants.deletedAtMs),
                inArray(productVariants.id, variantIds),
              ),
            )
            .all()
        : [];
    const varMap = new Map(varRows.map((v) => [v.id, v]));

    for (const line of catalogLines) {
      const prod = line.productId ? prodMap.get(line.productId) : undefined;
      if (!prod) {
        result.set(line.id, {
          snapshotUnitPrice: moneyFromTiyin(line.unitPriceSnapshot),
          currentUnitPrice: null,
          catalogDeleted: true,
        });
        continue;
      }
      if (line.variantId !== null) {
        const variant = varMap.get(line.variantId);
        if (!variant || variant.productId !== prod.id) {
          result.set(line.id, {
            snapshotUnitPrice: moneyFromTiyin(line.unitPriceSnapshot),
            currentUnitPrice: null,
            catalogDeleted: true,
          });
          continue;
        }
        const livePrice = variant.salePrice ?? prod.salePrice;
        result.set(
          line.id,
          livePrice !== line.unitPriceSnapshot
            ? {
                snapshotUnitPrice: moneyFromTiyin(line.unitPriceSnapshot),
                currentUnitPrice: moneyFromTiyin(livePrice),
                catalogDeleted: false,
              }
            : null,
        );
      } else {
        const livePrice = prod.salePrice;
        result.set(
          line.id,
          livePrice !== line.unitPriceSnapshot
            ? {
                snapshotUnitPrice: moneyFromTiyin(line.unitPriceSnapshot),
                currentUnitPrice: moneyFromTiyin(livePrice),
                catalogDeleted: false,
              }
            : null,
        );
      }
    }

    return result;
  }

  private evaluateCartRowSync(
    ctx: CartRuntimeContext,
    cartRow: typeof localCarts.$inferSelect,
    nowMs: UnixMs,
    manualDiscountOverride?: {
      readonly mode: ManualDiscountMode;
      readonly percentBp: number;
      readonly amount: Money;
      readonly approvedByUserId: UuidV7 | null;
      readonly approvedAmount: Money | null;
    },
  ): StoredCartDetailRecord {
    const lineRows = this.readCartLineRowsSync(cartRow.id);
    const settings = this.readHubSettingsSync(ctx.organizationId);
    const promoRules = this.readOrgPromotionsSync(ctx.organizationId).map(toPromotionRule);
    const warningsMap = this.buildPriceWarningsMapSync(ctx.organizationId, lineRows);

    const domainLines: CartLineInput[] = lineRows.map((l) => ({
      id: l.id,
      lineKind: l.lineKind as CartLineKind,
      productId: l.productId,
      variantId: l.variantId,
      categoryId: l.categoryIdSnapshot,
      name: l.itemName,
      unit: parseProductUnit(l.unit),
      qty: quantityFromMilli(l.qty),
      unitPriceSnapshot: moneyFromTiyin(l.unitPriceSnapshot),
      vatRate: vatRateFromBasisPoints(BigInt(l.vatRateBpSnapshot)),
    }));

    const discInput = manualDiscountOverride ?? {
      ...toManualDiscountInput(cartRow),
      approvedByUserId: cartRow.overrideApprovedByUserId,
      approvedAmount:
        cartRow.overrideApprovedAmount !== null
          ? moneyFromTiyin(cartRow.overrideApprovedAmount)
          : null,
    };

    const evaluation = evaluateCart({
      storeId: ctx.storeId,
      nowMs,
      lines: domainLines,
      promotions: promoRules,
      manualDiscount: {
        mode: discInput.mode,
        percentBp: BigInt(discInput.percentBp),
        amount: discInput.amount,
      },
      policy: settings.cashierDiscountLimit,
      overrideApprovedByUserId: discInput.approvedByUserId,
      overrideApprovedAmount: discInput.approvedAmount,
    });

    let priceWarningsCount = 0;
    const storedLines: StoredCartLineRecord[] = evaluation.lines.map((ev, idx) => {
      const srcRow = lineRows[idx];
      if (!srcRow) {
        throw new Error('Cart line alignment mismatch during evaluation');
      }
      const warning = warningsMap.get(ev.id) ?? null;
      if (warning !== null) {
        priceWarningsCount += 1;
      }
      return {
        id: ev.id,
        sortOrder: srcRow.sortOrder,
        lineKind: ev.lineKind,
        productId: ev.productId,
        variantId: ev.variantId,
        categoryIdSnapshot: ev.categoryId,
        name: ev.name,
        unit: ev.unit,
        qty: ev.qty,
        unitPriceSnapshot: ev.unitPriceSnapshot,
        mxikSnapshot: srcRow.mxikSnapshot,
        packageCodeSnapshot: srcRow.packageCodeSnapshot,
        vatRateBpSnapshot: srcRow.vatRateBpSnapshot,
        appliedPromotionId: ev.appliedPromotionId,
        appliedPromotionName: ev.appliedPromotionName,
        freeUnits: Number(ev.freeUnits),
        grossTotal: ev.grossTotal,
        promoDiscount: ev.promoDiscount,
        subtotalAfterPromo: ev.subtotalAfterPromo,
        allocatedOrderDiscount: ev.allocatedOrderDiscount,
        finalTotal: ev.finalTotal,
        netExVat: ev.netExVat,
        vatTotal: ev.vatTotal,
        priceChangeWarning: warning,
      };
    });

    return {
      id: cartRow.id,
      organizationId: cartRow.organizationId,
      storeId: cartRow.storeId,
      cashierUserId: cartRow.cashierUserId,
      status: cartRow.status as CartStatus,
      parkLabel: cartRow.parkLabel,
      parkedAtMs: cartRow.parkedAtMs,
      manualDiscountMode: discInput.mode,
      manualDiscountValue:
        discInput.mode === 'percent'
          ? BigInt(discInput.percentBp)
          : discInput.mode === 'amount'
            ? moneyToTiyin(discInput.amount)
            : 0n,
      manualDiscountReason: cartRow.manualDiscountReason,
      overrideApprovedByUserId: discInput.approvedByUserId,
      overrideApprovedAmount: discInput.approvedAmount,
      overrideApprovedAtMs:
        discInput.approvedByUserId !== null ? cartRow.overrideApprovedAtMs : null,
      subtotalGross: evaluation.subtotalGross,
      totalPromoDiscount: evaluation.totalPromoDiscount,
      subtotalAfterPromo: evaluation.subtotalAfterPromo,
      requestedOrderDiscount: evaluation.requestedOrderDiscount,
      effectiveOrderDiscount: evaluation.effectiveOrderDiscount,
      totalFinal: evaluation.totalFinal,
      totalNetExVat: evaluation.totalNetExVat,
      totalVat: evaluation.totalVat,
      totalFreeUnits: Number(evaluation.totalFreeUnits),
      exceedsCashierLimit: evaluation.exceedsCashierLimit,
      discountAuthorized: evaluation.discountAuthorized,
      discountOverrideRequired: evaluation.discountOverrideRequired,
      priceWarningsCount,
      lines: storedLines,
      createdAtMs: cartRow.createdAtMs,
      updatedAtMs: cartRow.updatedAtMs,
    };
  }

  private revokeOverrideIfNeededSync(
    session: SqliteUnitOfWorkSession,
    ctx: CartRuntimeContext,
    cartRow: typeof localCarts.$inferSelect,
    nowMs: UnixMs,
  ): typeof localCarts.$inferSelect {
    if (cartRow.overrideApprovedByUserId === null) {
      return cartRow;
    }
    const evaluated = this.evaluateCartRowSync(ctx, cartRow, nowMs);
    if (!evaluated.discountOverrideRequired) {
      return cartRow;
    }
    // P2: cart grew beyond override_approved_amount (and exceeds cashier limit) -> revoke approval
    session.db
      .update(localCarts)
      .set({
        overrideApprovedByUserId: null,
        overrideApprovedAmount: null,
        overrideApprovedAtMs: null,
        updatedAtMs: nowMs,
      })
      .where(eq(localCarts.id, cartRow.id))
      .run();

    return {
      ...cartRow,
      overrideApprovedByUserId: null,
      overrideApprovedAmount: null,
      overrideApprovedAtMs: null,
      updatedAtMs: nowMs,
    };
  }

  // --- Discount & Quick-Sale Settings (P3) ---

  async getDiscountSettings(): Promise<StoredCartDiscountSettings> {
    const { uow, organizationId } = this.requireContext();
    return uow.runReadOnly(() => Promise.resolve(this.readHubSettingsSync(organizationId)));
  }

  async updateDiscountSettings(input: {
    readonly cashierDiscountLimit: CashierDiscountPolicy;
    readonly quickSaleDefaultMxik: string | null;
    readonly quickSaleDefaultVatRateBp: number | null;
  }): Promise<StoredCartDiscountSettings> {
    const { uow, organizationId } = this.requireContext();
    const { maxPercentBp, percentUnlimited, maxAmount, amountUnlimited } =
      input.cashierDiscountLimit;

    if (maxPercentBp < 0n || maxPercentBp > 10_000n) {
      throw new DomainError('VALIDATION_ERROR', 'maxPercentBp must be between 0 and 10000');
    }
    const maxPercentInt = Number(maxPercentBp);
    if (!Number.isSafeInteger(maxPercentInt)) {
      throw new DomainError('VALIDATION_ERROR', 'maxPercentBp must fit safe integer');
    }
    const maxAmtTiyin = moneyToTiyin(maxAmount);
    if (maxAmtTiyin < 0n) {
      throw new DomainError('VALIDATION_ERROR', 'maxAmount must be non-negative');
    }
    const cleanMxik = normalizeFiscalCode(input.quickSaleDefaultMxik, 'Quick-sale MXIK');
    if (
      input.quickSaleDefaultVatRateBp !== null &&
      (!Number.isSafeInteger(input.quickSaleDefaultVatRateBp) ||
        input.quickSaleDefaultVatRateBp < 0 ||
        input.quickSaleDefaultVatRateBp > 10_000)
    ) {
      throw new DomainError(
        'VALIDATION_ERROR',
        'quickSaleDefaultVatRateBp must be null or in 0..10000',
      );
    }

    return uow.execute((session) => {
      const nowMs = session.nowUnixMs();
      session.db
        .update(localHubConfig)
        .set({
          cashierDiscountPercentUnlimited: percentUnlimited,
          cashierMaxDiscountPercentBp: maxPercentInt,
          cashierDiscountAmountUnlimited: amountUnlimited,
          cashierMaxDiscountAmount: maxAmount,
          quickSaleDefaultMxik: cleanMxik,
          quickSaleDefaultVatRateBp: input.quickSaleDefaultVatRateBp,
          updatedAtMs: nowMs,
        })
        .where(eq(localHubConfig.organizationId, organizationId))
        .run();

      return Promise.resolve(this.readHubSettingsSync(organizationId));
    });
  }

  // --- Promotions CRUD (`ATTR`) ---

  async listPromotions(
    options: { readonly activeOnly?: boolean } = {},
  ): Promise<readonly StoredPromotionRecord[]> {
    const { uow, organizationId, storeId } = this.requireContext();
    return uow.runReadOnly(() => {
      const all = this.readOrgPromotionsSync(organizationId);
      if (!options.activeOnly) {
        return Promise.resolve(all);
      }
      const nowMs = unixMsFromBigInt(uow.internalClock.now());
      return Promise.resolve(
        all.filter((p) => isPromotionActiveAt(toPromotionRule(p), nowMs, storeId)),
      );
    });
  }

  private resolvePromotionTargetsSync(
    organizationId: UuidV7,
    scope: PromotionScope,
    targetProductId: UuidV7 | null,
    targetCategoryId: UuidV7 | null,
  ): { readonly targetProductUnit: ProductUnit | null } {
    if (scope === 'product') {
      if (targetProductId === null) {
        throw new DomainError('INVALID_PROMOTION', 'Product promotion requires targetProductId');
      }
      const prod = this.connection.db
        .select()
        .from(products)
        .where(
          and(
            eq(products.organizationId, organizationId),
            eq(products.id, targetProductId),
            isNull(products.deletedAtMs),
          ),
        )
        .limit(1)
        .all()[0];
      if (!prod) {
        throw new DomainError('PRODUCT_NOT_FOUND', `Product "${targetProductId}" was not found`);
      }
      return { targetProductUnit: parseProductUnit(prod.unit) };
    }

    if (scope === 'category') {
      if (targetCategoryId === null) {
        throw new DomainError('INVALID_PROMOTION', 'Category promotion requires targetCategoryId');
      }
      const cat = this.connection.db
        .select()
        .from(categories)
        .where(
          and(
            eq(categories.organizationId, organizationId),
            eq(categories.id, targetCategoryId),
            isNull(categories.deletedAtMs),
          ),
        )
        .limit(1)
        .all()[0];
      if (!cat) {
        throw new DomainError('CATEGORY_NOT_FOUND', `Category "${targetCategoryId}" was not found`);
      }
      return { targetProductUnit: null };
    }

    return { targetProductUnit: null };
  }

  async createPromotion(input: {
    readonly storeId: UuidV7 | null;
    readonly name: string;
    readonly type: PromotionType;
    readonly scope: PromotionScope;
    readonly targetProductId: UuidV7 | null;
    readonly targetCategoryId: UuidV7 | null;
    readonly discountPercentBp: number | null;
    readonly discountAmount: Money | null;
    readonly buyQty: number | null;
    readonly freeQty: number | null;
    readonly startsAtMs: UnixMs;
    readonly endsAtMs: UnixMs | null;
    readonly isActive: boolean;
  }): Promise<StoredPromotionRecord> {
    const { uow, organizationId } = this.requireContext();
    const cleanName = normalizeCatalogDisplayName(input.name, 'Promotion name', 200);
    const storeFilter = input.storeId !== null ? parseUuidV7(input.storeId) : null;

    return uow.execute((session) => {
      const { targetProductUnit } = this.resolvePromotionTargetsSync(
        organizationId,
        input.scope,
        input.targetProductId,
        input.targetCategoryId,
      );

      validatePromotionRuleInput({
        name: cleanName,
        type: input.type,
        scope: input.scope,
        targetProductId: input.targetProductId,
        targetCategoryId: input.targetCategoryId,
        discountPercentBp:
          input.discountPercentBp !== null ? BigInt(input.discountPercentBp) : null,
        discountAmount: input.discountAmount,
        buyQty: input.buyQty !== null ? BigInt(input.buyQty) : null,
        freeQty: input.freeQty !== null ? BigInt(input.freeQty) : null,
        startsAtMs: input.startsAtMs,
        endsAtMs: input.endsAtMs,
        targetProductUnit,
      });

      const res = insertAttr(session, promotions, {
        organizationId,
        values: {
          targetStoreId: storeFilter,
          name: cleanName,
          type: input.type,
          scope: input.scope,
          targetProductId: input.targetProductId,
          targetCategoryId: input.targetCategoryId,
          discountPercentBp: input.discountPercentBp,
          discountAmount: input.discountAmount,
          buyQty: input.buyQty,
          freeQty: input.freeQty,
          startsAtMs: input.startsAtMs,
          endsAtMs: input.endsAtMs,
          isActive: input.isActive,
        },
        eventType: 'promotion.created',
        schemaVersion: 1,
      });
      return Promise.resolve(toStoredPromotion(res.row));
    });
  }

  async updatePromotion(
    promotionId: UuidV7,
    patch: {
      readonly name?: string;
      readonly startsAtMs?: UnixMs;
      readonly endsAtMs?: UnixMs | null;
      readonly isActive?: boolean;
      readonly discountPercentBp?: number;
      readonly discountAmount?: Money;
      readonly buyQty?: number;
      readonly freeQty?: number;
    },
  ): Promise<StoredPromotionRecord> {
    const { uow, organizationId } = this.requireContext();
    const validId = parseUuidV7(promotionId);

    return uow.execute((session) => {
      const existing = session.db
        .select()
        .from(promotions)
        .where(
          and(
            eq(promotions.organizationId, organizationId),
            eq(promotions.id, validId),
            isNull(promotions.deletedAtMs),
          ),
        )
        .limit(1)
        .all()[0];
      if (!existing) {
        throw new DomainError('PROMOTION_NOT_FOUND', `Promotion "${promotionId}" was not found`);
      }

      const nextName =
        patch.name !== undefined
          ? normalizeCatalogDisplayName(patch.name, 'Promotion name', 200)
          : existing.name;
      const nextStartsAtMs = patch.startsAtMs ?? existing.startsAtMs;
      const nextEndsAtMs = patch.endsAtMs !== undefined ? patch.endsAtMs : existing.endsAtMs;
      const nextIsActive = patch.isActive ?? Boolean(existing.isActive);
      const nextDiscountPercentBp =
        patch.discountPercentBp !== undefined
          ? patch.discountPercentBp
          : existing.discountPercentBp;
      const nextDiscountAmount =
        patch.discountAmount !== undefined
          ? patch.discountAmount
          : existing.discountAmount !== null
            ? moneyFromTiyin(existing.discountAmount)
            : null;
      const nextBuyQty = patch.buyQty !== undefined ? patch.buyQty : existing.buyQty;
      const nextFreeQty = patch.freeQty !== undefined ? patch.freeQty : existing.freeQty;

      const { targetProductUnit } = this.resolvePromotionTargetsSync(
        organizationId,
        existing.scope as PromotionScope,
        existing.targetProductId,
        existing.targetCategoryId,
      );

      validatePromotionRuleInput({
        name: nextName,
        type: existing.type as PromotionType,
        scope: existing.scope as PromotionScope,
        targetProductId: existing.targetProductId,
        targetCategoryId: existing.targetCategoryId,
        discountPercentBp: nextDiscountPercentBp !== null ? BigInt(nextDiscountPercentBp) : null,
        discountAmount: nextDiscountAmount,
        buyQty: nextBuyQty !== null ? BigInt(nextBuyQty) : null,
        freeQty: nextFreeQty !== null ? BigInt(nextFreeQty) : null,
        startsAtMs: nextStartsAtMs,
        endsAtMs: nextEndsAtMs,
        targetProductUnit,
      });

      const res = updateAttr(session, promotions, {
        id: validId,
        organizationId,
        values: {
          name: nextName,
          startsAtMs: nextStartsAtMs,
          endsAtMs: nextEndsAtMs,
          isActive: nextIsActive,
          discountPercentBp: nextDiscountPercentBp,
          discountAmount: nextDiscountAmount,
          buyQty: nextBuyQty,
          freeQty: nextFreeQty,
        },
        eventType: 'promotion.updated',
        schemaVersion: 1,
      });
      return Promise.resolve(toStoredPromotion(res.row));
    });
  }

  async deletePromotion(promotionId: UuidV7): Promise<void> {
    const { uow, organizationId } = this.requireContext();
    const validId = parseUuidV7(promotionId);

    await uow.execute((session) => {
      const existing = session.db
        .select({ id: promotions.id })
        .from(promotions)
        .where(
          and(
            eq(promotions.organizationId, organizationId),
            eq(promotions.id, validId),
            isNull(promotions.deletedAtMs),
          ),
        )
        .limit(1)
        .all()[0];
      if (!existing) {
        throw new DomainError('PROMOTION_NOT_FOUND', `Promotion "${promotionId}" was not found`);
      }
      tombstoneAttr(session, promotions, {
        id: validId,
        organizationId,
        eventType: 'promotion.deleted',
        schemaVersion: 1,
      });
      return Promise.resolve();
    });
  }

  // --- Cart Operations (`LOCAL`, NO stock writes, NO outbox) ---

  async openCart(cashierUserId: UuidV7): Promise<StoredCartDetailRecord> {
    const ctx = this.requireContext();
    const validCashierId = parseUuidV7(cashierUserId);

    return ctx.uow.execute((session) => {
      const nowMs = session.nowUnixMs();
      const cartId = session.nextId();
      try {
        session.db
          .insert(localCarts)
          .values({
            id: cartId,
            organizationId: ctx.organizationId,
            storeId: ctx.storeId,
            cashierUserId: validCashierId,
            status: 'open',
            parkLabel: null,
            parkedAtMs: null,
            manualDiscountMode: 'none',
            manualDiscountValue: 0n,
            manualDiscountReason: null,
            overrideApprovedByUserId: null,
            overrideApprovedAmount: null,
            overrideApprovedAtMs: null,
            createdAtMs: nowMs,
            updatedAtMs: nowMs,
          })
          .run();
      } catch (err) {
        if (isSqliteCheckOrConstraintError(err)) {
          throw new DomainError('USER_NOT_FOUND', `Cashier "${cashierUserId}" was not found`);
        }
        throw err;
      }

      const created = this.requireCartRowSync(ctx, cartId);
      return Promise.resolve(this.evaluateCartRowSync(ctx, created, nowMs));
    });
  }

  async listCarts(): Promise<readonly StoredCartSummaryRecord[]> {
    const ctx = this.requireContext();
    return ctx.uow.runReadOnly(() => {
      const nowMs = unixMsFromBigInt(ctx.uow.internalClock.now());
      const rows = this.connection.db
        .select()
        .from(localCarts)
        .where(
          and(
            eq(localCarts.organizationId, ctx.organizationId),
            eq(localCarts.storeId, ctx.storeId),
          ),
        )
        .orderBy(desc(localCarts.updatedAtMs), desc(localCarts.id))
        .all();

      const summaries: StoredCartSummaryRecord[] = rows.map((row) => {
        const detail = this.evaluateCartRowSync(ctx, row, nowMs);
        return {
          id: detail.id,
          organizationId: detail.organizationId,
          storeId: detail.storeId,
          cashierUserId: detail.cashierUserId,
          status: detail.status,
          parkLabel: detail.parkLabel,
          parkedAtMs: detail.parkedAtMs,
          manualDiscountMode: detail.manualDiscountMode,
          manualDiscountValue: detail.manualDiscountValue,
          manualDiscountReason: detail.manualDiscountReason,
          overrideApprovedByUserId: detail.overrideApprovedByUserId,
          overrideApprovedAmount: detail.overrideApprovedAmount,
          overrideApprovedAtMs: detail.overrideApprovedAtMs,
          lineCount: detail.lines.length,
          totalFinal: detail.totalFinal,
          priceWarningsCount: detail.priceWarningsCount,
          discountOverrideRequired: detail.discountOverrideRequired,
          createdAtMs: detail.createdAtMs,
          updatedAtMs: detail.updatedAtMs,
        };
      });

      return Promise.resolve(summaries);
    });
  }

  async getCart(cartId: UuidV7): Promise<StoredCartDetailRecord> {
    const ctx = this.requireContext();
    return ctx.uow.runReadOnly(() => {
      const row = this.requireCartRowSync(ctx, cartId);
      const nowMs = unixMsFromBigInt(ctx.uow.internalClock.now());
      return Promise.resolve(this.evaluateCartRowSync(ctx, row, nowMs));
    });
  }

  async deleteCart(cartId: UuidV7): Promise<void> {
    const ctx = this.requireContext();
    await ctx.uow.execute((session) => {
      const row = this.requireCartRowSync(ctx, cartId);
      session.db.delete(localCarts).where(eq(localCarts.id, row.id)).run();
      return Promise.resolve();
    });
  }

  private resolveCatalogLineInputSync(
    organizationId: UuidV7,
    input: Extract<AddCartLineInput, { readonly kind: 'catalog' | 'scan' }>,
  ): {
    readonly productId: UuidV7;
    readonly variantId: UuidV7 | null;
    readonly categoryIdSnapshot: UuidV7 | null;
    readonly itemName: string;
    readonly unit: ProductUnit;
    readonly unitPriceSnapshot: Money;
    readonly mxikSnapshot: string | null;
    readonly packageCodeSnapshot: string | null;
    readonly vatRateBpSnapshot: number;
  } {
    let productId: UuidV7;
    let variantId: UuidV7 | null;

    if (input.kind === 'scan') {
      const candidates = buildScanBarcodeCandidates(input.barcode);
      const hit = this.connection.db
        .select()
        .from(productBarcodes)
        .where(
          and(
            eq(productBarcodes.organizationId, organizationId),
            isNull(productBarcodes.deletedAtMs),
            inArray(productBarcodes.barcode, [...candidates]),
          ),
        )
        .limit(1)
        .all()[0];
      if (!hit) {
        throw new DomainError('BARCODE_NOT_FOUND', `Barcode "${input.barcode}" was not found`);
      }
      productId = hit.productId;
      variantId = hit.variantId;
    } else {
      productId = parseUuidV7(input.productId);
      variantId = input.variantId !== null ? parseUuidV7(input.variantId) : null;
    }

    const prod = this.connection.db
      .select()
      .from(products)
      .where(
        and(
          eq(products.organizationId, organizationId),
          eq(products.id, productId),
          isNull(products.deletedAtMs),
        ),
      )
      .limit(1)
      .all()[0];
    if (!prod) {
      throw new DomainError('PRODUCT_NOT_FOUND', `Product "${productId}" was not found`);
    }

    let itemName = prod.name;
    let unitPrice = prod.salePrice;

    if (variantId !== null) {
      const variant = this.connection.db
        .select()
        .from(productVariants)
        .where(
          and(
            eq(productVariants.organizationId, organizationId),
            eq(productVariants.id, variantId),
            eq(productVariants.productId, prod.id),
            isNull(productVariants.deletedAtMs),
          ),
        )
        .limit(1)
        .all()[0];
      if (!variant) {
        throw new DomainError(
          'VARIANT_NOT_FOUND',
          `Variant "${variantId}" was not found for product "${productId}"`,
        );
      }
      itemName = `${prod.name} (${variant.name})`;
      unitPrice = variant.salePrice ?? prod.salePrice;
    }

    return {
      productId: prod.id,
      variantId,
      categoryIdSnapshot: prod.categoryId,
      itemName,
      unit: parseProductUnit(prod.unit),
      unitPriceSnapshot: moneyFromTiyin(unitPrice),
      mxikSnapshot: prod.mxik,
      packageCodeSnapshot: prod.packageCode,
      vatRateBpSnapshot: prod.vatRateBp,
    };
  }

  async addLine(cartId: UuidV7, input: AddCartLineInput): Promise<StoredCartDetailRecord> {
    const ctx = this.requireContext();

    return ctx.uow.execute((session) => {
      const nowMs = session.nowUnixMs();
      let cartRow = this.requireOpenCartRowSync(ctx, cartId);
      const existingLines = this.readCartLineRowsSync(cartRow.id);
      const lastExistingLine = existingLines[existingLines.length - 1];
      const nextSortOrder = lastExistingLine ? lastExistingLine.sortOrder + 1 : 0;

      if (input.kind === 'catalog' || input.kind === 'scan') {
        const resolved = this.resolveCatalogLineInputSync(ctx.organizationId, input);
        validateQuantityForUnit(resolved.unit, input.qty, { allowZero: false });
        const addQtyMilli = quantityToMilli(input.qty);

        // P1: merge into existing line if productId + variantId + unitPriceSnapshot match
        const mergeTarget = existingLines.find(
          (l) =>
            l.lineKind === 'catalog' &&
            l.productId === resolved.productId &&
            l.variantId === resolved.variantId &&
            l.unitPriceSnapshot === resolved.unitPriceSnapshot,
        );

        if (mergeTarget) {
          const nextQty = quantityFromMilli(mergeTarget.qty + addQtyMilli);
          session.db
            .update(localCartLines)
            .set({
              qty: nextQty,
              updatedAtMs: nowMs,
            })
            .where(eq(localCartLines.id, mergeTarget.id))
            .run();
        } else {
          session.db
            .insert(localCartLines)
            .values({
              id: session.nextId(),
              organizationId: ctx.organizationId,
              storeId: ctx.storeId,
              cartId: cartRow.id,
              sortOrder: nextSortOrder,
              lineKind: 'catalog',
              productId: resolved.productId,
              variantId: resolved.variantId,
              categoryIdSnapshot: resolved.categoryIdSnapshot,
              itemName: resolved.itemName,
              unit: resolved.unit,
              qty: input.qty,
              unitPriceSnapshot: resolved.unitPriceSnapshot,
              mxikSnapshot: resolved.mxikSnapshot,
              packageCodeSnapshot: resolved.packageCodeSnapshot,
              vatRateBpSnapshot: resolved.vatRateBpSnapshot,
              createdAtMs: nowMs,
              updatedAtMs: nowMs,
            })
            .run();
        }
      } else {
        // quick_sale lines are NEVER merged
        const cleanName = normalizeCatalogDisplayName(input.name, 'Item name', 200);
        validateQuantityForUnit(input.unit, input.qty, { allowZero: false });
        validateNonNegativeSalePrice(input.unitPrice);

        const settings = this.readHubSettingsSync(ctx.organizationId);
        const mxikSnap =
          input.mxik !== null
            ? normalizeFiscalCode(input.mxik, 'MXIK')
            : settings.quickSaleDefaultMxik;
        const pkgSnap = normalizeFiscalCode(input.packageCode, 'Package code');
        const vatBp = input.vatRateBp ?? settings.quickSaleDefaultVatRateBp ?? 0;

        session.db
          .insert(localCartLines)
          .values({
            id: session.nextId(),
            organizationId: ctx.organizationId,
            storeId: ctx.storeId,
            cartId: cartRow.id,
            sortOrder: nextSortOrder,
            lineKind: 'quick_sale',
            productId: null,
            variantId: null,
            categoryIdSnapshot: null,
            itemName: cleanName,
            unit: input.unit,
            qty: input.qty,
            unitPriceSnapshot: input.unitPrice,
            mxikSnapshot: mxikSnap,
            packageCodeSnapshot: pkgSnap,
            vatRateBpSnapshot: vatBp,
            createdAtMs: nowMs,
            updatedAtMs: nowMs,
          })
          .run();
      }

      session.db
        .update(localCarts)
        .set({ updatedAtMs: nowMs })
        .where(eq(localCarts.id, cartRow.id))
        .run();
      cartRow = { ...cartRow, updatedAtMs: nowMs };
      cartRow = this.revokeOverrideIfNeededSync(session, ctx, cartRow, nowMs);

      return Promise.resolve(this.evaluateCartRowSync(ctx, cartRow, nowMs));
    });
  }

  async updateLine(
    cartId: UuidV7,
    lineId: UuidV7,
    patch: {
      readonly qty?: Quantity;
      readonly name?: string;
      readonly unitPrice?: Money;
    },
  ): Promise<StoredCartDetailRecord> {
    const ctx = this.requireContext();
    const validLineId = parseUuidV7(lineId);

    return ctx.uow.execute((session) => {
      const nowMs = session.nowUnixMs();
      let cartRow = this.requireOpenCartRowSync(ctx, cartId);
      const lineRow = session.db
        .select()
        .from(localCartLines)
        .where(and(eq(localCartLines.id, validLineId), eq(localCartLines.cartId, cartRow.id)))
        .limit(1)
        .all()[0];

      if (!lineRow) {
        throw new DomainError('CART_LINE_NOT_FOUND', `Cart line "${lineId}" was not found`);
      }

      if (
        (patch.name !== undefined || patch.unitPrice !== undefined) &&
        lineRow.lineKind !== 'quick_sale'
      ) {
        throw new DomainError(
          'VALIDATION_ERROR',
          'Cannot edit name or unitPrice directly on a catalog line',
        );
      }

      const unit = parseProductUnit(lineRow.unit);
      const nextQty =
        patch.qty !== undefined
          ? validateQuantityForUnit(unit, patch.qty, { allowZero: false })
          : quantityFromMilli(lineRow.qty);
      const nextName =
        patch.name !== undefined
          ? normalizeCatalogDisplayName(patch.name, 'Item name', 200)
          : lineRow.itemName;
      const nextPrice =
        patch.unitPrice !== undefined
          ? validateNonNegativeSalePrice(patch.unitPrice)
          : moneyFromTiyin(lineRow.unitPriceSnapshot);

      session.db
        .update(localCartLines)
        .set({
          qty: nextQty,
          itemName: nextName,
          unitPriceSnapshot: nextPrice,
          updatedAtMs: nowMs,
        })
        .where(eq(localCartLines.id, lineRow.id))
        .run();

      session.db
        .update(localCarts)
        .set({ updatedAtMs: nowMs })
        .where(eq(localCarts.id, cartRow.id))
        .run();
      cartRow = { ...cartRow, updatedAtMs: nowMs };
      cartRow = this.revokeOverrideIfNeededSync(session, ctx, cartRow, nowMs);

      return Promise.resolve(this.evaluateCartRowSync(ctx, cartRow, nowMs));
    });
  }

  async removeLine(cartId: UuidV7, lineId: UuidV7): Promise<StoredCartDetailRecord> {
    const ctx = this.requireContext();
    const validLineId = parseUuidV7(lineId);

    return ctx.uow.execute((session) => {
      const nowMs = session.nowUnixMs();
      let cartRow = this.requireOpenCartRowSync(ctx, cartId);
      const deleted = session.db
        .delete(localCartLines)
        .where(and(eq(localCartLines.id, validLineId), eq(localCartLines.cartId, cartRow.id)))
        .run();
      if (deleted.changes === 0) {
        throw new DomainError('CART_LINE_NOT_FOUND', `Cart line "${lineId}" was not found`);
      }

      session.db
        .update(localCarts)
        .set({ updatedAtMs: nowMs })
        .where(eq(localCarts.id, cartRow.id))
        .run();
      cartRow = { ...cartRow, updatedAtMs: nowMs };
      cartRow = this.revokeOverrideIfNeededSync(session, ctx, cartRow, nowMs);

      return Promise.resolve(this.evaluateCartRowSync(ctx, cartRow, nowMs));
    });
  }

  async refreshPrices(cartId: UuidV7): Promise<StoredCartDetailRecord> {
    const ctx = this.requireContext();

    return ctx.uow.execute((session) => {
      const nowMs = session.nowUnixMs();
      let cartRow = this.requireOpenCartRowSync(ctx, cartId);
      const existingLines = this.readCartLineRowsSync(cartRow.id);

      for (const line of existingLines) {
        if (line.lineKind !== 'catalog' || line.productId === null) {
          continue;
        }
        const prod = session.db
          .select()
          .from(products)
          .where(
            and(
              eq(products.organizationId, ctx.organizationId),
              eq(products.id, line.productId),
              isNull(products.deletedAtMs),
            ),
          )
          .limit(1)
          .all()[0];
        if (!prod) {
          continue;
        }

        let nextName = prod.name;
        let nextPrice = prod.salePrice;
        if (line.variantId !== null) {
          const variant = session.db
            .select()
            .from(productVariants)
            .where(
              and(
                eq(productVariants.organizationId, ctx.organizationId),
                eq(productVariants.id, line.variantId),
                eq(productVariants.productId, prod.id),
                isNull(productVariants.deletedAtMs),
              ),
            )
            .limit(1)
            .all()[0];
          if (!variant) {
            continue;
          }
          nextName = `${prod.name} (${variant.name})`;
          nextPrice = variant.salePrice ?? prod.salePrice;
        }

        session.db
          .update(localCartLines)
          .set({
            itemName: nextName,
            categoryIdSnapshot: prod.categoryId,
            unitPriceSnapshot: nextPrice,
            mxikSnapshot: prod.mxik,
            packageCodeSnapshot: prod.packageCode,
            vatRateBpSnapshot: prod.vatRateBp,
            updatedAtMs: nowMs,
          })
          .where(eq(localCartLines.id, line.id))
          .run();
      }

      // P1: consolidate any catalog lines that now share (productId, variantId, unitPriceSnapshot)
      const refreshedLines = this.readCartLineRowsSync(cartRow.id);
      const seenCatalogKeys = new Map<string, typeof localCartLines.$inferSelect>();
      for (const line of refreshedLines) {
        if (line.lineKind !== 'catalog' || line.productId === null) {
          continue;
        }
        const key = `${line.productId}:${line.variantId ?? ''}:${line.unitPriceSnapshot}`;
        const primary = seenCatalogKeys.get(key);
        if (primary) {
          const mergedQty = quantityFromMilli(primary.qty + line.qty);
          session.db
            .update(localCartLines)
            .set({ qty: mergedQty, updatedAtMs: nowMs })
            .where(eq(localCartLines.id, primary.id))
            .run();
          session.db.delete(localCartLines).where(eq(localCartLines.id, line.id)).run();
          seenCatalogKeys.set(key, { ...primary, qty: mergedQty });
        } else {
          seenCatalogKeys.set(key, line);
        }
      }

      session.db
        .update(localCarts)
        .set({ updatedAtMs: nowMs })
        .where(eq(localCarts.id, cartRow.id))
        .run();
      cartRow = { ...cartRow, updatedAtMs: nowMs };
      cartRow = this.revokeOverrideIfNeededSync(session, ctx, cartRow, nowMs);

      return Promise.resolve(this.evaluateCartRowSync(ctx, cartRow, nowMs));
    });
  }

  /**
   * Read-only preflight check before running off-lock Argon2id supervisor PIN verification.
   */
  async previewDiscountRequiresOverride(
    cartId: UuidV7,
    input:
      | { readonly mode: 'none' }
      | { readonly mode: 'percent'; readonly percentBp: number }
      | { readonly mode: 'amount'; readonly amount: Money },
  ): Promise<{ readonly requiresOverride: boolean }> {
    const ctx = this.requireContext();
    return ctx.uow.runReadOnly(() => {
      const cartRow = this.requireOpenCartRowSync(ctx, cartId);
      const nowMs = unixMsFromBigInt(ctx.uow.internalClock.now());
      const preview = this.evaluateCartRowSync(ctx, cartRow, nowMs, {
        mode: input.mode,
        percentBp: input.mode === 'percent' ? input.percentBp : 0,
        amount: input.mode === 'amount' ? input.amount : ZERO_MONEY,
        approvedByUserId: null,
        approvedAmount: null,
      });
      return Promise.resolve({ requiresOverride: preview.exceedsCashierLimit });
    });
  }

  async setDiscount(cartId: UuidV7, input: SetCartDiscountInput): Promise<StoredCartDetailRecord> {
    const ctx = this.requireContext();

    return ctx.uow.execute((session) => {
      const nowMs = session.nowUnixMs();
      const cartRow = this.requireOpenCartRowSync(ctx, cartId);

      if (input.mode === 'none') {
        session.db
          .update(localCarts)
          .set({
            manualDiscountMode: 'none',
            manualDiscountValue: 0n,
            manualDiscountReason: null,
            overrideApprovedByUserId: null,
            overrideApprovedAmount: null,
            overrideApprovedAtMs: null,
            updatedAtMs: nowMs,
          })
          .where(eq(localCarts.id, cartRow.id))
          .run();
        const refreshed = this.requireCartRowSync(ctx, cartRow.id);
        return Promise.resolve(this.evaluateCartRowSync(ctx, refreshed, nowMs));
      }

      const cleanReason = normalizePriceChangeReason(input.reason);
      const proposedPercentBp = input.mode === 'percent' ? input.percentBp : 0;
      const proposedAmount = input.mode === 'amount' ? input.amount : ZERO_MONEY;
      const proposedDbValue =
        input.mode === 'percent' ? BigInt(input.percentBp) : moneyToTiyin(input.amount);

      const preview = this.evaluateCartRowSync(ctx, cartRow, nowMs, {
        mode: input.mode,
        percentBp: proposedPercentBp,
        amount: proposedAmount,
        approvedByUserId: null,
        approvedAmount: null,
      });

      let approvedBy: UuidV7 | null = null;
      let approvedAmount: Money | null = null;
      let approvedAtMs: UnixMs | null = null;

      if (preview.exceedsCashierLimit) {
        if (!input.approvedSupervisorUserId) {
          throw new DomainError(
            'DISCOUNT_OVERRIDE_REQUIRED',
            'Manual discount exceeds cashier limit and requires supervisor PIN approval',
          );
        }
        approvedBy = parseUuidV7(input.approvedSupervisorUserId);
        approvedAmount = preview.effectiveOrderDiscount;
        approvedAtMs = nowMs;
      }

      session.db
        .update(localCarts)
        .set({
          manualDiscountMode: input.mode,
          manualDiscountValue: proposedDbValue,
          manualDiscountReason: cleanReason,
          overrideApprovedByUserId: approvedBy,
          overrideApprovedAmount: approvedAmount,
          overrideApprovedAtMs: approvedAtMs,
          updatedAtMs: nowMs,
        })
        .where(eq(localCarts.id, cartRow.id))
        .run();

      const updated = this.requireCartRowSync(ctx, cartRow.id);
      return Promise.resolve(this.evaluateCartRowSync(ctx, updated, nowMs));
    });
  }

  async parkCart(cartId: UuidV7, label: string | null = null): Promise<StoredCartDetailRecord> {
    const ctx = this.requireContext();
    const cleanLabel =
      label !== null ? normalizeCatalogDisplayName(label, 'Park label', 120) : null;

    return ctx.uow.execute((session) => {
      const nowMs = session.nowUnixMs();
      const cartRow = this.requireOpenCartRowSync(ctx, cartId);

      session.db
        .update(localCarts)
        .set({
          status: 'parked',
          parkLabel: cleanLabel,
          parkedAtMs: nowMs,
          updatedAtMs: nowMs,
        })
        .where(eq(localCarts.id, cartRow.id))
        .run();

      const updated = this.requireCartRowSync(ctx, cartRow.id);
      return Promise.resolve(this.evaluateCartRowSync(ctx, updated, nowMs));
    });
  }

  async resumeCart(cartId: UuidV7): Promise<StoredCartDetailRecord> {
    const ctx = this.requireContext();

    return ctx.uow.execute((session) => {
      const nowMs = session.nowUnixMs();
      const targetRow = this.requireCartRowSync(ctx, cartId);
      if (targetRow.status !== 'parked') {
        throw new DomainError(
          'CART_NOT_PARKED',
          `Cart "${cartId}" is "${targetRow.status}", not "parked"`,
        );
      }

      // Safely handle any currently open carts for this cashier without losing items
      const openRows = session.db
        .select()
        .from(localCarts)
        .where(
          and(
            eq(localCarts.organizationId, ctx.organizationId),
            eq(localCarts.storeId, ctx.storeId),
            eq(localCarts.cashierUserId, targetRow.cashierUserId),
            eq(localCarts.status, 'open'),
          ),
        )
        .all();

      for (const otherOpen of openRows) {
        const otherLines = this.readCartLineRowsSync(otherOpen.id);
        if (otherLines.length === 0) {
          session.db.delete(localCarts).where(eq(localCarts.id, otherOpen.id)).run();
        } else {
          session.db
            .update(localCarts)
            .set({
              status: 'parked',
              parkedAtMs: nowMs,
              updatedAtMs: nowMs,
            })
            .where(eq(localCarts.id, otherOpen.id))
            .run();
        }
      }

      session.db
        .update(localCarts)
        .set({
          status: 'open',
          parkedAtMs: null,
          updatedAtMs: nowMs,
        })
        .where(eq(localCarts.id, targetRow.id))
        .run();

      const resumed = this.requireCartRowSync(ctx, targetRow.id);
      return Promise.resolve(this.evaluateCartRowSync(ctx, resumed, nowMs));
    });
  }

  async assertCartDiscountAuthorized(cartId: UuidV7): Promise<StoredCartDetailRecord> {
    const ctx = this.requireContext();
    return ctx.uow.runReadOnly(() => {
      const cartRow = this.requireOpenCartRowSync(ctx, cartId);
      const nowMs = unixMsFromBigInt(ctx.uow.internalClock.now());
      const detail = this.evaluateCartRowSync(ctx, cartRow, nowMs);
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
      return Promise.resolve(detail);
    });
  }
}

export function createSqliteCartStore(options: CreateSqliteCartStoreOptions): SqliteCartStore {
  return new SqliteCartStore(options);
}
