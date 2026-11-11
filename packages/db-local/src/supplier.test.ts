import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  type Money,
  type PaymentMethod,
  type PinHasher,
  type Quantity,
  type SupplierLedgerEntryForFifo,
  type UuidV7,
  ZERO_MONEY,
  allocateSupplierLedgerFifo,
  epochDaysFromCivilDate,
  moneyFromTiyin,
  moneyToTiyin,
  parseUuidV7,
  quantityFromMilli,
  quantityToMilli,
  unixMsFromBigInt,
} from '@mezon/domain';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type LocalSqliteConnection,
  createSqliteCartStore,
  createSqliteCatalogStore,
  createSqliteHubAuthStore,
  createSqliteSaleStore,
  createSqliteStockStore,
  createSqliteSupplierStore,
  formatOutboxRecordForDebug,
  getCashDrawerBalanceSync,
  goodsReceivingLines,
  goodsReceivings,
  listAllOutboxRecordsSync,
  localBatchBalances,
  localDeviceState,
  localStockBalances,
  localSupplierBalances,
  migrateLocalDatabase,
  openLocalSqliteDatabase,
  receivingCostConfirmations,
  rebuildStockProjections,
  stockMoves,
  supplierLedger,
} from './index.js';
import { resolveIntlDateKey } from './timezone.js';

const FAST_TEST_HASHER: PinHasher = {
  hash: (pin) => Promise.resolve(`fast-hash:${pin}`),
  verify: (hash, pin) => Promise.resolve(hash === `fast-hash:${pin}`),
};

const tempDirs: string[] = [];
const openConnections: LocalSqliteConnection[] = [];

function makeTempDbPath(name = 'supplier-test.db'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-t18-sup-'));
  tempDirs.push(dir);
  return path.join(dir, name);
}

function seededNextInt(rng: SeededRandomSource, maxExclusive: number): number {
  const b = rng.nextBytes(2);
  return ((b[0] << 8) | b[1]) % maxExclusive;
}

function makeUuidFromIndex(prefix: number, index: number): UuidV7 {
  return parseUuidV7(
    `0198${prefix.toString(16).padStart(4, '0')}-0000-7000-8000-${index.toString(16).padStart(12, '0')}`,
  );
}

afterEach(() => {
  while (openConnections.length > 0) {
    const conn = openConnections.pop()!;
    try {
      conn.close();
    } catch {
      // ignore already closed handles
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});

// 2026-06-01 10:00:00 Asia/Tashkent = 2026-06-01T05:00:00.000Z
const DAY1_1000_MS = epochDaysFromCivilDate('2026-06-01') * 86_400_000n + 5n * 3_600_000n;

async function setupSupplierEnv(options?: {
  readonly dbPath?: string;
  readonly initialMs?: bigint;
  readonly seed?: number;
}) {
  const dbPath = options?.dbPath ?? makeTempDbPath();
  const clock = new FixedClock(options?.initialMs ?? DAY1_1000_MS);
  const random = new SeededRandomSource(options?.seed ?? 108);
  const connection = openLocalSqliteDatabase(dbPath);
  openConnections.push(connection);
  migrateLocalDatabase(connection.db);

  const authStore = await createSqliteHubAuthStore({ connection, clock, random });
  const setup = await authStore.completeSetup({
    fullName: 'Owner',
    username: 'owner18',
    pinHash: await FAST_TEST_HASHER.hash('849201'),
  });
  const manager = await authStore.createUser({
    fullName: 'Manager',
    username: 'mgr18',
    role: 'manager',
    pinHash: await FAST_TEST_HASHER.hash('592817'),
  });

  const getStoreCtx = () => {
    const ctx = authStore.getActiveRuntimeContext();
    return ctx
      ? { uow: ctx.uow, organizationId: ctx.config.organizationId, storeId: ctx.config.storeId }
      : null;
  };
  const getOrgCtx = () => {
    const ctx = authStore.getActiveRuntimeContext();
    return ctx ? { uow: ctx.uow, organizationId: ctx.config.organizationId } : null;
  };

  const catalogStore = createSqliteCatalogStore({ connection, getRuntimeContext: getOrgCtx });
  const stockStore = createSqliteStockStore({ connection, getRuntimeContext: getStoreCtx });
  const cartStore = createSqliteCartStore({ connection, getRuntimeContext: getStoreCtx });
  const saleStore = createSqliteSaleStore({ connection, getRuntimeContext: getStoreCtx });
  const supplierStore = createSqliteSupplierStore({ connection, getRuntimeContext: getStoreCtx });

  let reqSeq = 1;
  const nextUuid = () => {
    reqSeq += 1;
    return makeUuidFromIndex(0x00bb, reqSeq);
  };

  const seedDrawerCash = async (amountTiyin: bigint) => {
    const seedProd = await catalogStore.createProduct({
      name: `Cash Seed ${reqSeq}`,
      unit: 'dona',
      unlimited: true,
      salePrice: amountTiyin.toString(),
      vatRateBp: 0,
      actorUserId: setup.owner.id,
    });
    const cart = await cartStore.openCart(setup.owner.id);
    await cartStore.addLine(cart.id, {
      kind: 'catalog',
      productId: seedProd.product.id,
      variantId: null,
      qty: quantityFromMilli(1_000n),
    });
    await saleStore.completeSale({
      cartId: cart.id,
      actorUserId: setup.owner.id,
      clientRequestId: nextUuid(),
      expectedTotal: moneyFromTiyin(amountTiyin),
      payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(amountTiyin) }],
    });
  };

  const rebuildAllStock = () => {
    const ctx = getStoreCtx()!;
    return rebuildStockProjections(connection, {
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      nextId: () => makeUuidFromIndex(0x00cc, ++reqSeq),
      nowUnixMs: () => unixMsFromBigInt(clock.now()),
    });
  };

  return {
    dbPath,
    clock,
    random,
    connection,
    authStore,
    catalogStore,
    stockStore,
    cartStore,
    saleStore,
    supplierStore,
    ownerId: setup.owner.id,
    managerId: manager.id,
    organizationId: setup.organizationId,
    storeId: setup.storeId,
    deviceId: setup.deviceId,
    nextUuid,
    seedDrawerCash,
    rebuildAllStock,
  };
}

function assertStockConservationIdentity(
  connection: LocalSqliteConnection,
  valuations: ReadonlyArray<{
    readonly productId: UuidV7;
    readonly totalValue: Money;
    readonly provisionalDeficitValue: Money;
    readonly costVarianceValue: Money;
  }>,
): void {
  const allMoves = connection.db.select().from(stockMoves).all();
  const allConfs = connection.db.select().from(receivingCostConfirmations).all();
  for (const v of valuations) {
    let sumIn = 0n;
    let sumOut = 0n;
    for (const m of allMoves) {
      if (m.productId !== v.productId) continue;
      if (quantityToMilli(m.qtyDelta) > 0n) {
        sumIn += moneyToTiyin(m.costValueDelta);
      } else {
        sumOut += -moneyToTiyin(m.costValueDelta);
      }
    }
    let sumConf = 0n;
    for (const cf of allConfs) {
      if (cf.productId === v.productId) {
        sumConf += moneyToTiyin(cf.confirmedTotalCost);
      }
    }
    expect(sumIn + sumConf).toBe(
      sumOut +
        moneyToTiyin(v.totalValue) -
        moneyToTiyin(v.provisionalDeficitValue) +
        moneyToTiyin(v.costVarianceValue),
    );
    expect(moneyToTiyin(v.totalValue)).toBeGreaterThanOrEqual(0n);
  }
}

