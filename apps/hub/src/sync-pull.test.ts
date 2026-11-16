import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type LocalSqliteConnection,
  SqliteCloudStore,
  ensureDeviceStateRowSync,
  migrateLocalDatabase,
  openLocalSqliteDatabase,
  shifts,
  sales,
  users,
  executeStockProjectionsRebuildSync,
  executeCustomerBalancesRebuildSync,
  executeSupplierBalancesRebuildSync,
} from '@mezon/db-local';
import {
  type Clock,
  type IdGenerator,
  MonotonicUuidV7Generator,
  parseUuidV7,
  unixMsFromBigInt,
  moneyFromTiyin,
} from '@mezon/domain';
import {
  type SyncedEventDto,
  CURRENT_SCHEMA_VERSION,
  MONOTONE_TRANSITION_RULES,
} from '@mezon/sync';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SafeStoragePort } from './safe-storage-port.js';
import { createHubServer } from './server.js';
import { HubSyncPullService, classifySyncError, PermanentSyncError } from './sync-pull-service.js';

class MockSafeStorage implements SafeStoragePort {
  isAvailable(): boolean {
    return true;
  }
  encryptString(plainText: string): Promise<Buffer> {
    return Promise.resolve(Buffer.from(`enc_${plainText}`, 'utf8'));
  }
  decryptString(cipherText: Buffer): Promise<string> {
    const raw = cipherText.toString('utf8');
    if (!raw.startsWith('enc_')) {
      return Promise.reject(new Error('Invalid ciphertext'));
    }
    return Promise.resolve(raw.slice(4));
  }
}

