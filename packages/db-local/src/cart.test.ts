import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DomainError,
  type PinHasher,
  ZERO_MONEY,
  moneyFromTiyin,
  parseUuidV7,
  quantityFromMilli,
  unixMsFromBigInt,
} from '@mezon/domain';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type SqliteCartStore,
  type SqliteCatalogStore,
  createSqliteCartStore,
  createSqliteCatalogStore,
  createSqliteHubAuthStore,
  listAllOutboxRecordsSync,
  migrateLocalDatabase,
  openLocalSqliteDatabase,
} from './index.js';

const FAST_TEST_HASHER: PinHasher = {
  hash: (pin) => Promise.resolve(`$stub$${pin}`),
  verify: (hash, pin) => Promise.resolve(hash === `$stub$${pin}`),
};

const tempDirs: string[] = [];

function createTempDbPath(name = 'cart.db'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-cart-'));
  tempDirs.push(dir);
  return path.join(dir, name);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function setupCartEnv(dbPath = createTempDbPath()) {
  const clock = new FixedClock(1_760_000_000_000n);
  const random = new SeededRandomSource(88);
  const connection = openLocalSqliteDatabase(dbPath);
  migrateLocalDatabase(connection.db);

  const authStore = await createSqliteHubAuthStore({
    connection,
    clock,
    random,
  });
  const setup = await authStore.completeSetup({
    fullName: 'Owner Cart',
    username: 'owner',
    pinHash: await FAST_TEST_HASHER.hash('849201'),
  });

  const manager = await authStore.createUser({
    fullName: 'Manager Cart',
    username: 'mgr',
    role: 'manager',
    pinHash: await FAST_TEST_HASHER.hash('592817'),
  });

  const cashier = await authStore.createUser({
    fullName: 'Cashier Cart',
    username: 'cashier',
    role: 'cashier',
    pinHash: await FAST_TEST_HASHER.hash('374829'),
  });

  const catalogStore: SqliteCatalogStore = createSqliteCatalogStore({
    connection,
    getRuntimeContext: () => {
      const ctx = authStore.getActiveRuntimeContext();
      return ctx ? { uow: ctx.uow, organizationId: ctx.config.organizationId } : null;
    },
  });

  const cartStore: SqliteCartStore = createSqliteCartStore({
    connection,
    getRuntimeContext: () => {
      const ctx = authStore.getActiveRuntimeContext();
      return ctx
        ? {
            uow: ctx.uow,
            organizationId: ctx.config.organizationId,
            storeId: ctx.config.storeId,
          }
        : null;
    },
  });

  return {
    dbPath,
    clock,
    connection,
    authStore,
    catalogStore,
    cartStore,
    organizationId: setup.organizationId,
    storeId: setup.storeId,
    ownerId: setup.owner.id,
    managerId: manager.id,
    cashierId: cashier.id,
  };
}

describe('@mezon/db-local - T1.3 Cart persistence, P1 merging, price warnings, park/resume, P2/P3 & promotions', () => {
  it('persists local carts across restart without emitting outbox/stock events, merges scans (P1), and warns then refreshes catalog price drift', async () => {
    const dbPath = createTempDbPath('persist-cart.db');
    const env = await setupCartEnv(dbPath);
    let cartId: ReturnType<typeof env.ownerId extends infer U ? () => U : never>;

    try {
      const drinks = await env.catalogStore.createCategory({ name: 'Ichimliklar', sortOrder: 1 });
      const cola = await env.catalogStore.createProduct({
        categoryId: drinks.id,
        name: 'Cola 1L',
        unit: 'dona',
        salePrice: '10000',
        vatRateBp: 1200,
        barcodes: [{ barcode: '4006381333931', format: 'ean13' }],
        actorUserId: env.ownerId,
      });

      const promo = await env.cartStore.createPromotion({
        storeId: null,
        name: 'Cola 2+1',
        type: 'buy_x_get_y',
        scope: 'product',
        targetProductId: cola.product.id,
        targetCategoryId: null,
        discountPercentBp: null,
        discountAmount: null,
        buyQty: 2,
        freeQty: 1,
        startsAtMs: unixMsFromBigInt(1_759_999_000_000n),
        endsAtMs: unixMsFromBigInt(1_760_100_000_000n),
        isActive: true,
      });
      expect(promo.buyQty).toBe(2);

      // Promotions is ATTR -> physical DELETE blocked by SQLite trigger
      expect(() => env.connection.sqlite.prepare('DELETE FROM "promotions"').run()).toThrow(
        /ATTR table "promotions" forbids physical DELETE/,
      );

      const outboxBeforeCart = listAllOutboxRecordsSync(env.connection.db).length;

      // Scan barcode 3 times -> merges into 1 line qty=3 -> 1 free unit (P1)
      const cart = await env.cartStore.openCart(env.cashierId);
      cartId = cart.id;
      await env.cartStore.addLine(cartId, {
        kind: 'scan',
        barcode: '4006381333931',
        qty: quantityFromMilli(1_000n),
      });
      await env.cartStore.addLine(cartId, {
        kind: 'scan',
        barcode: '4006381333931',
        qty: quantityFromMilli(1_000n),
      });
      const after3Scans = await env.cartStore.addLine(cartId, {
        kind: 'scan',
        barcode: '4006381333931',
        qty: quantityFromMilli(1_000n),
      });
      expect(after3Scans.lines).toHaveLength(1);
      expect(after3Scans.lines[0]?.qty).toBe(quantityFromMilli(3_000n));
      expect(after3Scans.totalFreeUnits).toBe(1);
      expect(after3Scans.totalPromoDiscount).toBe(moneyFromTiyin(10_000n));
      expect(after3Scans.totalFinal).toBe(moneyFromTiyin(20_000n));

      // Quick-sale lines never merge even if identical name/price
      await env.cartStore.updateDiscountSettings({
        cashierDiscountLimit: {
          percentUnlimited: false,
          maxPercentBp: 0n,
          amountUnlimited: false,
          maxAmount: ZERO_MONEY,
        },
        quickSaleDefaultMxik: '999900001111',
        quickSaleDefaultVatRateBp: 1200,
      });
      await env.cartStore.addLine(cartId, {
        kind: 'quick_sale',
        name: 'Paket',
        unit: 'dona',
        qty: quantityFromMilli(1_000n),
        unitPrice: moneyFromTiyin(2_000n),
        mxik: null,
        packageCode: null,
        vatRateBp: null,
      });
      const after2Quick = await env.cartStore.addLine(cartId, {
        kind: 'quick_sale',
        name: 'Paket',
        unit: 'dona',
        qty: quantityFromMilli(1_000n),
        unitPrice: moneyFromTiyin(2_000n),
        mxik: null,
        packageCode: null,
        vatRateBp: null,
      });
      expect(after2Quick.lines).toHaveLength(3);
      expect(after2Quick.lines[1]?.mxikSnapshot).toBe('999900001111');
      expect(after2Quick.lines[1]?.vatRateBpSnapshot).toBe(1200);

      // Update catalog price while cart is open -> cart keeps 10,000 snapshot WITH priceChangeWarning
      await env.catalogStore.updateProduct(cola.product.id, {
        salePrice: '12000',
        priceChangeReason: 'Yangi partiya',
        actorUserId: env.ownerId,
      });
      const warned = await env.cartStore.getCart(cartId);
      expect(warned.priceWarningsCount).toBe(1);
      expect(warned.lines[0]?.unitPriceSnapshot).toBe(moneyFromTiyin(10_000n));
      expect(warned.lines[0]?.priceChangeWarning).toEqual({
        snapshotUnitPrice: moneyFromTiyin(10_000n),
        currentUnitPrice: moneyFromTiyin(12_000n),
        catalogDeleted: false,
      });

      // Adding new scan at 12,000 creates second line (different price snapshot) while P1 pools total 4 -> still 1 free on cheaper 10,000 line
      const mixedPrice = await env.cartStore.addLine(cartId, {
        kind: 'scan',
        barcode: '4006381333931',
        qty: quantityFromMilli(1_000n),
      });
      expect(mixedPrice.lines).toHaveLength(4);
      expect(mixedPrice.totalFreeUnits).toBe(1);
      expect(mixedPrice.totalPromoDiscount).toBe(moneyFromTiyin(10_000n));

      // Refresh prices updates snapshots to 12,000 and consolidates identical catalog lines cleanly (qty 3+1=4 -> still 1 free at 12,000)
      const refreshed = await env.cartStore.refreshPrices(cartId);
      expect(refreshed.priceWarningsCount).toBe(0);
      expect(refreshed.lines.filter((l) => l.lineKind === 'catalog')).toHaveLength(1);
      expect(refreshed.lines[0]?.qty).toBe(quantityFromMilli(4_000n));
      expect(refreshed.lines[0]?.unitPriceSnapshot).toBe(moneyFromTiyin(12_000n));
      expect(refreshed.totalPromoDiscount).toBe(moneyFromTiyin(12_000n));

      // Zero outbox events and zero stock_moves written by ALL cart operations
      // (`updateProduct` with price change emits `product.updated` + `price_change.recorded` = +2)
      const outboxEvents = listAllOutboxRecordsSync(env.connection.db);
      expect(outboxEvents).toHaveLength(outboxBeforeCart + 2);
      expect(
        outboxEvents.some((e) => e.entity === 'local_carts' || e.entity === 'local_cart_lines'),
      ).toBe(false);
      const stockMoveCount = (
        env.connection.sqlite
          .prepare('SELECT COUNT(*) AS cnt FROM "stock_moves"')
          .safeIntegers(false)
          .get() as { readonly cnt: number }
      ).cnt;
      expect(stockMoveCount).toBe(0);

      await env.cartStore.parkCart(cartId, 'Kechiktirilgan');
    } finally {
      env.connection.close();
    }

    // Reopen SQLite database simulating app crash/restart -> parked cart & lines are intact!
    const reopened = await setupCartEnvForExistingDb(dbPath);
    try {
      const carts = await reopened.cartStore.listCarts();
      expect(carts).toHaveLength(1);
      expect(carts[0]?.status).toBe('parked');
      expect(carts[0]?.parkLabel).toBe('Kechiktirilgan');

      // Open another cart with an item, then resume parked cart -> existing open cart auto-parked cleanly
      const secondCart = await reopened.cartStore.openCart(reopened.cashierId);
      await reopened.cartStore.addLine(secondCart.id, {
        kind: 'quick_sale',
        name: 'Suv',
        unit: 'dona',
        qty: quantityFromMilli(1_000n),
        unitPrice: moneyFromTiyin(3_000n),
        mxik: null,
        packageCode: null,
        vatRateBp: null,
      });

      const firstParked = carts[0];
      if (!firstParked) {
        throw new Error('Expected parked cart');
      }
      const resumed = await reopened.cartStore.resumeCart(firstParked.id);
      expect(resumed.status).toBe('open');
      expect(resumed.lines.length).toBeGreaterThanOrEqual(3);

      const allAfterResume = await reopened.cartStore.listCarts();
      const autoParkedSecond = allAfterResume.find((c) => c.id === secondCart.id)!;
      expect(autoParkedSecond.status).toBe('parked');
    } finally {
      reopened.connection.close();
    }
  });

  it('P2: revokes supervisor discount approval when cart grows past override_approved_amount and enforces INVALID_PROMOTION on fractional N+M', async () => {
    const env = await setupCartEnv();
    try {
      const sugar = await env.catalogStore.createProduct({
        name: 'Shakar',
        unit: 'kg',
        salePrice: '15000',
        actorUserId: env.ownerId,
      });
      await expect(
        env.cartStore.createPromotion({
          storeId: null,
          name: 'Bad Sugar 2+1',
          type: 'buy_x_get_y',
          scope: 'product',
          targetProductId: sugar.product.id,
          targetCategoryId: null,
          discountPercentBp: null,
          discountAmount: null,
          buyQty: 2,
          freeQty: 1,
          startsAtMs: unixMsFromBigInt(1_760_000_000_000n),
          endsAtMs: null,
          isActive: true,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_PROMOTION' } satisfies Partial<DomainError>);

      const cart = await env.cartStore.openCart(env.cashierId);
      const item = await env.catalogStore.createProduct({
        name: 'Non',
        unit: 'dona',
        salePrice: '100000',
        actorUserId: env.ownerId,
      });
      await env.cartStore.addLine(cart.id, {
        kind: 'catalog',
        productId: item.product.id,
        variantId: null,
        qty: quantityFromMilli(1_000n),
      });

      // Supervisor approves 10% on 100,000 -> approved ceiling = 10,000
      const approved = await env.cartStore.setDiscount(cart.id, {
        mode: 'percent',
        percentBp: 1000,
        reason: 'Menejer ruxsati',
        approvedSupervisorUserId: env.managerId,
      });
      expect(approved.overrideApprovedByUserId).toBe(env.managerId);
      expect(approved.overrideApprovedAmount).toBe(moneyFromTiyin(10_000n));
      expect(approved.discountOverrideRequired).toBe(false);

      // Cart grows to 300,000 -> 10% = 30,000 > 10,000 -> approval automatically revoked!
      const grown = await env.cartStore.addLine(cart.id, {
        kind: 'catalog',
        productId: item.product.id,
        variantId: null,
        qty: quantityFromMilli(2_000n),
      });
      expect(grown.overrideApprovedByUserId).toBeNull();
      expect(grown.overrideApprovedAmount).toBeNull();
      expect(grown.discountOverrideRequired).toBe(true);

      await expect(env.cartStore.assertCartDiscountAuthorized(cart.id)).rejects.toMatchObject({
        code: 'DISCOUNT_OVERRIDE_REQUIRED',
      });
    } finally {
      env.connection.close();
    }
  });

  it('T1.3 test debt: ignores store-specific promotions for another store while applying storeId=null promotions everywhere', async () => {
    const dbPath = createTempDbPath('store-promo.db');
    const env = await setupCartEnv(dbPath);
    try {
      const otherStoreId = parseUuidV7('01950000-0000-7000-8000-999999999999');
      const product = await env.catalogStore.createProduct({
        name: 'Shokolad',
        unit: 'dona',
        salePrice: '100000',
        actorUserId: env.ownerId,
      });

      await env.cartStore.createPromotion({
        storeId: otherStoreId,
        name: 'Other Store Only 30%',
        type: 'percent',
        scope: 'product',
        targetProductId: product.product.id,
        targetCategoryId: null,
        discountPercentBp: 3_000,
        discountAmount: null,
        buyQty: null,
        freeQty: null,
        startsAtMs: unixMsFromBigInt(1_759_000_000_000n),
        endsAtMs: null,
        isActive: true,
      });

      const networkPromo = await env.cartStore.createPromotion({
        storeId: null,
        name: 'Network Wide 5%',
        type: 'percent',
        scope: 'all',
        targetProductId: null,
        targetCategoryId: null,
        discountPercentBp: 500,
        discountAmount: null,
        buyQty: null,
        freeQty: null,
        startsAtMs: unixMsFromBigInt(1_759_000_000_000n),
        endsAtMs: null,
        isActive: true,
      });

      const cart = await env.cartStore.openCart(env.cashierId);
      const detail = await env.cartStore.addLine(cart.id, {
        kind: 'catalog',
        productId: product.product.id,
        variantId: null,
        qty: quantityFromMilli(1_000n),
      });

      expect(detail.totalPromoDiscount).toBe(moneyFromTiyin(5_000n));
      expect(detail.lines[0]?.appliedPromotionId).toBe(networkPromo.id);
      expect(detail.totalFinal).toBe(moneyFromTiyin(95_000n));
    } finally {
      env.connection.close();
    }
  });
});

async function setupCartEnvForExistingDb(dbPath: string) {
  const clock = new FixedClock(1_760_000_050_000n);
  const random = new SeededRandomSource(89);
  const connection = openLocalSqliteDatabase(dbPath);
  const authStore = await createSqliteHubAuthStore({
    connection,
    clock,
    random,
  });
  const active = authStore.getActiveRuntimeContext()!;
  const cartStore = createSqliteCartStore({
    connection,
    getRuntimeContext: () => {
      const ctx = authStore.getActiveRuntimeContext();
      return ctx
        ? {
            uow: ctx.uow,
            organizationId: ctx.config.organizationId,
            storeId: ctx.config.storeId,
          }
        : null;
    },
  });

  const options = await authStore.listLoginOptions();
  const cashier = options.find((u) => u.role === 'cashier')!;
  return {
    connection,
    cartStore,
    organizationId: active.config.organizationId,
    cashierId: cashier.id,
  };
}