describe('@mezon/db-local - T1.8 Suppliers, Receiving, Unknown Cost, Ledger & Returns', () => {
  it('enforces 9-digit TIN & E.164/UZ phone partial UNIQUE + tombstone reuse, FTS5/TIN hybrid search, PII outbox redaction, FACT/ATTR triggers & archive guard', async () => {
    const env = await setupSupplierEnv();
    const piiName = 'YATT Baraka Sardorov';
    const piiTin = '309876543';
    const piiPhone = '90 111-22-33';
    const piiContact = 'Sardor Alimov';
    const piiNote = 'Maxfiy shartnoma sharti 5%';

    const created = await env.supplierStore.createSupplier({
      name: piiName,
      tin: piiTin,
      phone: piiPhone,
      contactPerson: piiContact,
      defaultDueDays: 21,
      note: piiNote,
    });
    expect(created.tin).toBe(piiTin);
    expect(created.phoneNormalized).toBe('+998901112233');
    expect(created.defaultDueDays).toBe(21);
    expect(created.balance).toBe(ZERO_MONEY);

    // Duplicate TIN rejected without echoing raw TIN or name
    try {
      await env.supplierStore.createSupplier({
        name: 'Boshqa Tashkilot',
        tin: piiTin,
      });
      expect.unreachable('Duplicate TIN must reject');
    } catch (err) {
      expect(err).toMatchObject({ code: 'SUPPLIER_TIN_ALREADY_EXISTS' });
      expect((err as Error).message).not.toContain(piiTin);
      expect((err as Error).message).not.toContain(piiName);
    }

    // Duplicate phone rejected without echoing raw phone
    try {
      await env.supplierStore.createSupplier({
        name: 'Yana Boshqa',
        phone: '+998901112233',
      });
      expect.unreachable('Duplicate phone must reject');
    } catch (err) {
      expect(err).toMatchObject({ code: 'SUPPLIER_PHONE_ALREADY_EXISTS' });
      expect((err as Error).message).not.toContain('901112233');
    }

    // Outbox payload keeps sync data, while debug formatter redacts all supplier PII + TIN
    const outbox = listAllOutboxRecordsSync(env.connection.db);
    const supOutbox = outbox.find((r) => r.entity === 'suppliers');
    expect(supOutbox).toBeDefined();
    expect(supOutbox!.payload.tin).toBe(piiTin);
    const debugJson = formatOutboxRecordForDebug(supOutbox!);
    expect(debugJson).not.toContain(piiName);
    expect(debugJson).not.toContain(piiTin);
    expect(debugJson).not.toContain('+998901112233');
    expect(debugJson).not.toContain(piiContact);
    expect(debugJson).not.toContain(piiNote);
    expect(debugJson).toContain('[Redacted]');

    // Hybrid search: Latin, Cyrillic transliteration ('барака'), TIN exact/prefix, phone digits, injection guard
    const byLatin = await env.supplierStore.listSuppliers({ q: 'baraka' });
    expect(byLatin.items.map((s) => s.id)).toEqual([created.id]);

    const byCyr = await env.supplierStore.listSuppliers({ q: 'барака' });
    expect(byCyr.items.map((s) => s.id)).toEqual([created.id]);

    const byTin = await env.supplierStore.listSuppliers({ q: '309876543' });
    expect(byTin.items.map((s) => s.id)).toEqual([created.id]);

    const byPhone = await env.supplierStore.listSuppliers({ q: '9011122' });
    expect(byPhone.items.map((s) => s.id)).toEqual([created.id]);

    const byInj = await env.supplierStore.listSuppliers({ q: '*"baraka" OR 1=1' });
    expect(byInj.items).toEqual([]);

    const byStrippedSyntax = await env.supplierStore.listSuppliers({ q: '*"baraka"*' });
    expect(byStrippedSyntax.items.map((s) => s.id)).toEqual([created.id]);

    const byPureSymbols = await env.supplierStore.listSuppliers({ q: '***()' });
    expect(byPureSymbols.total).toBe(0);

    // Prepayment puts supplier into negative balance (< 0 advance credit)
    await env.seedDrawerCash(500_000n);
    const advPay = await env.supplierStore.recordPayment({
      supplierId: created.id,
      actorUserId: env.ownerId,
      clientRequestId: env.nextUuid(),
      method: 'cash',
      amount: moneyFromTiyin(200_000n),
      reason: 'Oldindan tolov avansi',
    });
    expect(moneyToTiyin(advPay.supplier.balance)).toBe(-200_000n);
    expect(moneyToTiyin(advPay.supplier.advanceBalance)).toBe(200_000n);
    expect(moneyToTiyin(advPay.supplier.debtBalance)).toBe(0n);
    expect(advPay.cashMove?.type).toBe('supplier_payment_out');
    expect(moneyToTiyin(advPay.cashMove!.amountDelta)).toBe(-200_000n);

    // advanceOnly filter works
    const advOnly = await env.supplierStore.listSuppliers({ advanceOnly: true });
    expect(advOnly.items.map((s) => s.id)).toEqual([created.id]);

    // Cannot archive while open advance (< 0) exists
    await expect(env.supplierStore.archiveSupplier(created.id)).rejects.toMatchObject({
      code: 'SUPPLIER_HAS_OPEN_BALANCE',
    });

    // Bring balance to exact 0 via +200_000 adjustment
    await env.supplierStore.recordAdjustment({
      supplierId: created.id,
      actorUserId: env.ownerId,
      clientRequestId: env.nextUuid(),
      amountDelta: moneyFromTiyin(200_000n),
      reason: 'Avans qaytarib yopildi',
    });

    // Triggers: FACT update/delete and ATTR physical delete forbidden
    expect(() =>
      env.connection.sqlite
        .prepare('UPDATE "supplier_ledger" SET "amount_delta" = 0 WHERE "supplier_id" = ?')
        .run(created.id),
    ).toThrowError(/UPDATE is forbidden/);
    expect(() =>
      env.connection.sqlite
        .prepare('DELETE FROM "supplier_ledger" WHERE "supplier_id" = ?')
        .run(created.id),
    ).toThrowError(/forbids physical DELETE/);
    expect(() =>
      env.connection.sqlite.prepare('DELETE FROM "suppliers" WHERE "id" = ?').run(created.id),
    ).toThrowError(/forbids physical DELETE/);

    // Archive succeeds cleanly at balance 0 -> frees TIN & phone for reuse!
    const archived = await env.supplierStore.archiveSupplier(created.id);
    expect(archived.supplierId).toBe(created.id);

    const reused = await env.supplierStore.createSupplier({
      name: 'Yangi Baraka MChJ',
      tin: piiTin,
      phone: '+998901112233',
    });
    expect(reused.tin).toBe(piiTin);
    expect(reused.phoneNormalized).toBe('+998901112233');
  });

  it('draft lifecycle, clientRequestId idempotency & B1 differential proof (postReceiving === recordInboundMove)', async () => {
    const envA = await setupSupplierEnv({ seed: 201 });
    const envB = await setupSupplierEnv({ seed: 202 });

    // Create identical FIFO and weighted-average products in both DBs
    const fifoA = await envA.catalogStore.createProduct({
      name: 'Shakar FIFO',
      unit: 'kg',
      trackBatches: true,
      salePrice: '1500000',
      vatRateBp: 0,
      actorUserId: envA.ownerId,
    });
    const avgA = await envA.catalogStore.createProduct({
      name: 'Guruch Avg',
      unit: 'kg',
      trackBatches: false,
      salePrice: '2000000',
      vatRateBp: 0,
      actorUserId: envA.ownerId,
    });

    const fifoB = await envB.catalogStore.createProduct({
      name: 'Shakar FIFO',
      unit: 'kg',
      trackBatches: true,
      salePrice: '1500000',
      vatRateBp: 0,
      actorUserId: envB.ownerId,
    });
    const avgB = await envB.catalogStore.createProduct({
      name: 'Guruch Avg',
      unit: 'kg',
      trackBatches: false,
      salePrice: '2000000',
      vatRateBp: 0,
      actorUserId: envB.ownerId,
    });

    const sup = await envA.supplierStore.createSupplier({ name: 'Distribyutor' });

    // Cancel draft flow + guard on cancelled/empty draft
    const cancelledDraft = await envA.supplierStore.createReceivingDraft({
      supplierId: sup.id,
      actorUserId: envA.ownerId,
      supplierInvoiceNo: 'INV-CANCEL',
      lines: [
        {
          productId: avgA.product.id,
          qty: quantityFromMilli(2_000n),
          costUnknown: false,
          totalCostValue: moneyFromTiyin(100_000n),
        },
      ],
    });
    const cancelled = await envA.supplierStore.cancelReceivingDraft(cancelledDraft.id);
    expect(cancelled.status).toBe('cancelled');
    await expect(
      envA.supplierStore.updateReceivingDraft(cancelled.id, { note: 'Fail edit' }),
    ).rejects.toMatchObject({ code: 'RECEIVING_NOT_DRAFT' });
    await expect(
      envA.supplierStore.postReceiving(cancelled.id, {
        actorUserId: envA.ownerId,
        clientRequestId: envA.nextUuid(),
      }),
    ).rejects.toMatchObject({ code: 'RECEIVING_NOT_DRAFT' });

    const emptyDraft = await envA.supplierStore.createReceivingDraft({
      supplierId: sup.id,
      actorUserId: envA.ownerId,
    });
    await expect(
      envA.supplierStore.postReceiving(emptyDraft.id, {
        actorUserId: envA.ownerId,
        clientRequestId: envA.nextUuid(),
      }),
    ).rejects.toMatchObject({ code: 'RECEIVING_EMPTY' });

    // Edit draft & post in envA
    const draft = await envA.supplierStore.createReceivingDraft({
      supplierId: sup.id,
      actorUserId: envA.ownerId,
      supplierInvoiceNo: 'INV-001',
      dueDays: 10,
      lines: [
        {
          productId: fifoA.product.id,
          qty: quantityFromMilli(5_500n),
          costUnknown: false,
          totalCostValue: moneyFromTiyin(550_000n),
          batchNumber: 'B-1',
        },
      ],
    });
    const edited = await envA.supplierStore.updateReceivingDraft(draft.id, {
      lines: [
        {
          productId: fifoA.product.id,
          qty: quantityFromMilli(5_500n),
          costUnknown: false,
          totalCostValue: moneyFromTiyin(550_000n),
          batchNumber: 'B-1',
        },
        {
          productId: avgA.product.id,
          qty: quantityFromMilli(12_250n),
          costUnknown: false,
          totalCostValue: moneyFromTiyin(1_225_000n),
        },
      ],
    });
    expect(edited.lines).toHaveLength(2);

    const postReqId = envA.nextUuid();
    const posted = await envA.supplierStore.postReceiving(draft.id, {
      actorUserId: envA.ownerId,
      clientRequestId: postReqId,
    });
    expect(posted.idempotentReplay).toBe(false);
    expect(posted.receiving.receivingNo).toBe(1n);
    expect(moneyToTiyin(posted.receiving.knownCostTotal)).toBe(1_775_000n);
    expect(moneyToTiyin(posted.supplier.balance)).toBe(1_775_000n);

    // Idempotent replay returns exact same doc, sequence unchanged
    const replayed = await envA.supplierStore.postReceiving(draft.id, {
      actorUserId: envA.ownerId,
      clientRequestId: postReqId,
    });
    expect(replayed.idempotentReplay).toBe(true);
    expect(replayed.receiving.id).toBe(posted.receiving.id);
    expect(replayed.receiving.receivingNo).toBe(1n);

    // Different draft with same clientRequestId -> 409 IDEMPOTENCY_CONFLICT
    await expect(
      envA.supplierStore.postReceiving(cancelledDraft.id, {
        actorUserId: envA.ownerId,
        clientRequestId: postReqId,
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    // Equivalent direct stock moves in envB (B1 Differential Oracle)
    await envB.stockStore.recordInboundMove({
      productId: fifoB.product.id,
      reason: 'purchase',
      qty: '5500',
      totalCostValue: '550000',
      batchNumber: 'B-1',
      actorUserId: envB.ownerId,
    });
    await envB.stockStore.recordInboundMove({
      productId: avgB.product.id,
      reason: 'purchase',
      qty: '12250',
      totalCostValue: '1225000',
      actorUserId: envB.ownerId,
    });

    const valsA = [...(await envA.stockStore.listStockValuations())].sort((a, b) =>
      a.productName.localeCompare(b.productName),
    );
    const valsB = [...(await envB.stockStore.listStockValuations())].sort((a, b) =>
      a.productName.localeCompare(b.productName),
    );
    expect(
      valsA.map((v) => ({
        productName: v.productName,
        qtyOnHand: v.qtyOnHand,
        totalValue: v.totalValue,
        deficitQty: v.deficitQty,
        provisionalDeficitValue: v.provisionalDeficitValue,
        costVarianceValue: v.costVarianceValue,
        lastUnitCost: v.lastUnitCost,
      })),
    ).toEqual(
      valsB.map((v) => ({
        productName: v.productName,
        qtyOnHand: v.qtyOnHand,
        totalValue: v.totalValue,
        deficitQty: v.deficitQty,
        provisionalDeficitValue: v.provisionalDeficitValue,
        costVarianceValue: v.costVarianceValue,
        lastUnitCost: v.lastUnitCost,
      })),
    );

    const batchesA = await envA.stockStore.listBatches();
    const batchesB = await envB.stockStore.listBatches();
    expect(
      batchesA.map((b) => ({
        batchNumber: b.batchNumber,
        initialQty: b.initialQty,
        initialCostValue: b.initialCostValue,
        remainingQty: b.remainingQty,
        remainingValue: b.remainingValue,
      })),
    ).toEqual(
      batchesB.map((b) => ({
        batchNumber: b.batchNumber,
        initialQty: b.initialQty,
        initialCostValue: b.initialCostValue,
        remainingQty: b.remainingQty,
        remainingValue: b.remainingValue,
      })),
    );
  });

  it('E1 Oracle A & B: unknown-cost receiving + separate confirmation equals direct purchase (no sales) and satisfies double-entry + rebuild after partial sales (FIFO & Avg)', async () => {
    // Oracle A: Direct purchase vs Unknown -> immediate Confirm (no intermediate sales)
    const directEnv = await setupSupplierEnv({ seed: 301 });
    const confirmEnv = await setupSupplierEnv({ seed: 302 });

    const dFifo = await directEnv.catalogStore.createProduct({
      name: 'Dori FIFO',
      unit: 'dona',
      trackBatches: true,
      salePrice: '100000',
      vatRateBp: 0,
      actorUserId: directEnv.ownerId,
    });
    const dAvg = await directEnv.catalogStore.createProduct({
      name: 'Sovun Avg',
      unit: 'dona',
      trackBatches: false,
      salePrice: '50000',
      vatRateBp: 0,
      actorUserId: directEnv.ownerId,
    });

    const cFifo = await confirmEnv.catalogStore.createProduct({
      name: 'Dori FIFO',
      unit: 'dona',
      trackBatches: true,
      salePrice: '100000',
      vatRateBp: 0,
      actorUserId: confirmEnv.ownerId,
    });
    const cAvg = await confirmEnv.catalogStore.createProduct({
      name: 'Sovun Avg',
      unit: 'dona',
      trackBatches: false,
      salePrice: '50000',
      vatRateBp: 0,
      actorUserId: confirmEnv.ownerId,
    });

    const directSup = await directEnv.supplierStore.createSupplier({ name: 'Direct Co' });
    const confirmSup = await confirmEnv.supplierStore.createSupplier({ name: 'Direct Co' });

    const directDraft = await directEnv.supplierStore.createReceivingDraft({
      supplierId: directSup.id,
      actorUserId: directEnv.ownerId,
      lines: [
        {
          productId: dFifo.product.id,
          qty: quantityFromMilli(10_000n),
          costUnknown: false,
          totalCostValue: moneyFromTiyin(500_000n),
          batchNumber: 'LOT-A',
        },
        {
          productId: dAvg.product.id,
          qty: quantityFromMilli(8_000n),
          costUnknown: false,
          totalCostValue: moneyFromTiyin(240_000n),
        },
      ],
    });
    await directEnv.supplierStore.postReceiving(directDraft.id, {
      actorUserId: directEnv.ownerId,
      clientRequestId: directEnv.nextUuid(),
    });

    const unkDraft = await confirmEnv.supplierStore.createReceivingDraft({
      supplierId: confirmSup.id,
      actorUserId: confirmEnv.ownerId,
      lines: [
        {
          productId: cFifo.product.id,
          qty: quantityFromMilli(10_000n),
          costUnknown: true,
          totalCostValue: null,
          batchNumber: 'LOT-A',
        },
        {
          productId: cAvg.product.id,
          qty: quantityFromMilli(8_000n),
          costUnknown: true,
          totalCostValue: null,
        },
      ],
    });
    const postedUnk = await confirmEnv.supplierStore.postReceiving(unkDraft.id, {
      actorUserId: confirmEnv.ownerId,
      clientRequestId: confirmEnv.nextUuid(),
    });

    // At unknown-cost post time: quantities present at 0 cost, 0 debt, open conflicts present
    expect(moneyToTiyin(postedUnk.supplier.balance)).toBe(0n);
    expect(confirmEnv.connection.db.select().from(supplierLedger).all()).toHaveLength(0);
    expect(
      (await confirmEnv.stockStore.listConflicts()).filter((c) => c.resolvedAtMs === null),
    ).toHaveLength(2);

    // Returning an unconfirmed line to supplier MUST fail
    await expect(
      confirmEnv.supplierStore.createSupplierReturn(postedUnk.receiving.id, {
        actorUserId: confirmEnv.ownerId,
        clientRequestId: confirmEnv.nextUuid(),
        reason: 'Narx belgilanmagan',
        items: [
          { receivingLineId: postedUnk.receiving.lines[0].id, qty: quantityFromMilli(1_000n) },
        ],
      }),
    ).rejects.toMatchObject({ code: 'RECEIVING_LINE_COST_UNKNOWN' });

    // Confirm both lines -> matches direct purchase identically!
    const c1Req = confirmEnv.nextUuid();
    const conf1 = await confirmEnv.supplierStore.confirmReceivingLineCost(
      postedUnk.receiving.id,
      postedUnk.receiving.lines[0].id,
      {
        actorUserId: confirmEnv.ownerId,
        clientRequestId: c1Req,
        confirmedTotalCost: moneyFromTiyin(500_000n),
        reason: 'Hisob-faktura keldi',
      },
    );
    expect(conf1.idempotentReplay).toBe(false);

    // Idempotent replay + second confirm blocked
    const conf1Replay = await confirmEnv.supplierStore.confirmReceivingLineCost(
      postedUnk.receiving.id,
      postedUnk.receiving.lines[0].id,
      {
        actorUserId: confirmEnv.ownerId,
        clientRequestId: c1Req,
        confirmedTotalCost: moneyFromTiyin(500_000n),
        reason: 'Hisob-faktura keldi',
      },
    );
    expect(conf1Replay.idempotentReplay).toBe(true);
    await expect(
      confirmEnv.supplierStore.confirmReceivingLineCost(
        postedUnk.receiving.id,
        postedUnk.receiving.lines[0].id,
        {
          actorUserId: confirmEnv.ownerId,
          clientRequestId: confirmEnv.nextUuid(),
          confirmedTotalCost: moneyFromTiyin(510_000n),
          reason: 'Ikkinchi urinish',
        },
      ),
    ).rejects.toMatchObject({ code: 'RECEIVING_LINE_COST_ALREADY_CONFIRMED' });

    await confirmEnv.supplierStore.confirmReceivingLineCost(
      postedUnk.receiving.id,
      postedUnk.receiving.lines[1].id,
      {
        actorUserId: confirmEnv.ownerId,
        clientRequestId: confirmEnv.nextUuid(),
        confirmedTotalCost: moneyFromTiyin(240_000n),
        reason: 'Sovun narxi keldi',
      },
    );

    // Oracle A assertion: Valuations, batches & supplier balance match 100%, conflicts resolved!
    expect(
      (await confirmEnv.stockStore.listConflicts()).every((c) => c.resolvedAtMs !== null),
    ).toBe(true);
    expect(
      moneyToTiyin(
        (await confirmEnv.supplierStore.getSupplierDetail(confirmSup.id)).supplier.balance,
      ),
    ).toBe(
      moneyToTiyin(
        (await directEnv.supplierStore.getSupplierDetail(directSup.id)).supplier.balance,
      ),
    );
    const valD = [...(await directEnv.stockStore.listStockValuations())].sort((a, b) =>
      a.productName.localeCompare(b.productName),
    );
    const valC = [...(await confirmEnv.stockStore.listStockValuations())].sort((a, b) =>
      a.productName.localeCompare(b.productName),
    );
    expect(
      valC.map((v) => ({
        productName: v.productName,
        qtyOnHand: v.qtyOnHand,
        totalValue: v.totalValue,
        deficitQty: v.deficitQty,
        provisionalDeficitValue: v.provisionalDeficitValue,
        costVarianceValue: v.costVarianceValue,
        lastUnitCost: v.lastUnitCost,
      })),
    ).toEqual(
      valD.map((v) => ({
        productName: v.productName,
        qtyOnHand: v.qtyOnHand,
        totalValue: v.totalValue,
        deficitQty: v.deficitQty,
        provisionalDeficitValue: v.provisionalDeficitValue,
        costVarianceValue: v.costVarianceValue,
        lastUnitCost: v.lastUnitCost,
      })),
    );
    const batchD = await directEnv.stockStore.listBatches();
    const batchC = await confirmEnv.stockStore.listBatches();
    // `local_batch_balances` projections (`remainingQty`, `remainingValue`) match 100%,
    // while immutable `batches` FACT preserves original unknown-cost `initialCostValue = 0n`.
    expect(
      batchC.map((b) => ({
        batchNumber: b.batchNumber,
        initialQty: b.initialQty,
        remainingQty: b.remainingQty,
        remainingValue: b.remainingValue,
      })),
    ).toEqual(
      batchD.map((b) => ({
        batchNumber: b.batchNumber,
        initialQty: b.initialQty,
        remainingQty: b.remainingQty,
        remainingValue: b.remainingValue,
      })),
    );
    expect(batchC[0].initialCostValue).toBe(ZERO_MONEY);
    expect(moneyToTiyin(batchD[0].initialCostValue)).toBe(500_000n);

    // Oracle B: Mixed partial sales BEFORE cost confirmation (both FIFO and Avg)
    const oracleB = await setupSupplierEnv({ seed: 303 });
    const supB = await oracleB.supplierStore.createSupplier({ name: 'Oracle B Co' });
    const prodFifoB = await oracleB.catalogStore.createProduct({
      name: 'FIFO Mid-Sale',
      unit: 'dona',
      trackBatches: true,
      salePrice: '50000',
      vatRateBp: 0,
      actorUserId: oracleB.ownerId,
    });
    const prodAvgB = await oracleB.catalogStore.createProduct({
      name: 'Avg Mid-Sale',
      unit: 'kg',
      trackBatches: false,
      salePrice: '30000',
      vatRateBp: 0,
      actorUserId: oracleB.ownerId,
    });

    // Prior known Avg batch of 2 kg @ 20_000
    await oracleB.stockStore.recordInboundMove({
      productId: prodAvgB.product.id,
      reason: 'initial',
      qty: '2000',
      totalCostValue: '20000',
      actorUserId: oracleB.ownerId,
    });

    // Unknown receiving: 10 FIFO + 8 kg Avg
    const bDraft = await oracleB.supplierStore.createReceivingDraft({
      supplierId: supB.id,
      actorUserId: oracleB.ownerId,
      lines: [
        {
          productId: prodFifoB.product.id,
          qty: quantityFromMilli(10_000n),
          costUnknown: true,
          totalCostValue: null,
          batchNumber: 'B-UNK',
        },
        {
          productId: prodAvgB.product.id,
          qty: quantityFromMilli(8_000n),
          costUnknown: true,
          totalCostValue: null,
        },
      ],
    });
    const bPosted = await oracleB.supplierStore.postReceiving(bDraft.id, {
      actorUserId: oracleB.ownerId,
      clientRequestId: oracleB.nextUuid(),
    });

    // Sell 6 FIFO + 5 kg Avg BEFORE confirming cost!
    const saleCart = await oracleB.cartStore.openCart(oracleB.ownerId);
    await oracleB.cartStore.addLine(saleCart.id, {
      kind: 'catalog',
      productId: prodFifoB.product.id,
      variantId: null,
      qty: quantityFromMilli(6_000n),
    });
    await oracleB.cartStore.addLine(saleCart.id, {
      kind: 'catalog',
      productId: prodAvgB.product.id,
      variantId: null,
      qty: quantityFromMilli(5_000n),
    });
    await oracleB.saleStore.completeSale({
      cartId: saleCart.id,
      actorUserId: oracleB.ownerId,
      clientRequestId: oracleB.nextUuid(),
      expectedTotal: moneyFromTiyin(6n * 50_000n + 5n * 30_000n),
      payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(6n * 50_000n + 5n * 30_000n) }],
    });

    // Confirm FIFO: 100_000 total for 10 units -> Q_rem=4 => totalValue=40_000, costVariance=60_000
    await oracleB.supplierStore.confirmReceivingLineCost(
      bPosted.receiving.id,
      bPosted.receiving.lines[0].id,
      {
        actorUserId: oracleB.ownerId,
        clientRequestId: oracleB.nextUuid(),
        confirmedTotalCost: moneyFromTiyin(100_000n),
        reason: 'FIFO faktura',
      },
    );
    // Confirm Avg: 80_000 total for 8 kg -> Q_onHand = 2 + 8 - 5 = 5, Q_rem = min(5, 8) = 5 -> shareOnHand=50_000, variance=30_000
    await oracleB.supplierStore.confirmReceivingLineCost(
      bPosted.receiving.id,
      bPosted.receiving.lines[1].id,
      {
        actorUserId: oracleB.ownerId,
        clientRequestId: oracleB.nextUuid(),
        confirmedTotalCost: moneyFromTiyin(80_000n),
        reason: 'Avg faktura',
      },
    );

    const liveValsB = await oracleB.stockStore.listStockValuations();
    const fifoLive = liveValsB.find((v) => v.productId === prodFifoB.product.id)!;
    expect(fifoLive.qtyOnHand).toBe(quantityFromMilli(4_000n));
    expect(moneyToTiyin(fifoLive.totalValue)).toBe(40_000n);
    expect(moneyToTiyin(fifoLive.costVarianceValue)).toBe(60_000n);

    // Check conservation identity across all pools in oracleB:
    assertStockConservationIdentity(oracleB.connection, liveValsB);

    // Corrupt local projections & run rebuildStockProjections -> MUST match live state 100%!
    oracleB.connection.db.delete(localStockBalances).run();
    oracleB.connection.db.delete(localBatchBalances).run();
    await oracleB.rebuildAllStock();
    const rebuiltValsB = await oracleB.stockStore.listStockValuations();
    expect(
      [...rebuiltValsB]
        .sort((a, b) => a.productName.localeCompare(b.productName))
        .map((v) => ({
          productId: v.productId,
          qtyOnHand: v.qtyOnHand,
          totalValue: v.totalValue,
          costVarianceValue: v.costVarianceValue,
          provisionalDeficitValue: v.provisionalDeficitValue,
        })),
    ).toEqual(
      [...liveValsB]
        .sort((a, b) => a.productName.localeCompare(b.productName))
        .map((v) => ({
          productId: v.productId,
          qtyOnHand: v.qtyOnHand,
          totalValue: v.totalValue,
          costVarianceValue: v.costVarianceValue,
          provisionalDeficitValue: v.provisionalDeficitValue,
        })),
    );
  });

  it('E2: Return to supplier handles avg pool floor (10@100 return 5@150 -> val=0, var=-50, ledger=-150), FIFO full return === pre-receiving state, partial cumulative rounding & depleted batch guard', async () => {
    const env = await setupSupplierEnv({ seed: 401 });
    const sup = await env.supplierStore.createSupplier({ name: 'E2 Supplier' });

    const avgProd = await env.catalogStore.createProduct({
      name: 'Moy Avg',
      unit: 'dona',
      trackBatches: false,
      salePrice: '50',
      vatRateBp: 0,
      actorUserId: env.ownerId,
    });

    // Build avg pool 10@100 where Rcv#1 is 5@150:
    // Step 1: Receive 5 @ 150 -> pool 5 @ 150
    const d1 = await env.supplierStore.createReceivingDraft({
      supplierId: sup.id,
      actorUserId: env.ownerId,
      lines: [
        {
          productId: avgProd.product.id,
          qty: quantityFromMilli(5_000n),
          costUnknown: false,
          totalCostValue: moneyFromTiyin(150n),
        },
      ],
    });
    const rcv1 = await env.supplierStore.postReceiving(d1.id, {
      actorUserId: env.ownerId,
      clientRequestId: env.nextUuid(),
    });

    // Step 2: Receive 15 @ 50 -> pool 20 @ 200 (avg unit cost = 10/unit)
    const d2 = await env.supplierStore.createReceivingDraft({
      supplierId: sup.id,
      actorUserId: env.ownerId,
      lines: [
        {
          productId: avgProd.product.id,
          qty: quantityFromMilli(15_000n),
          costUnknown: false,
          totalCostValue: moneyFromTiyin(50n),
        },
      ],
    });
    await env.supplierStore.postReceiving(d2.id, {
      actorUserId: env.ownerId,
      clientRequestId: env.nextUuid(),
    });

    // Step 3: Sell 10 @ avg cost 10 -> pool is now EXACT 10 @ 100
    const cart = await env.cartStore.openCart(env.ownerId);
    await env.cartStore.addLine(cart.id, {
      kind: 'catalog',
      productId: avgProd.product.id,
      variantId: null,
      qty: quantityFromMilli(10_000n),
    });
    await env.saleStore.completeSale({
      cartId: cart.id,
      actorUserId: env.ownerId,
      clientRequestId: env.nextUuid(),
      expectedTotal: moneyFromTiyin(500n),
      payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(500n) }],
    });

    const preReturnVal = (await env.stockStore.listStockValuations()).find(
      (v) => v.productId === avgProd.product.id,
    )!;
    expect(preReturnVal.qtyOnHand).toBe(quantityFromMilli(10_000n));
    expect(moneyToTiyin(preReturnVal.totalValue)).toBe(100n);
    const balanceBeforeReturn = moneyToTiyin(
      (await env.supplierStore.getSupplierDetail(sup.id)).supplier.balance,
    );
    expect(balanceBeforeReturn).toBe(200n); // 150 + 50

    // Return Rcv#1 (5 @ 150) -> pool totalValue=0, costVariance=-50, supplier_ledger=-150 (balance=50)!
    const retOutcome = await env.supplierStore.createSupplierReturn(rcv1.receiving.id, {
      actorUserId: env.ownerId,
      clientRequestId: env.nextUuid(),
      reason: 'E2 narx farqi qaytarish',
      items: [
        {
          receivingLineId: rcv1.receiving.lines[0].id,
          qty: quantityFromMilli(5_000n),
        },
      ],
    });
    expect(moneyToTiyin(retOutcome.supplierReturn.totalReturnCost)).toBe(150n);
    expect(moneyToTiyin(retOutcome.supplier.balance)).toBe(50n); // 200 - 150

    const postReturnVal = (await env.stockStore.listStockValuations()).find(
      (v) => v.productId === avgProd.product.id,
    )!;
    expect(postReturnVal.qtyOnHand).toBe(quantityFromMilli(5_000n));
    expect(moneyToTiyin(postReturnVal.totalValue)).toBe(0n);
    expect(moneyToTiyin(postReturnVal.costVarianceValue)).toBe(-50n);

    // Rebuild matches live E2 result
    await env.rebuildAllStock();
    const rebuiltAfterE2 = (await env.stockStore.listStockValuations()).find(
      (v) => v.productId === avgProd.product.id,
    )!;
    expect(moneyToTiyin(rebuiltAfterE2.totalValue)).toBe(0n);
    expect(moneyToTiyin(rebuiltAfterE2.costVarianceValue)).toBe(-50n);

    // FIFO Differential: receiving (3@100 indivisible thirds) -> 3 partial returns sum to exact 100 and restore exact pre-receiving state!
    const fifoProd = await env.catalogStore.createProduct({
      name: 'Choy FIFO',
      unit: 'dona',
      trackBatches: true,
      salePrice: '100',
      vatRateBp: 0,
      actorUserId: env.ownerId,
    });
    const dFifo = await env.supplierStore.createReceivingDraft({
      supplierId: sup.id,
      actorUserId: env.ownerId,
      lines: [
        {
          productId: fifoProd.product.id,
          qty: quantityFromMilli(3_000n),
          costUnknown: false,
          totalCostValue: moneyFromTiyin(100n),
          batchNumber: 'LOT-RET',
        },
      ],
    });
    const rcvFifo = await env.supplierStore.postReceiving(dFifo.id, {
      actorUserId: env.ownerId,
      clientRequestId: env.nextUuid(),
    });
    const r1 = await env.supplierStore.createSupplierReturn(rcvFifo.receiving.id, {
      actorUserId: env.ownerId,
      clientRequestId: env.nextUuid(),
      reason: 'Qism 1',
      items: [{ receivingLineId: rcvFifo.receiving.lines[0].id, qty: quantityFromMilli(1_000n) }],
    });
    const r2 = await env.supplierStore.createSupplierReturn(rcvFifo.receiving.id, {
      actorUserId: env.ownerId,
      clientRequestId: env.nextUuid(),
      reason: 'Qism 2',
      items: [{ receivingLineId: rcvFifo.receiving.lines[0].id, qty: quantityFromMilli(1_000n) }],
    });
    const r3 = await env.supplierStore.createSupplierReturn(rcvFifo.receiving.id, {
      actorUserId: env.ownerId,
      clientRequestId: env.nextUuid(),
      reason: 'Qism 3',
      items: [{ receivingLineId: rcvFifo.receiving.lines[0].id, qty: quantityFromMilli(1_000n) }],
    });
    expect(
      moneyToTiyin(r1.supplierReturn.totalReturnCost) +
        moneyToTiyin(r2.supplierReturn.totalReturnCost) +
        moneyToTiyin(r3.supplierReturn.totalReturnCost),
    ).toBe(100n);
    const fifoFinalVal = (await env.stockStore.listStockValuations()).find(
      (v) => v.productId === fifoProd.product.id,
    )!;
    expect(fifoFinalVal.qtyOnHand).toBe(quantityFromMilli(0n));
    expect(moneyToTiyin(fifoFinalVal.totalValue)).toBe(0n);
    expect(moneyToTiyin(fifoFinalVal.costVarianceValue)).toBe(0n);
    expect(moneyToTiyin(r3.supplier.balance)).toBe(50n); // Back to balanceBeforeFifo!

    // Excess return rejected
    await expect(
      env.supplierStore.createSupplierReturn(rcvFifo.receiving.id, {
        actorUserId: env.ownerId,
        clientRequestId: env.nextUuid(),
        reason: 'Ortiqcha',
        items: [{ receivingLineId: rcvFifo.receiving.lines[0].id, qty: quantityFromMilli(1_000n) }],
      }),
    ).rejects.toMatchObject({ code: 'SUPPLIER_RETURN_QTY_EXCEEDED' });

    // Depleted FIFO batch (sold partially) rejected with SUPPLIER_RETURN_BATCH_DEPLETED
    const dDep = await env.supplierStore.createReceivingDraft({
      supplierId: sup.id,
      actorUserId: env.ownerId,
      lines: [
        {
          productId: fifoProd.product.id,
          qty: quantityFromMilli(4_000n),
          costUnknown: false,
          totalCostValue: moneyFromTiyin(200n),
          batchNumber: 'LOT-SOLD',
        },
      ],
    });
    const rcvDep = await env.supplierStore.postReceiving(dDep.id, {
      actorUserId: env.ownerId,
      clientRequestId: env.nextUuid(),
    });
    const sellCart = await env.cartStore.openCart(env.ownerId);
    await env.cartStore.addLine(sellCart.id, {
      kind: 'catalog',
      productId: fifoProd.product.id,
      variantId: null,
      qty: quantityFromMilli(2_000n),
    });
    await env.saleStore.completeSale({
      cartId: sellCart.id,
      actorUserId: env.ownerId,
      clientRequestId: env.nextUuid(),
      expectedTotal: moneyFromTiyin(200n),
      payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(200n) }],
    });
    await expect(
      env.supplierStore.createSupplierReturn(rcvDep.receiving.id, {
        actorUserId: env.ownerId,
        clientRequestId: env.nextUuid(),
        reason: 'Sotilgan partiyani qaytarish',
        items: [{ receivingLineId: rcvDep.receiving.lines[0].id, qty: quantityFromMilli(3_000n) }],
      }),
    ).rejects.toMatchObject({ code: 'SUPPLIER_RETURN_BATCH_DEPLETED' });
  });

  it('E3: inactive supplier blocks new postReceiving (409 SUPPLIER_INACTIVE, 0 DB writes), while payment, cost confirmation & return succeed', async () => {
    const env = await setupSupplierEnv({ seed: 501 });
    await env.seedDrawerCash(2_000_000n);
    const prod = await env.catalogStore.createProduct({
      name: 'Mahsulot E3',
      unit: 'dona',
      trackBatches: true,
      salePrice: '50000',
      vatRateBp: 0,
      actorUserId: env.ownerId,
    });
    const sup = await env.supplierStore.createSupplier({ name: 'Deactivate Test Co' });

    // Initial receiving with 1 known + 1 unknown line while active
    const d1 = await env.supplierStore.createReceivingDraft({
      supplierId: sup.id,
      actorUserId: env.ownerId,
      lines: [
        {
          productId: prod.product.id,
          qty: quantityFromMilli(5_000n),
          costUnknown: false,
          totalCostValue: moneyFromTiyin(100_000n),
          batchNumber: 'E3-K',
        },
        {
          productId: prod.product.id,
          qty: quantityFromMilli(3_000n),
          costUnknown: true,
          totalCostValue: null,
          batchNumber: 'E3-U',
        },
      ],
    });
    const posted1 = await env.supplierStore.postReceiving(d1.id, {
      actorUserId: env.ownerId,
      clientRequestId: env.nextUuid(),
    });

    // Draft created before deactivation
    const blockedDraft = await env.supplierStore.createReceivingDraft({
      supplierId: sup.id,
      actorUserId: env.ownerId,
      lines: [
        {
          productId: prod.product.id,
          qty: quantityFromMilli(2_000n),
          costUnknown: false,
          totalCostValue: moneyFromTiyin(40_000n),
        },
      ],
    });

    // Deactivate supplier
    await env.supplierStore.updateSupplier(sup.id, { isActive: false });

    const rcvCountBefore = env.connection.db.select().from(goodsReceivings).all().length;
    const movesBefore = env.connection.db.select().from(stockMoves).all().length;
    const ledgerBefore = env.connection.db.select().from(supplierLedger).all().length;
    const seqBefore = env.connection.db.select().from(localDeviceState).all()[0].lastReceivingSeq;

    // 1) New postReceiving rejects SUPPLIER_INACTIVE with 0 DB writes
    await expect(
      env.supplierStore.postReceiving(blockedDraft.id, {
        actorUserId: env.ownerId,
        clientRequestId: env.nextUuid(),
      }),
    ).rejects.toMatchObject({ code: 'SUPPLIER_INACTIVE' });

    expect(env.connection.db.select().from(goodsReceivings).all().length).toBe(rcvCountBefore);
    expect(env.connection.db.select().from(stockMoves).all().length).toBe(movesBefore);
    expect(env.connection.db.select().from(supplierLedger).all().length).toBe(ledgerBefore);
    expect(env.connection.db.select().from(localDeviceState).all()[0].lastReceivingSeq).toBe(
      seqBefore,
    );

    // 2) Payment succeeds on inactive supplier
    const payRes = await env.supplierStore.recordPayment({
      supplierId: sup.id,
      actorUserId: env.ownerId,
      clientRequestId: env.nextUuid(),
      method: 'cash',
      amount: moneyFromTiyin(50_000n),
      reason: 'E3 inactive payment',
    });
    expect(moneyToTiyin(payRes.supplier.balance)).toBe(50_000n);

    // 3) Cost confirmation succeeds on inactive supplier
    const confRes = await env.supplierStore.confirmReceivingLineCost(
      posted1.receiving.id,
      posted1.receiving.lines[1].id,
      {
        actorUserId: env.ownerId,
        clientRequestId: env.nextUuid(),
        confirmedTotalCost: moneyFromTiyin(60_000n),
        reason: 'E3 inactive confirm',
      },
    );
    expect(moneyToTiyin(confRes.supplier.balance)).toBe(110_000n);

    // 4) Return to supplier succeeds on inactive supplier
    const retRes = await env.supplierStore.createSupplierReturn(posted1.receiving.id, {
      actorUserId: env.ownerId,
      clientRequestId: env.nextUuid(),
      reason: 'E3 inactive return',
      items: [
        {
          receivingLineId: posted1.receiving.lines[0].id,
          qty: quantityFromMilli(2_000n),
        },
      ],
    });
    expect(moneyToTiyin(retRes.supplierReturn.totalReturnCost)).toBe(40_000n);
    expect(moneyToTiyin(retRes.supplier.balance)).toBe(70_000n);
  });

  it('bi-directional advance auto-application, overdue FIFO across Asia/Tashkent days, drawer guard & Window Function ledger query', async () => {
    const env = await setupSupplierEnv({ seed: 601 });
    await env.seedDrawerCash(500_000n);
    const sup = await env.supplierStore.createSupplier({
      name: 'Avans Co',
      defaultDueDays: 3,
    });
    const prod = await env.catalogStore.createProduct({
      name: 'Yog',
      unit: 'dona',
      trackBatches: false,
      salePrice: '100000',
      vatRateBp: 0,
      actorUserId: env.ownerId,
    });

    // Reject cash payment exceeding drawer balance (500_000)
    await expect(
      env.supplierStore.recordPayment({
        supplierId: sup.id,
        actorUserId: env.ownerId,
        clientRequestId: env.nextUuid(),
        method: 'cash',
        amount: moneyFromTiyin(500_001n),
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_CASH_IN_DRAWER' });

    // Card payment creates prepayment advance -400_000
    await env.supplierStore.recordPayment({
      supplierId: sup.id,
      actorUserId: env.ownerId,
      clientRequestId: env.nextUuid(),
      method: 'card',
      providerRef: 'CARD-001',
      amount: moneyFromTiyin(400_000n),
    });

    // Receiving of 1_000_000 consumes 400_000 open advance -> remainingDebt = 600_000
    const d1 = await env.supplierStore.createReceivingDraft({
      supplierId: sup.id,
      actorUserId: env.ownerId,
      dueDays: 2,
      lines: [
        {
          productId: prod.product.id,
          qty: quantityFromMilli(10_000n),
          costUnknown: false,
          totalCostValue: moneyFromTiyin(1_000_000n),
        },
      ],
    });
    const rcvRes = await env.supplierStore.postReceiving(d1.id, {
      actorUserId: env.ownerId,
      clientRequestId: env.nextUuid(),
    });
    expect(moneyToTiyin(rcvRes.supplier.balance)).toBe(600_000n);
    expect(moneyToTiyin(rcvRes.supplier.overdueAmount)).toBe(0n);

    // Advance clock +4 days -> receiving obligation becomes 2 days overdue!
    env.clock.advance(4n * 86_400_000n);
    const detailOverdue = await env.supplierStore.getSupplierDetail(sup.id);
    expect(moneyToTiyin(detailOverdue.supplier.overdueAmount)).toBe(600_000n);
    expect(detailOverdue.supplier.oldestOverdueDays).toBe(2);
    expect(detailOverdue.openObligations).toHaveLength(1);
    expect(moneyToTiyin(detailOverdue.openObligations[0].advanceApplied)).toBe(400_000n);
    expect(moneyToTiyin(detailOverdue.openObligations[0].remainingDebt)).toBe(600_000n);

    const overdueList = await env.supplierStore.listOverdueSuppliers();
    expect(overdueList.items.map((s) => s.id)).toEqual([sup.id]);

    // Window function running balanceAfter check (`asc` order)
    const ledger = await env.supplierStore.listSupplierLedger(sup.id, { order: 'asc' });
    expect(
      ledger.items.map((e) => [
        e.entryType,
        moneyToTiyin(e.amountDelta),
        moneyToTiyin(e.balanceAfter),
      ]),
    ).toEqual([
      ['supplier_payment', -400_000n, -400_000n],
      ['receiving_debt', 1_000_000n, 600_000n],
    ]);
  });

  it('E4: >= 240-step deterministic model test across multiple suppliers, known/unknown receivings, confirmations, sales, cash/card advance payments, returns, adjustments & both rebuilds', async () => {
    const env = await setupSupplierEnv({ seed: 202608 });
    await env.seedDrawerCash(2_000_000n);

    // Setup 3 suppliers
    const supIds: UuidV7[] = [];
    for (let i = 0; i < 3; i += 1) {
      const s = await env.supplierStore.createSupplier({
        name: `Model Supplier ${i + 1}`,
        defaultDueDays: i === 0 ? 2 : i === 1 ? 5 : 10,
      });
      supIds.push(s.id);
    }

    // Setup 2 FIFO + 2 Avg products
    const prods = [
      await env.catalogStore.createProduct({
        name: 'Mod FIFO 1',
        unit: 'dona',
        trackBatches: true,
        salePrice: '10000',
        vatRateBp: 0,
        actorUserId: env.ownerId,
      }),
      await env.catalogStore.createProduct({
        name: 'Mod FIFO 2',
        unit: 'kg',
        trackBatches: true,
        salePrice: '20000',
        vatRateBp: 0,
        actorUserId: env.ownerId,
      }),
      await env.catalogStore.createProduct({
        name: 'Mod Avg 1',
        unit: 'dona',
        trackBatches: false,
        salePrice: '15000',
        vatRateBp: 0,
        actorUserId: env.ownerId,
      }),
      await env.catalogStore.createProduct({
        name: 'Mod Avg 2',
        unit: 'kg',
        trackBatches: false,
        salePrice: '25000',
        vatRateBp: 0,
        actorUserId: env.ownerId,
      }),
    ];

    const openingRecorded = new Set<UuidV7>();
    const unconfirmedLines: Array<{
      readonly receivingId: UuidV7;
      readonly lineId: UuidV7;
      readonly supplierId: UuidV7;
    }> = [];
    const returnableLines: Array<{
      readonly receivingId: UuidV7;
      readonly lineId: UuidV7;
      readonly productId: UuidV7;
      readonly trackBatches: boolean;
      remainingQtyMilli: bigint;
    }> = [];

    const modelEntries = new Map<UuidV7, SupplierLedgerEntryForFifo[]>(
      supIds.map((id) => [id, []]),
    );

    const syncModelLedger = (supId: UuidV7) => {
      const rows = env.connection.db
        .select()
        .from(supplierLedger)
        .where(eq(supplierLedger.supplierId, supId))
        .all()
        .sort((a, b) => (a.hlc === b.hlc ? a.id.localeCompare(b.id) : a.hlc < b.hlc ? -1 : 1));
      modelEntries.set(
        supId,
        rows.map((r) => ({
          id: r.id,
          hlc: r.hlc,
          createdAtMs: r.createdAtMs,
          entryType: r.entryType as SupplierLedgerEntryForFifo['entryType'],
          amountDelta: r.amountDelta,
          sourceType: r.sourceType as SupplierLedgerEntryForFifo['sourceType'],
          receivingId: r.receivingId,
          paymentMethod: r.paymentMethod as PaymentMethod | null,
          dueAtMs: r.dueAtMs,
        })),
      );
    };

    const verifyAllSuppliers = async () => {
      const asOfMs = unixMsFromBigInt(env.clock.now());
      for (const supId of supIds) {
        const expected = allocateSupplierLedgerFifo({
          entries: modelEntries.get(supId)!,
          asOfMs,
          storeTimezone: 'Asia/Tashkent',
          resolveTimeZoneDateKey: resolveIntlDateKey,
        });
        const actual = (await env.supplierStore.getSupplierDetail(supId)).supplier;
        expect(moneyToTiyin(actual.balance)).toBe(expected.balanceTiyin);
        expect(actual.debtBalance).toBe(expected.debtBalance);
        expect(actual.advanceBalance).toBe(expected.advanceBalance);
        expect(actual.totalDebtAccrued).toBe(expected.totalDebtAccrued);
        expect(actual.totalCredited).toBe(expected.totalCredited);
        expect(actual.overdueAmount).toBe(expected.overdueAmount);
      }
    };

    const TOTAL_STEPS = 240;
    let cashModelTiyin = 2_000_000n;
    for (let step = 0; step < TOTAL_STEPS; step += 1) {
      const supId = supIds[seededNextInt(env.random, supIds.length)];
      const op = seededNextInt(env.random, 100);

      if (step % 15 === 0) {
        // Advance time by 0..2 days across Asia/Tashkent midnight boundaries
        env.clock.advance(BigInt(seededNextInt(env.random, 3)) * 43_200_000n + 1_000n);
      }

      if (!openingRecorded.has(supId) && op < 8) {
        await env.supplierStore.recordOpeningBalance({
          supplierId: supId,
          actorUserId: env.ownerId,
          clientRequestId: env.nextUuid(),
          amount: moneyFromTiyin(BigInt(10_000 + seededNextInt(env.random, 50_000))),
          reason: `Opening ${step}`,
        });
        openingRecorded.add(supId);
        syncModelLedger(supId);
      } else if (op < 35) {
        // Post receiving (mixed known & unknown lines, integer & fractional units)
        const lineCount = 1 + seededNextInt(env.random, 2);
        const lines: Array<{
          readonly productId: UuidV7;
          readonly qty: Quantity;
          readonly costUnknown: boolean;
          readonly totalCostValue: Money | null;
          readonly batchNumber: string | null;
        }> = [];
        for (let l = 0; l < lineCount; l += 1) {
          const p = prods[seededNextInt(env.random, prods.length)].product;
          const units = 2 + seededNextInt(env.random, 8);
          const qtyMilli =
            p.unit === 'dona'
              ? BigInt(units) * 1_000n
              : BigInt(units) * 1_000n + BigInt(seededNextInt(env.random, 2) * 500);
          const costUnknown = seededNextInt(env.random, 3) === 0;
          lines.push({
            productId: p.id,
            qty: quantityFromMilli(qtyMilli),
            costUnknown,
            totalCostValue: costUnknown
              ? null
              : moneyFromTiyin(BigInt(5_000 + seededNextInt(env.random, 40_000))),
            batchNumber: p.trackBatches ? `LOT-${step}-${l}` : null,
          });
        }
        const draft = await env.supplierStore.createReceivingDraft({
          supplierId: supId,
          actorUserId: env.ownerId,
          lines,
        });
        const posted = await env.supplierStore.postReceiving(draft.id, {
          actorUserId: env.ownerId,
          clientRequestId: env.nextUuid(),
        });
        for (const rl of posted.receiving.lines) {
          const p = prods.find((x) => x.product.id === rl.productId)!.product;
          if (rl.costUnknown) {
            unconfirmedLines.push({
              receivingId: posted.receiving.id,
              lineId: rl.id,
              supplierId: supId,
            });
          } else {
            returnableLines.push({
              receivingId: posted.receiving.id,
              lineId: rl.id,
              productId: rl.productId,
              trackBatches: Boolean(p.trackBatches),
              remainingQtyMilli: quantityToMilli(rl.qty),
            });
          }
        }
        syncModelLedger(supId);
      } else if (op < 52 && unconfirmedLines.length > 0) {
        // Confirm an open unknown-cost line
        const idx = seededNextInt(env.random, unconfirmedLines.length);
        const target = unconfirmedLines.splice(idx, 1)[0];
        const conf = await env.supplierStore.confirmReceivingLineCost(
          target.receivingId,
          target.lineId,
          {
            actorUserId: env.ownerId,
            clientRequestId: env.nextUuid(),
            confirmedTotalCost: moneyFromTiyin(BigInt(8_000 + seededNextInt(env.random, 35_000))),
            reason: `Confirm ${step}`,
          },
        );
        const line = conf.receiving.lines.find((l) => l.id === target.lineId)!;
        const p = prods.find((x) => x.product.id === line.productId)!.product;
        returnableLines.push({
          receivingId: conf.receiving.id,
          lineId: line.id,
          productId: line.productId,
          trackBatches: Boolean(p.trackBatches),
          remainingQtyMilli: quantityToMilli(line.qty),
        });
        syncModelLedger(target.supplierId);
      } else if (op < 72) {
        // Cash or card supplier payment (incl. intentional overpayments into negative advance balance)
        const drawer = moneyToTiyin(
          getCashDrawerBalanceSync(env.connection.db, {
            organizationId: env.organizationId,
            storeId: env.storeId,
            deviceId: env.deviceId,
          }),
        );
        const payAmt = BigInt(3_000 + seededNextInt(env.random, 30_000));
        const method: PaymentMethod = drawer >= payAmt && op % 2 === 0 ? 'cash' : 'card';
        await env.supplierStore.recordPayment({
          supplierId: supId,
          actorUserId: env.ownerId,
          clientRequestId: env.nextUuid(),
          method,
          amount: moneyFromTiyin(payAmt),
          providerRef: method === 'card' ? `CARD-${step}` : null,
          reason: `Payment ${step}`,
        });
        if (method === 'cash') {
          cashModelTiyin -= payAmt;
        }
        syncModelLedger(supId);
      } else if (op < 84) {
        // Complete a small retail sale (tests FIFO/Avg unknown/confirmed consumption & tops up cash drawer!)
        const p = prods[seededNextInt(env.random, prods.length)].product;
        const val = (await env.stockStore.listStockValuations()).find((v) => v.productId === p.id);
        const avail = val ? quantityToMilli(val.qtyOnHand) : 0n;
        if (avail >= 1_000n) {
          const sellQtyMilli = p.unit === 'dona' ? 1_000n : 1_000n;
          const unitPrice = moneyToTiyin(p.salePrice);
          const cart = await env.cartStore.openCart(env.ownerId);
          await env.cartStore.addLine(cart.id, {
            kind: 'catalog',
            productId: p.id,
            variantId: null,
            qty: quantityFromMilli(sellQtyMilli),
          });
          await env.saleStore.completeSale({
            cartId: cart.id,
            actorUserId: env.ownerId,
            clientRequestId: env.nextUuid(),
            expectedTotal: moneyFromTiyin(unitPrice),
            payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(unitPrice) }],
          });
          cashModelTiyin += unitPrice;
        }
      } else if (op < 94 && returnableLines.length > 0) {
        // Return 1 unit if available
        const idx = seededNextInt(env.random, returnableLines.length);
        const target = returnableLines[idx];
        if (target.remainingQtyMilli >= 1_000n) {
          try {
            const ret = await env.supplierStore.createSupplierReturn(target.receivingId, {
              actorUserId: env.ownerId,
              clientRequestId: env.nextUuid(),
              reason: `Return ${step}`,
              items: [{ receivingLineId: target.lineId, qty: quantityFromMilli(1_000n) }],
            });
            target.remainingQtyMilli -= 1_000n;
            if (target.remainingQtyMilli === 0n) {
              returnableLines.splice(idx, 1);
            }
            syncModelLedger(ret.supplier.id);
          } catch (err) {
            const code = (err as { code?: string }).code;
            if (code !== 'SUPPLIER_RETURN_BATCH_DEPLETED' && code !== 'INSUFFICIENT_STOCK') {
              throw err;
            }
            returnableLines.splice(idx, 1);
          }
        }
      } else {
        // Signed +/- adjustment
        const sign = op % 2 === 0 ? 1n : -1n;
        await env.supplierStore.recordAdjustment({
          supplierId: supId,
          actorUserId: env.ownerId,
          clientRequestId: env.nextUuid(),
          amountDelta: moneyFromTiyin(sign * BigInt(1_000 + seededNextInt(env.random, 10_000))),
          reason: `Adjustment ${step}`,
          dueDays: sign > 0n ? 3 : null,
        });
        syncModelLedger(supId);
      }

      // Verify EVERY step (supplier balance, advance, overdue, cash drawer, stock identity)
      await verifyAllSuppliers();
      expect(
        moneyToTiyin(
          getCashDrawerBalanceSync(env.connection.db, {
            organizationId: env.organizationId,
            storeId: env.storeId,
            deviceId: env.deviceId,
          }),
        ),
      ).toBe(cashModelTiyin);
      assertStockConservationIdentity(env.connection, await env.stockStore.listStockValuations());
    }

    // Snapshot live state BEFORE corrupting projections
    const liveSupSnapshots = new Map<UuidV7, bigint>();
    for (const supId of supIds) {
      liveSupSnapshots.set(
        supId,
        moneyToTiyin((await env.supplierStore.getSupplierDetail(supId)).supplier.balance),
      );
    }
    const liveStockBefore = (await env.stockStore.listStockValuations())
      .map((v) => ({
        productId: v.productId,
        qtyOnHand: v.qtyOnHand,
        totalValue: v.totalValue,
        deficitQty: v.deficitQty,
        provisionalDeficitValue: v.provisionalDeficitValue,
        costVarianceValue: v.costVarianceValue,
      }))
      .sort((a, b) => a.productId.localeCompare(b.productId));

    // Corrupt ALL projection tables and run both full rebuilds
    env.connection.db.delete(localSupplierBalances).run();
    env.connection.db.delete(localStockBalances).run();
    env.connection.db.delete(localBatchBalances).run();

    const supRebuild = await env.supplierStore.rebuildSupplierBalances();
    expect(supRebuild.suppliersProcessed).toBe(3);
    expect(supRebuild.balancesUpdated).toBe(3);

    await env.rebuildAllStock();

    // Rebuilt supplier balance projections match model & live snapshots
    const balRows = env.connection.db.select().from(localSupplierBalances).all();
    for (const row of balRows) {
      expect(moneyToTiyin(row.balance)).toBe(liveSupSnapshots.get(row.supplierId));
    }

    // Rebuilt stock projections match live state 100% AND conservation identity holds on all products!
    const stockAfterRebuild = (await env.stockStore.listStockValuations())
      .map((v) => ({
        productId: v.productId,
        qtyOnHand: v.qtyOnHand,
        totalValue: v.totalValue,
        deficitQty: v.deficitQty,
        provisionalDeficitValue: v.provisionalDeficitValue,
        costVarianceValue: v.costVarianceValue,
      }))
      .sort((a, b) => a.productId.localeCompare(b.productId));
    expect(stockAfterRebuild).toEqual(liveStockBefore);
    assertStockConservationIdentity(env.connection, stockAfterRebuild);
  });

  it('meets <= 500 ms performance target for posting a 100-line receiving on file-backed WAL SQLite', async () => {
    const env = await setupSupplierEnv({ seed: 777 });
    const sup = await env.supplierStore.createSupplier({ name: 'Perf 100-Line Wholesale' });

    const productIds: UuidV7[] = [];
    for (let i = 0; i < 100; i += 1) {
      const p = await env.catalogStore.createProduct({
        name: `Perf Tovar ${i + 1}`,
        unit: i % 3 === 0 ? 'kg' : 'dona',
        trackBatches: i % 2 === 0,
        salePrice: '25000',
        vatRateBp: 1200,
        actorUserId: env.ownerId,
      });
      productIds.push(p.product.id);
    }

    const draft = await env.supplierStore.createReceivingDraft({
      supplierId: sup.id,
      actorUserId: env.ownerId,
      supplierInvoiceNo: 'PERF-100',
      lines: productIds.map((pid, idx) => ({
        productId: pid,
        qty: quantityFromMilli(idx % 3 === 0 ? 5_500n : 10_000n),
        costUnknown: idx % 10 === 0,
        totalCostValue: idx % 10 === 0 ? null : moneyFromTiyin(BigInt(50_000 + idx * 100)),
        batchNumber: idx % 2 === 0 ? `B-${idx}` : null,
      })),
    });

    const reqId = env.nextUuid();
    const startMs = performance.now();
    const posted = await env.supplierStore.postReceiving(draft.id, {
      actorUserId: env.ownerId,
      clientRequestId: reqId,
    });
    const elapsedMs = performance.now() - startMs;

    console.info(`[PERF T1.8 100-line receiving]: ${elapsedMs.toFixed(2)} ms`);
    expect(posted.receiving.lines).toHaveLength(100);
    expect(env.connection.db.select().from(goodsReceivingLines).all()).toHaveLength(100);
    expect(elapsedMs).toBeLessThanOrEqual(500);
  });
});