describe('HubSyncPullService & HubSyncPullWorker (T2.4)', () => {
  let tmpDir: string;
  let dbPath: string;
  let conn: LocalSqliteConnection;
  let pullService: HubSyncPullService;
  let cloudStore: SqliteCloudStore;
  let safeStorage: MockSafeStorage;
  let idGen: IdGenerator;

  const currentNowMs = 1700000000000n;
  const clock: Clock = {
    now: () => unixMsFromBigInt(currentNowMs),
  };

  const orgId = parseUuidV7('01880000-0000-7000-8000-000000000001');
  const storeId = parseUuidV7('01880000-0000-7000-8000-000000000002');
  const deviceId = parseUuidV7('01880000-0000-7000-8000-000000000003');
  const cashierId = parseUuidV7('01880000-0000-7000-8000-000000000004');

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-sync-pull-test-'));
    dbPath = path.join(tmpDir, 'hub.db');
    conn = openLocalSqliteDatabase(dbPath);
    migrateLocalDatabase(conn.db);

    idGen = new MonotonicUuidV7Generator({
      clock,
      random: { nextBytes: (n: number) => new Uint8Array(n).fill(1) },
    });

    ensureDeviceStateRowSync(conn.sqlite, conn.db, {
      rowId: idGen.nextId(),
      organizationId: orgId,
      deviceId,
      initialHlcStr: '000170000000000:00000:01880000-0000-7000-8000-000000000001',
      initialUuidMs: currentNowMs,
      nowMs: currentNowMs,
    });

    // Seed cashier into local users
    conn.db
      .insert(users)
      .values({
        id: cashierId,
        organizationId: orgId,
        deviceId,
        username: 'cashier_1',
        fullName: 'Cashier One',
        role: 'cashier',
        isActive: true,
        hlc: '000170000000000:00000:01880000-0000-7000-8000-000000000001',
        createdAtMs: unixMsFromBigInt(currentNowMs),
        updatedAtMs: unixMsFromBigInt(currentNowMs),
      })
      .run();

    pullService = new HubSyncPullService(conn);
    cloudStore = new SqliteCloudStore(conn);
    safeStorage = new MockSafeStorage();

    // Seed paired cloud state
    const encToken = (await safeStorage.encryptString('valid-secret-token')).toString('base64');
    await cloudStore.saveCloudState({
      status: 'paired',
      cloudUrl: 'https://cloud.mezon.uz',
      organizationId: orgId,
      organizationName: 'Guzar Test Org',
      storeId,
      storeName: 'Main Store',
      encryptedDeviceToken: encToken,
      pairedAtMs: unixMsFromBigInt(currentNowMs),
      nowMs: unixMsFromBigInt(currentNowMs),
      idGen,
    });
  });

  afterEach(() => {
    try {
      conn.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('T1: local trigger blocks sale into closed shift when in_sync = 0, but allows it when in_sync = 1 and records conflict', () => {
    const shiftId = idGen.nextId();
    const saleId = idGen.nextId();

    // 1. Seed closed shift in local DB
    const shiftValues: typeof shifts.$inferInsert = {
      id: shiftId,
      organizationId: orgId,
      storeId,
      deviceId,
      shiftNo: 1n,
      shiftCode: 'SHIFT-001',
      status: 'closed',
      openedByUserId: cashierId,
      closedByUserId: cashierId,
      openingCash: moneyFromTiyin(0n),
      openingDiscrepancy: moneyFromTiyin(0n),
      openClientRequestId: idGen.nextId(),
      openRequestHash: 'hash123456',
      closeClientRequestId: idGen.nextId(),
      closeRequestHash: 'hash123456',
      openedAtMs: unixMsFromBigInt(currentNowMs - 3600000n),
      closedAtMs: unixMsFromBigInt(currentNowMs - 1800000n),
      hlc: '000170000000000:00000:01880000-0000-7000-8000-000000000001',
      createdAtMs: unixMsFromBigInt(currentNowMs - 3600000n),
      updatedAtMs: unixMsFromBigInt(currentNowMs - 1800000n),
    };
    conn.db.insert(shifts).values(shiftValues).run();

    // 2. Direct local INSERT when in_sync = 0 must fail via trg_sales_closed_shift_guard
    expect(() => {
      const saleValues: typeof sales.$inferInsert = {
        id: saleId,
        organizationId: orgId,
        storeId,
        deviceId,
        shiftId,
        receiptNo: 1n,
        receiptCode: 'R-001',
        cashierUserId: cashierId,
        completedByUserId: cashierId,
        clientRequestId: idGen.nextId(),
        requestHash: 'hash123456',
        subtotalGross: moneyFromTiyin(10000n),
        totalPromoDiscount: moneyFromTiyin(0n),
        subtotalAfterPromo: moneyFromTiyin(10000n),
        manualDiscountMode: 'none',
        manualDiscountValue: moneyFromTiyin(0n),
        orderDiscountAmount: moneyFromTiyin(0n),
        totalFinal: moneyFromTiyin(10000n),
        totalNetExVat: moneyFromTiyin(8800n),
        totalVat: moneyFromTiyin(1200n),
        totalPaid: moneyFromTiyin(10000n),
        debtAmount: moneyFromTiyin(0n),
        changeAmount: moneyFromTiyin(0n),
        hlc: '000170000000000:00001:01880000-0000-7000-8000-000000000001',
        createdAtMs: unixMsFromBigInt(currentNowMs),
        updatedAtMs: unixMsFromBigInt(currentNowMs),
      };
      conn.db.insert(sales).values(saleValues).run();
    }).toThrow(/closed shift/i);

    // 3. Sync apply with the same closed shift MUST succeed and record conflict
    const event: SyncedEventDto = {
      eventId: idGen.nextId(),
      organizationId: orgId,
      storeId,
      deviceId,
      deviceSeq: '1',
      hlc: '000170000000000:00001:01880000-0000-7000-8000-000000000001',
      type: 'sale.completed',
      entity: 'sales',
      entityId: saleId,
      entityClass: 'MONOTONE',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      payload: {
        id: saleId,
        organizationId: orgId,
        storeId,
        deviceId,
        shiftId,
        receiptNo: '1',
        receiptCode: 'R-001',
        cashierUserId: cashierId,
        completedByUserId: cashierId,
        clientRequestId: idGen.nextId(),
        requestHash: 'hash123456',
        subtotalGross: '10000',
        totalPromoDiscount: '0',
        subtotalAfterPromo: '10000',
        manualDiscountMode: 'none',
        manualDiscountValue: '0',
        orderDiscountAmount: '0',
        totalFinal: '10000',
        totalNetExVat: '8800',
        totalVat: '1200',
        totalPaid: '10000',
        debtAmount: '0',
        changeAmount: '0',
        hlc: '000170000000000:00001:01880000-0000-7000-8000-000000000001',
        createdAtMs: Number(currentNowMs),
        updatedAtMs: Number(currentNowMs),
      },
      position: '1',
      hlcAdjusted: false,
      receivedAtMs: unixMsFromBigInt(currentNowMs),
    };

    const res = pullService.applySyncPullBatch({
      context: { organizationId: orgId, storeId, deviceId },
      events: [event],
      nextCursors: { [storeId]: 1n },
      nowMs: unixMsFromBigInt(currentNowMs),
    });

    expect(res.appliedCount).toBe(1);

    // Sale row exists in SQLite
    const insertedSale = conn.sqlite
      .prepare('SELECT id, shift_id FROM sales WHERE id = ?')
      .get(saleId) as { id: string; shift_id: string } | undefined;
    expect(insertedSale).toBeDefined();
    expect(insertedSale?.shift_id).toBe(shiftId);

    // Conflict was recorded
    const conflict = conn.sqlite
      .prepare('SELECT reason FROM local_sync_conflicts WHERE event_id = ?')
      .get(event.eventId) as { reason: string } | undefined;
    expect(conflict).toBeDefined();
    expect(conflict?.reason).toBe('STALE_SHIFT_SYNC_INSERT');

    // In_sync is reset to 0 after transaction
    expect(pullService.getApplyState().inSync).toBe(0);
  });

  it('T2: echo suppression checks local_outbox; restores re-apply missing events', () => {
    const catId = idGen.nextId();
    const eventId = idGen.nextId();

    const event: SyncedEventDto = {
      eventId,
      organizationId: orgId,
      storeId,
      deviceId,
      deviceSeq: '1',
      hlc: '000170000000000:00005:01880000-0000-7000-8000-000000000001',
      type: 'category.created',
      entity: 'categories',
      entityId: catId,
      entityClass: 'ATTR',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      payload: {
        id: catId,
        organizationId: orgId,
        deviceId,
        hlc: '000170000000000:00005:01880000-0000-7000-8000-000000000001',
        createdAtMs: Number(currentNowMs),
        updatedAtMs: Number(currentNowMs),
        name: 'Echo Category',
        nameSearch: 'echo category',
        sortOrder: 1,
      },
      position: '1',
      hlcAdjusted: false,
      receivedAtMs: unixMsFromBigInt(currentNowMs),
    };

    // Case A: event IS in local_outbox (id = eventId) -> skipped as echo
    conn.sqlite
      .prepare(
        `
      INSERT INTO local_outbox (id, organization_id, store_id, device_id, device_seq, hlc, type, entity, entity_id, class, schema_version, payload, status, attempts, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, 1, ?, 'category.created', 'categories', ?, 'ATTR', 1, '{}', 'acked', 1, ?, ?)
    `,
      )
      .run(
        eventId,
        orgId,
        storeId,
        deviceId,
        event.hlc,
        catId,
        Number(currentNowMs),
        Number(currentNowMs),
      );

    const resA = pullService.applySyncPullBatch({
      context: { organizationId: orgId, storeId, deviceId },
      events: [event],
      nextCursors: { [storeId]: 1n },
      nowMs: unixMsFromBigInt(currentNowMs),
    });
    expect(resA.skippedEchoCount).toBe(1);
    expect(resA.appliedCount).toBe(0);

    // Case B: Database restored to pre-sale backup (outbox deleted) -> event IS applied!
    conn.sqlite.prepare('DELETE FROM local_outbox WHERE id = ?').run(eventId);

    const resB = pullService.applySyncPullBatch({
      context: { organizationId: orgId, storeId, deviceId },
      events: [event],
      nextCursors: { [storeId]: 1n },
      nowMs: unixMsFromBigInt(currentNowMs),
    });
    expect(resB.appliedCount).toBe(1);
    expect(resB.skippedEchoCount).toBe(0);

    const categoryRow = conn.sqlite
      .prepare('SELECT id, name FROM categories WHERE id = ?')
      .get(catId) as { id: string; name: string } | undefined;
    expect(categoryRow).toBeDefined();
    expect(categoryRow?.name).toBe('Echo Category');
  });

  it('T2 Clamp: clamped hlc_adjusted event updates local row HLC', () => {
    const catId = idGen.nextId();
    const eventId = idGen.nextId();
    const futureHlc = '000180000000000:00000:01880000-0000-7000-8000-000000000001';
    const serverClampedHlc = '000170000000000:00000:01880000-0000-7000-8000-000000000001';

    // Insert category locally with future HLC
    conn.sqlite
      .prepare(
        `
      INSERT INTO categories (id, organization_id, device_id, hlc, name, name_search, sort_order, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, 'Clamped Cat', 'clamped cat', 1, ?, ?)
    `,
      )
      .run(catId, orgId, deviceId, futureHlc, Number(currentNowMs), Number(currentNowMs));

    // Seed outbox so echo suppression fires
    conn.sqlite
      .prepare(
        `
      INSERT INTO local_outbox (id, organization_id, store_id, device_id, device_seq, hlc, type, entity, entity_id, class, schema_version, payload, status, attempts, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, 1, ?, 'category.created', 'categories', ?, 'ATTR', 1, '{}', 'acked', 1, ?, ?)
    `,
      )
      .run(
        eventId,
        orgId,
        storeId,
        deviceId,
        futureHlc,
        catId,
        Number(currentNowMs),
        Number(currentNowMs),
      );

    const echoEventWithClamp: SyncedEventDto = {
      eventId,
      organizationId: orgId,
      storeId,
      deviceId,
      deviceSeq: '1',
      hlc: serverClampedHlc,
      type: 'category.created',
      entity: 'categories',
      entityId: catId,
      entityClass: 'ATTR',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      payload: {
        id: catId,
        organizationId: orgId,
        deviceId,
        hlc: serverClampedHlc,
        createdAtMs: Number(currentNowMs),
        updatedAtMs: Number(currentNowMs),
        name: 'Clamped Cat',
        nameSearch: 'clamped cat',
        sortOrder: 1,
      },
      position: '1',
      hlcAdjusted: true,
      receivedAtMs: unixMsFromBigInt(currentNowMs),
    };

    const res = pullService.applySyncPullBatch({
      context: { organizationId: orgId, storeId, deviceId },
      events: [echoEventWithClamp],
      nextCursors: { [storeId]: 1n },
      nowMs: unixMsFromBigInt(currentNowMs),
    });

    expect(res.skippedEchoCount).toBe(1);

    // Verify local row HLC was clamped
    const updatedCat = conn.sqlite
      .prepare('SELECT hlc FROM categories WHERE id = ?')
      .get(catId) as { hlc: string };
    expect(updatedCat.hlc).toBe(serverClampedHlc);
  });

  it('T3: per-event SAVEPOINT isolates toxic event; valid events apply and cursors advance', () => {
    const validCatId1 = idGen.nextId();
    const toxicCatId = idGen.nextId();
    const validCatId2 = idGen.nextId();

    const validEvent1: SyncedEventDto = {
      eventId: idGen.nextId(),
      organizationId: orgId,
      storeId,
      deviceId,
      deviceSeq: '10',
      hlc: '000170000000000:00010:01880000-0000-7000-8000-000000000001',
      type: 'category.created',
      entity: 'categories',
      entityId: validCatId1,
      entityClass: 'ATTR',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      payload: {
        id: validCatId1,
        organizationId: orgId,
        deviceId,
        hlc: '000170000000000:00010:01880000-0000-7000-8000-000000000001',
        createdAtMs: Number(currentNowMs),
        updatedAtMs: Number(currentNowMs),
        name: 'Valid Cat 1',
        nameSearch: 'valid cat 1',
        sortOrder: 1,
      },
      position: '10',
      hlcAdjusted: false,
      receivedAtMs: unixMsFromBigInt(currentNowMs),
    };

    // Toxic event: schemaVersion is 99 (unsupported)
    const toxicEvent: SyncedEventDto = {
      eventId: idGen.nextId(),
      organizationId: orgId,
      storeId,
      deviceId,
      deviceSeq: '11',
      hlc: '000170000000000:00011:01880000-0000-7000-8000-000000000001',
      type: 'category.created',
      entity: 'categories',
      entityId: toxicCatId,
      entityClass: 'ATTR',
      schemaVersion: 99,
      payload: {
        id: toxicCatId,
        organizationId: orgId,
        deviceId,
        hlc: '000170000000000:00011:01880000-0000-7000-8000-000000000001',
        createdAtMs: Number(currentNowMs),
        updatedAtMs: Number(currentNowMs),
        name: 'Toxic Cat',
        nameSearch: 'toxic cat',
        sortOrder: 2,
      },
      position: '11',
      hlcAdjusted: false,
      receivedAtMs: unixMsFromBigInt(currentNowMs),
    };

    const validEvent2: SyncedEventDto = {
      eventId: idGen.nextId(),
      organizationId: orgId,
      storeId,
      deviceId,
      deviceSeq: '12',
      hlc: '000170000000000:00012:01880000-0000-7000-8000-000000000001',
      type: 'category.created',
      entity: 'categories',
      entityId: validCatId2,
      entityClass: 'ATTR',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      payload: {
        id: validCatId2,
        organizationId: orgId,
        deviceId,
        hlc: '000170000000000:00012:01880000-0000-7000-8000-000000000001',
        createdAtMs: Number(currentNowMs),
        updatedAtMs: Number(currentNowMs),
        name: 'Valid Cat 2',
        nameSearch: 'valid cat 2',
        sortOrder: 3,
      },
      position: '12',
      hlcAdjusted: false,
      receivedAtMs: unixMsFromBigInt(currentNowMs),
    };

    const res = pullService.applySyncPullBatch({
      context: { organizationId: orgId, storeId, deviceId },
      events: [validEvent1, toxicEvent, validEvent2],
      nextCursors: { [storeId]: 12n },
      nowMs: unixMsFromBigInt(currentNowMs),
    });

    expect(res.appliedCount).toBe(2);
    expect(res.conflictCount).toBe(1);

    // Both valid categories were persisted
    expect(
      conn.sqlite.prepare('SELECT id FROM categories WHERE id = ?').get(validCatId1),
    ).toBeDefined();
    expect(
      conn.sqlite.prepare('SELECT id FROM categories WHERE id = ?').get(validCatId2),
    ).toBeDefined();
    // Toxic category was not persisted
    expect(
      conn.sqlite.prepare('SELECT id FROM categories WHERE id = ?').get(toxicCatId),
    ).toBeUndefined();

    // Conflict was recorded for toxic event
    const conflict = conn.sqlite
      .prepare('SELECT reason FROM local_sync_conflicts WHERE event_id = ?')
      .get(toxicEvent.eventId) as { reason: string };
    expect(conflict.reason).toBe('SCHEMA_VERSION_UNSUPPORTED');

    // Cursor advanced to 12
    const cursor = pullService.getCursors(orgId);
    expect(cursor[storeId]).toBe(12n);
  });

  it('T3: parks event with missing foreign key and re-applies when dependency arrives', () => {
    const missingCatId = idGen.nextId();
    const prodId = idGen.nextId();
    const prodEventId = idGen.nextId();

    const prodEvent: SyncedEventDto = {
      eventId: prodEventId,
      organizationId: orgId,
      storeId,
      deviceId,
      deviceSeq: '20',
      hlc: '000170000000000:00020:01880000-0000-7000-8000-000000000001',
      type: 'product.created',
      entity: 'products',
      entityId: prodId,
      entityClass: 'ATTR',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      payload: {
        id: prodId,
        organizationId: orgId,
        deviceId,
        hlc: '000170000000000:00020:01880000-0000-7000-8000-000000000001',
        createdAtMs: Number(currentNowMs),
        updatedAtMs: Number(currentNowMs),
        categoryId: missingCatId, // Not in DB yet!
        sku: 'SKU-001',
        skuSearch: 'sku-001',
        name: 'Dependent Product',
        nameSearch: 'dependent product',
        unit: 'dona',
        unlimited: false,
        hasVariants: false,
        trackBatches: false,
        salePrice: '25000',
        vatRateBp: 1200,
      },
      position: '20',
      hlcAdjusted: false,
      receivedAtMs: unixMsFromBigInt(currentNowMs),
    };

    // Apply batch: product missing category must be parked
    const res1 = pullService.applySyncPullBatch({
      context: { organizationId: orgId, storeId, deviceId },
      events: [prodEvent],
      nextCursors: { [storeId]: 20n },
      nowMs: unixMsFromBigInt(currentNowMs),
    });

    expect(res1.parkedCount).toBe(1);
    expect(res1.appliedCount).toBe(0);

    const parked = conn.sqlite
      .prepare(
        'SELECT missing_ref_entity, missing_ref_id FROM local_sync_parked WHERE event_id = ?',
      )
      .get(prodEventId) as { missing_ref_entity: string; missing_ref_id: string };
    expect(parked).toBeDefined();
    expect(parked.missing_ref_entity).toBe('categories');
    expect(parked.missing_ref_id).toBe(missingCatId);

    // Now category arrives on next pull
    const catEvent: SyncedEventDto = {
      eventId: idGen.nextId(),
      organizationId: orgId,
      storeId,
      deviceId,
      deviceSeq: '21',
      hlc: '000170000000000:00021:01880000-0000-7000-8000-000000000001',
      type: 'category.created',
      entity: 'categories',
      entityId: missingCatId,
      entityClass: 'ATTR',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      payload: {
        id: missingCatId,
        organizationId: orgId,
        deviceId,
        hlc: '000170000000000:00021:01880000-0000-7000-8000-000000000001',
        createdAtMs: Number(currentNowMs),
        updatedAtMs: Number(currentNowMs),
        name: 'Parent Category',
        nameSearch: 'parent category',
        sortOrder: 1,
      },
      position: '21',
      hlcAdjusted: false,
      receivedAtMs: unixMsFromBigInt(currentNowMs),
    };

    const res2 = pullService.applySyncPullBatch({
      context: { organizationId: orgId, storeId, deviceId },
      events: [catEvent],
      nextCursors: { [storeId]: 21n },
      nowMs: unixMsFromBigInt(currentNowMs),
    });

    expect(res2.appliedCount).toBe(1);

    // Parked event was resolved and removed from local_sync_parked
    const parkedAfter = conn.sqlite
      .prepare('SELECT id FROM local_sync_parked WHERE event_id = ?')
      .get(prodEventId);
    expect(parkedAfter).toBeUndefined();

    // And product is now in local DB!
    const productInDb = conn.sqlite
      .prepare('SELECT id, category_id FROM products WHERE id = ?')
      .get(prodId) as { id: string; category_id: string };
    expect(productInDb).toBeDefined();
    expect(productInDb.category_id).toBe(missingCatId);
  });

  it('T4: customer_ledger events update customer balance projections', () => {
    const custId = idGen.nextId();
    const ledgerId = idGen.nextId();

    // Seed customer
    conn.sqlite
      .prepare(
        `
      INSERT INTO customers (id, organization_id, device_id, hlc, full_name, name_search, is_active, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, '000170000000000:00000:01880000-0000-7000-8000-000000000001', 'Test Customer', 'test customer', 1, ?, ?)
    `,
      )
      .run(custId, orgId, deviceId, Number(currentNowMs), Number(currentNowMs));

    const ledgerEvent: SyncedEventDto = {
      eventId: idGen.nextId(),
      organizationId: orgId,
      storeId,
      deviceId,
      deviceSeq: '30',
      hlc: '000170000000000:00030:01880000-0000-7000-8000-000000000001',
      type: 'customer_ledger.created',
      entity: 'customer_ledger',
      entityId: ledgerId,
      entityClass: 'FACT',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      payload: {
        id: ledgerId,
        organizationId: orgId,
        storeId,
        deviceId,
        hlc: '000170000000000:00030:01880000-0000-7000-8000-000000000001',
        createdAtMs: Number(currentNowMs),
        customerId: custId,
        entryType: 'opening_balance',
        amountDelta: '45000',
        sourceType: 'opening_balance',
        sourceId: idGen.nextId(),
        reason: 'Initial opening balance',
        createdByUserId: cashierId,
      },
      position: '30',
      hlcAdjusted: false,
      receivedAtMs: unixMsFromBigInt(currentNowMs),
    };

    const res = pullService.applySyncPullBatch({
      context: { organizationId: orgId, storeId, deviceId },
      events: [ledgerEvent],
      nextCursors: { [storeId]: 30n },
      nowMs: unixMsFromBigInt(currentNowMs),
    });

    expect(res.appliedCount).toBe(1);

    // Verify projection updated in local_customer_balances
    const balanceRow = conn.sqlite
      .prepare(
        'SELECT balance, total_debt_accrued FROM local_customer_balances WHERE customer_id = ?',
      )
      .get(custId) as { balance: number; total_debt_accrued: number };
    expect(balanceRow).toBeDefined();
    expect(balanceRow.balance).toBe(45000n);
    expect(balanceRow.total_debt_accrued).toBe(45000n);
  });

  it('T10: createHubServer listen() and close() manage worker lifecycle', async () => {
    const hub = await createHubServer({
      dbPath,
      port: 0,
      safeStorage,
      clock,
    });

    expect(hub.pushWorker.isRunning()).toBe(false);
    expect(hub.pullWorker.isRunning()).toBe(false);

    await hub.listen();

    expect(hub.pushWorker.isRunning()).toBe(true);
    expect(hub.pullWorker.isRunning()).toBe(true);

    await hub.close();

    expect(hub.pushWorker.isRunning()).toBe(false);
    expect(hub.pullWorker.isRunning()).toBe(false);
  });

  it('T3 (Oracle-X2): per-event SAVEPOINT handles SQLITE_CONSTRAINT_CHECK (whitespace name) by recording conflict and advancing cursor', () => {
    const validCatId1 = idGen.nextId();
    const whitespaceCatId = idGen.nextId();
    const validCatId2 = idGen.nextId();

    const validEvent1: SyncedEventDto = {
      eventId: idGen.nextId(),
      organizationId: orgId,
      storeId,
      deviceId,
      deviceSeq: '101',
      hlc: '000170000000000:00101:01880000-0000-7000-8000-000000000001',
      type: 'category.created',
      entity: 'categories',
      entityId: validCatId1,
      entityClass: 'ATTR',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      payload: {
        id: validCatId1,
        organizationId: orgId,
        deviceId,
        hlc: '000170000000000:00101:01880000-0000-7000-8000-000000000001',
        createdAtMs: Number(currentNowMs),
        updatedAtMs: Number(currentNowMs),
        name: 'Valid Category 1',
        nameSearch: 'valid category 1',
        sortOrder: 1,
      },
      position: '101',
      hlcAdjusted: false,
      receivedAtMs: unixMsFromBigInt(currentNowMs),
    };

    // Claude's exact toxic scenario: valid schemaVersion, but name: '   ' which triggers SQLite CHECK constraint: chk_categories_name_nonempty
    const whitespaceNameEvent: SyncedEventDto = {
      eventId: idGen.nextId(),
      organizationId: orgId,
      storeId,
      deviceId,
      deviceSeq: '102',
      hlc: '000170000000000:00102:01880000-0000-7000-8000-000000000001',
      type: 'category.created',
      entity: 'categories',
      entityId: whitespaceCatId,
      entityClass: 'ATTR',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      payload: {
        id: whitespaceCatId,
        organizationId: orgId,
        deviceId,
        hlc: '000170000000000:00102:01880000-0000-7000-8000-000000000001',
        createdAtMs: Number(currentNowMs),
        updatedAtMs: Number(currentNowMs),
        name: '   ',
        nameSearch: '   ',
        sortOrder: 2,
      },
      position: '102',
      hlcAdjusted: false,
      receivedAtMs: unixMsFromBigInt(currentNowMs),
    };

    const validEvent2: SyncedEventDto = {
      eventId: idGen.nextId(),
      organizationId: orgId,
      storeId,
      deviceId,
      deviceSeq: '103',
      hlc: '000170000000000:00103:01880000-0000-7000-8000-000000000001',
      type: 'category.created',
      entity: 'categories',
      entityId: validCatId2,
      entityClass: 'ATTR',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      payload: {
        id: validCatId2,
        organizationId: orgId,
        deviceId,
        hlc: '000170000000000:00103:01880000-0000-7000-8000-000000000001',
        createdAtMs: Number(currentNowMs),
        updatedAtMs: Number(currentNowMs),
        name: 'Valid Category 2',
        nameSearch: 'valid category 2',
        sortOrder: 3,
      },
      position: '103',
      hlcAdjusted: false,
      receivedAtMs: unixMsFromBigInt(currentNowMs),
    };

    const res = pullService.applySyncPullBatch({
      context: { organizationId: orgId, storeId, deviceId },
      events: [validEvent1, whitespaceNameEvent, validEvent2],
      nextCursors: { [storeId]: 103n },
      nowMs: unixMsFromBigInt(currentNowMs),
    });

    expect(res.appliedCount).toBe(2);
    expect(res.conflictCount).toBe(1);

    // Both valid categories exist
    expect(
      conn.sqlite.prepare('SELECT id FROM categories WHERE id = ?').get(validCatId1),
    ).toBeDefined();
    expect(
      conn.sqlite.prepare('SELECT id FROM categories WHERE id = ?').get(validCatId2),
    ).toBeDefined();
    // Toxic category does not exist
    expect(
      conn.sqlite.prepare('SELECT id FROM categories WHERE id = ?').get(whitespaceCatId),
    ).toBeUndefined();

    // Conflict recorded with LOCAL_CONSTRAINT_FAILED code
    const conflict = conn.sqlite
      .prepare('SELECT reason FROM local_sync_conflicts WHERE event_id = ?')
      .get(whitespaceNameEvent.eventId) as { reason: string };
    expect(conflict).toBeDefined();
    expect(conflict.reason).toContain('LOCAL_CONSTRAINT_FAILED');

    // Cursor cleanly advanced to 103
    const cursor = conn.sqlite
      .prepare('SELECT last_position FROM local_sync_cursors WHERE store_id = ?')
      .get(storeId) as { last_position: string | bigint };
    expect(BigInt(cursor.last_position)).toBe(103n);
  });

  it('T3 (Oracle-X2): transient error (SQLITE_BUSY / IOERR) rolls back entire batch and rethrows', () => {
    const validCatId = idGen.nextId();
    const validEvent: SyncedEventDto = {
      eventId: idGen.nextId(),
      organizationId: orgId,
      storeId,
      deviceId,
      deviceSeq: '201',
      hlc: '000170000000000:00201:01880000-0000-7000-8000-000000000001',
      type: 'category.created',
      entity: 'categories',
      entityId: validCatId,
      entityClass: 'ATTR',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      payload: {
        id: validCatId,
        organizationId: orgId,
        deviceId,
        hlc: '000170000000000:00201:01880000-0000-7000-8000-000000000001',
        createdAtMs: Number(currentNowMs),
        updatedAtMs: Number(currentNowMs),
        name: 'Transient Test Cat',
        nameSearch: 'transient test cat',
        sortOrder: 1,
      },
      position: '201',
      hlcAdjusted: false,
      receivedAtMs: unixMsFromBigInt(currentNowMs),
    };

    // Simulate transient error when inserting category
    const origPrepare = conn.sqlite.prepare.bind(conn.sqlite);
    let throwNow = false;
    conn.sqlite.prepare = ((sql: string) => {
      if (throwNow && sql.includes('INSERT INTO "categories"')) {
        const busyErr = new Error('database is locked');
        (busyErr as unknown as { code: string }).code = 'SQLITE_BUSY';
        throw busyErr;
      }
      return origPrepare(sql);
    }) as unknown as typeof conn.sqlite.prepare;

    try {
      throwNow = true;
      expect(() => {
        pullService.applySyncPullBatch({
          context: { organizationId: orgId, storeId, deviceId },
          events: [validEvent],
          nextCursors: { [storeId]: 201n },
          nowMs: unixMsFromBigInt(currentNowMs),
        });
      }).toThrow('database is locked');
    } finally {
      conn.sqlite.prepare = origPrepare;
    }

    // Event should NOT be applied
    expect(
      conn.sqlite.prepare('SELECT id FROM categories WHERE id = ?').get(validCatId),
    ).toBeUndefined();
    // Cursor should NOT advance
    const cursor = conn.sqlite
      .prepare('SELECT last_position FROM local_sync_cursors WHERE store_id = ?')
      .get(storeId) as { last_position: string | bigint } | undefined;
    expect(cursor?.last_position).toBeUndefined();
  });

  it('T4 (Oracle-X3): stock_moves, customer_ledger and supplier_ledger update projections identically to rebuildProjections oracle', () => {
    const prodId = idGen.nextId();
    const batchId = idGen.nextId();
    const moveId = idGen.nextId();
    const custId = idGen.nextId();
    const custLedgerId = idGen.nextId();
    const suppId = idGen.nextId();
    const suppLedgerId = idGen.nextId();

    // 1. Seed base product and batch into local SQLite
    conn.sqlite
      .prepare(
        `INSERT INTO products (id, organization_id, device_id, hlc, name, name_search, sku, unit, sale_price, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, '000170000000000:00000:01880000-0000-7000-8000-000000000001', 'Test Product', 'test product', 'SKU-001', 'dona', 15000, ?, ?)`,
      )
      .run(prodId, orgId, deviceId, Number(currentNowMs), Number(currentNowMs));

    conn.sqlite
      .prepare(
        `INSERT INTO batches (id, organization_id, store_id, device_id, hlc, product_id, batch_number, initial_qty, initial_cost_value, created_at_ms)
         VALUES (?, ?, ?, ?, '000170000000000:00000:01880000-0000-7000-8000-000000000001', ?, 'BATCH-001', 10000, 100000, ?)`,
      )
      .run(batchId, orgId, storeId, deviceId, prodId, Number(currentNowMs));

    // Seed customer and supplier
    conn.sqlite
      .prepare(
        `INSERT INTO customers (id, organization_id, device_id, hlc, full_name, name_search, is_active, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, '000170000000000:00000:01880000-0000-7000-8000-000000000001', 'Oracle Customer', 'oracle customer', 1, ?, ?)`,
      )
      .run(custId, orgId, deviceId, Number(currentNowMs), Number(currentNowMs));

    conn.sqlite
      .prepare(
        `INSERT INTO suppliers (id, organization_id, device_id, hlc, name, name_search, is_active, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, '000170000000000:00000:01880000-0000-7000-8000-000000000001', 'Oracle Supplier', 'oracle supplier', 1, ?, ?)`,
      )
      .run(suppId, orgId, deviceId, Number(currentNowMs), Number(currentNowMs));

    // 2. Prepare pull events: stock move (opening balance 10 units = 10000 milliunits), customer debt, supplier debt
    const stockMoveEvent: SyncedEventDto = {
      eventId: idGen.nextId(),
      organizationId: orgId,
      storeId,
      deviceId,
      deviceSeq: '301',
      hlc: '000170000000000:00301:01880000-0000-7000-8000-000000000001',
      type: 'stock_move.created',
      entity: 'stock_moves',
      entityId: moveId,
      entityClass: 'FACT',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      payload: {
        id: moveId,
        organizationId: orgId,
        storeId,
        deviceId,
        hlc: '000170000000000:00301:01880000-0000-7000-8000-000000000001',
        createdAtMs: Number(currentNowMs),
        productId: prodId,
        batchId,
        qtyDelta: '10000',
        costValueDelta: '100000',
        sourceType: 'stock_entry',
        sourceId: idGen.nextId(),
        reason: 'initial',
        createdByUserId: cashierId,
      },
      position: '301',
      hlcAdjusted: false,
      receivedAtMs: unixMsFromBigInt(currentNowMs),
    };

    const custLedgerEvent: SyncedEventDto = {
      eventId: idGen.nextId(),
      organizationId: orgId,
      storeId,
      deviceId,
      deviceSeq: '302',
      hlc: '000170000000000:00302:01880000-0000-7000-8000-000000000001',
      type: 'customer_ledger.created',
      entity: 'customer_ledger',
      entityId: custLedgerId,
      entityClass: 'FACT',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      payload: {
        id: custLedgerId,
        organizationId: orgId,
        storeId,
        deviceId,
        hlc: '000170000000000:00302:01880000-0000-7000-8000-000000000001',
        createdAtMs: Number(currentNowMs),
        customerId: custId,
        entryType: 'opening_balance',
        amountDelta: '55000',
        sourceType: 'opening_balance',
        sourceId: idGen.nextId(),
        reason: 'Customer initial balance',
        createdByUserId: cashierId,
      },
      position: '302',
      hlcAdjusted: false,
      receivedAtMs: unixMsFromBigInt(currentNowMs),
    };

    const suppLedgerEvent: SyncedEventDto = {
      eventId: idGen.nextId(),
      organizationId: orgId,
      storeId,
      deviceId,
      deviceSeq: '303',
      hlc: '000170000000000:00303:01880000-0000-7000-8000-000000000001',
      type: 'supplier_ledger.created',
      entity: 'supplier_ledger',
      entityId: suppLedgerId,
      entityClass: 'FACT',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      payload: {
        id: suppLedgerId,
        organizationId: orgId,
        storeId,
        deviceId,
        hlc: '000170000000000:00303:01880000-0000-7000-8000-000000000001',
        createdAtMs: Number(currentNowMs),
        supplierId: suppId,
        entryType: 'opening_balance',
        amountDelta: '88000',
        sourceType: 'opening_balance',
        sourceId: idGen.nextId(),
        reason: 'Supplier initial balance',
        createdByUserId: cashierId,
      },
      position: '303',
      hlcAdjusted: false,
      receivedAtMs: unixMsFromBigInt(currentNowMs),
    };

    // 3. Apply pull batch
    const res = pullService.applySyncPullBatch({
      context: { organizationId: orgId, storeId, deviceId },
      events: [stockMoveEvent, custLedgerEvent, suppLedgerEvent],
      nextCursors: { [storeId]: 303n },
      nowMs: unixMsFromBigInt(currentNowMs),
    });

    expect(res.appliedCount).toBe(3);

    // 4. Read projections updated by pull
    const pulledStock = conn.sqlite
      .prepare(
        'SELECT product_id, qty_on_hand, total_value FROM local_stock_balances WHERE product_id = ?',
      )
      .get(prodId) as { product_id: string; qty_on_hand: bigint; total_value: bigint };

    const pulledCustomer = conn.sqlite
      .prepare(
        'SELECT customer_id, balance, total_debt_accrued FROM local_customer_balances WHERE customer_id = ?',
      )
      .get(custId) as { customer_id: string; balance: bigint; total_debt_accrued: bigint };

    const pulledSupplier = conn.sqlite
      .prepare(
        'SELECT supplier_id, balance, total_debt_accrued FROM local_supplier_balances WHERE supplier_id = ?',
      )
      .get(suppId) as { supplier_id: string; balance: bigint; total_debt_accrued: bigint };

    expect(pulledStock.qty_on_hand).toBe(10000n);
    expect(pulledCustomer.balance).toBe(55000n);
    expect(pulledSupplier.balance).toBe(88000n);

    // 5. Clear all projections to simulate cold restore / rebuild
    conn.sqlite.prepare('DELETE FROM local_stock_balances').run();
    conn.sqlite.prepare('DELETE FROM local_batch_balances').run();
    conn.sqlite.prepare('DELETE FROM local_customer_balances').run();
    conn.sqlite.prepare('DELETE FROM local_supplier_balances').run();

    // Verify projections are wiped
    const countRow = conn.sqlite
      .prepare('SELECT COUNT(*) as c FROM local_stock_balances')
      .get() as { c: bigint | number };
    expect(Number(countRow.c)).toBe(0);

    // 6. Run authoritative Oracle rebuild functions
    executeStockProjectionsRebuildSync(conn.sqlite, conn.db, {
      organizationId: orgId,
      storeId,
      nextId: () => idGen.nextId(),
      nowUnixMs: () => unixMsFromBigInt(currentNowMs),
    });
    executeCustomerBalancesRebuildSync(conn.sqlite, conn.db, orgId, unixMsFromBigInt(currentNowMs));
    executeSupplierBalancesRebuildSync(conn.sqlite, conn.db, orgId, unixMsFromBigInt(currentNowMs));

    // 7. Verify Oracle rebuilt balances match pull balances with 0 drift
    const rebuiltStock = conn.sqlite
      .prepare(
        'SELECT product_id, qty_on_hand, total_value FROM local_stock_balances WHERE product_id = ?',
      )
      .get(prodId) as { product_id: string; qty_on_hand: bigint; total_value: bigint };

    const rebuiltCustomer = conn.sqlite
      .prepare(
        'SELECT customer_id, balance, total_debt_accrued FROM local_customer_balances WHERE customer_id = ?',
      )
      .get(custId) as { customer_id: string; balance: bigint; total_debt_accrued: bigint };

    const rebuiltSupplier = conn.sqlite
      .prepare(
        'SELECT supplier_id, balance, total_debt_accrued FROM local_supplier_balances WHERE supplier_id = ?',
      )
      .get(suppId) as { supplier_id: string; balance: bigint; total_debt_accrued: bigint };

    expect(rebuiltStock).toEqual(pulledStock);
    expect(rebuiltCustomer).toEqual(pulledCustomer);
    expect(rebuiltSupplier).toEqual(pulledSupplier);
  });

  it('T4 (Oracle-X4): unknown monotone rule records UNKNOWN_MONOTONE_RULE conflict and advances cursor', () => {
    const shiftId = idGen.nextId();
    // 1. Seed existing shift into local DB
    conn.db
      .insert(shifts)
      .values({
        id: shiftId,
        organizationId: orgId,
        storeId,
        deviceId,
        shiftNo: 10n,
        shiftCode: 'SHIFT-010',
        status: 'open',
        openedByUserId: cashierId,
        openingCash: moneyFromTiyin(0n),
        openingDiscrepancy: moneyFromTiyin(0n),
        openClientRequestId: idGen.nextId(),
        openRequestHash: 'hash123456',
        openedAtMs: unixMsFromBigInt(currentNowMs),
        createdAtMs: unixMsFromBigInt(currentNowMs),
        updatedAtMs: unixMsFromBigInt(currentNowMs),
        hlc: '000170000000000:00000:01880000-0000-7000-8000-000000000001',
      })
      .run();

    // 2. Temporarily delete shifts rule from MONOTONE_TRANSITION_RULES to simulate unknown rule
    const rulesRecord = MONOTONE_TRANSITION_RULES as Record<string, unknown>;
    const origShiftsRule = rulesRecord.shifts;
    delete rulesRecord.shifts;

    const monotoneEvent: SyncedEventDto = {
      eventId: idGen.nextId(),
      organizationId: orgId,
      storeId,
      deviceId,
      deviceSeq: '401',
      hlc: '000170000000000:00401:01880000-0000-7000-8000-000000000001',
      type: 'shift.closed',
      entity: 'shifts',
      entityId: shiftId,
      entityClass: 'MONOTONE',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      payload: {
        id: shiftId,
        organizationId: orgId,
        storeId,
        deviceId,
        hlc: '000170000000000:00401:01880000-0000-7000-8000-000000000001',
        createdAtMs: Number(currentNowMs),
        updatedAtMs: Number(currentNowMs),
        shiftNo: '10',
        shiftCode: 'SHIFT-010',
        status: 'closed',
        openedByUserId: cashierId,
        closedByUserId: cashierId,
        openingCash: '0',
        openingDiscrepancy: '0',
        openClientRequestId: idGen.nextId(),
        openRequestHash: 'hashopen',
        closeClientRequestId: idGen.nextId(),
        closeRequestHash: 'hashclose',
        openedAtMs: Number(currentNowMs),
        closedAtMs: Number(currentNowMs),
      },
      position: '401',
      hlcAdjusted: false,
      receivedAtMs: unixMsFromBigInt(currentNowMs),
    };

    try {
      const res = pullService.applySyncPullBatch({
        context: { organizationId: orgId, storeId, deviceId },
        events: [monotoneEvent],
        nextCursors: { [storeId]: 401n },
        nowMs: unixMsFromBigInt(currentNowMs),
      });

      expect(res.appliedCount).toBe(0);
      expect(res.conflictCount).toBe(1);

      const conflict = conn.sqlite
        .prepare('SELECT reason FROM local_sync_conflicts WHERE event_id = ?')
        .get(monotoneEvent.eventId) as { reason: string };
      expect(conflict).toBeDefined();
      expect(conflict.reason).toBe('UNKNOWN_MONOTONE_RULE');

      const cursor = conn.sqlite
        .prepare('SELECT last_position FROM local_sync_cursors WHERE store_id = ?')
        .get(storeId) as { last_position: string | bigint };
      expect(BigInt(cursor.last_position)).toBe(401n);
    } finally {
      rulesRecord.shifts = origShiftsRule;
    }
  });
});

describe('classifySyncError unit tests (X2)', () => {
  it('correctly classifies PermanentSyncError', () => {
    const err = new PermanentSyncError('CUSTOM_PERM_CODE', 'Custom permanent error message');
    const res = classifySyncError(err);
    expect(res).toEqual({
      type: 'permanent',
      code: 'CUSTOM_PERM_CODE',
      message: 'Custom permanent error message',
    });
  });

  it('correctly classifies SQLITE_CONSTRAINT_CHECK, NOTNULL, UNIQUE as permanent', () => {
    const checkErr = new Error('CHECK constraint failed: chk_categories_name_nonempty');
    (checkErr as unknown as { code: string }).code = 'SQLITE_CONSTRAINT_CHECK';
    expect(classifySyncError(checkErr)).toEqual({
      type: 'permanent',
      code: 'LOCAL_CONSTRAINT_FAILED:SQLITE_CONSTRAINT_CHECK',
      message: 'CHECK constraint failed: chk_categories_name_nonempty',
    });

    const notNullErr = new Error('NOT NULL constraint failed: categories.name');
    (notNullErr as unknown as { code: string }).code = 'SQLITE_CONSTRAINT_NOTNULL';
    expect(classifySyncError(notNullErr)).toEqual({
      type: 'permanent',
      code: 'LOCAL_CONSTRAINT_FAILED:SQLITE_CONSTRAINT_NOTNULL',
      message: 'NOT NULL constraint failed: categories.name',
    });

    const uniqueErr = new Error('UNIQUE constraint failed: categories.name');
    (uniqueErr as unknown as { code: string }).code = 'SQLITE_CONSTRAINT_UNIQUE';
    expect(classifySyncError(uniqueErr)).toEqual({
      type: 'permanent',
      code: 'LOCAL_CONSTRAINT_FAILED:SQLITE_CONSTRAINT_UNIQUE',
      message: 'UNIQUE constraint failed: categories.name',
    });
  });

  it('correctly classifies SQLITE_CONSTRAINT_FOREIGNKEY as park_foreign_key', () => {
    const fkErr = new Error('FOREIGN KEY constraint failed');
    (fkErr as unknown as { code: string }).code = 'SQLITE_CONSTRAINT_FOREIGNKEY';
    expect(classifySyncError(fkErr)).toEqual({
      type: 'park_foreign_key',
      code: 'SQLITE_CONSTRAINT_FOREIGNKEY',
      message: 'FOREIGN KEY constraint failed',
    });

    // Also handles when code is missing but regex matches message
    const msgFkErr = new Error('FOREIGN KEY constraint failed');
    expect(classifySyncError(msgFkErr)).toEqual({
      type: 'park_foreign_key',
      code: 'SQLITE_CONSTRAINT_FOREIGNKEY',
      message: 'FOREIGN KEY constraint failed',
    });
  });

  it('correctly classifies SQLITE_BUSY, SQLITE_IOERR, SQLITE_FULL as transient', () => {
    const busyErr = new Error('database is locked');
    (busyErr as unknown as { code: string }).code = 'SQLITE_BUSY';
    expect(classifySyncError(busyErr)).toEqual({
      type: 'transient',
      code: 'SQLITE_BUSY',
      message: 'database is locked',
    });

    const ioErr = new Error('disk I/O error');
    (ioErr as unknown as { code: string }).code = 'SQLITE_IOERR';
    expect(classifySyncError(ioErr)).toEqual({
      type: 'transient',
      code: 'SQLITE_IOERR',
      message: 'disk I/O error',
    });
  });
});
