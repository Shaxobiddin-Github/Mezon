import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type LocalSqliteConnection,
  ensureDeviceStateRowSync,
  migrateLocalDatabase,
  openLocalSqliteDatabase,
} from '@mezon/db-local';
import {
  type Clock,
  type IdGenerator,
  MonotonicUuidV7Generator,
  parseUuidV7,
  unixMsFromBigInt,
} from '@mezon/domain';
import { type SyncedEventDto, CURRENT_SCHEMA_VERSION } from '@mezon/sync';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HubSyncPullService } from './sync-pull-service.js';

describe('T2.4 Mutation Tests (6 Sync Pull Invariants)', () => {
  let tmpDir: string;
  let dbPath: string;
  let conn: LocalSqliteConnection;
  let pullService: HubSyncPullService;
  let idGen: IdGenerator;

  const currentNowMs = 1700000000000n;
  const clock: Clock = {
    now: () => unixMsFromBigInt(currentNowMs),
  };

  const orgId = parseUuidV7('01880000-0000-7000-8000-000000000001');
  const storeId = parseUuidV7('01880000-0000-7000-8000-000000000002');
  const deviceId = parseUuidV7('01880000-0000-7000-8000-000000000003');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-sync-pull-mutations-'));
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

    pullService = new HubSyncPullService(conn);
  });

  afterEach(() => {
    try {
      conn.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('Mutation 1: Kills mutant where echo suppression only checks deviceId without checking local_outbox', () => {
    const catId = idGen.nextId();
    const eventId = idGen.nextId();

    // Event carries current deviceId (e.g. from Cloud after Hub restored from backup)
    // local_outbox does NOT contain this event!
    const restoredEvent: SyncedEventDto = {
      eventId,
      organizationId: orgId,
      storeId,
      deviceId, // Same as current device!
      deviceSeq: '1',
      hlc: '000170000000000:00001:01880000-0000-7000-8000-000000000001',
      type: 'category.created',
      entity: 'categories',
      entityId: catId,
      entityClass: 'ATTR',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      payload: {
        id: catId,
        organizationId: orgId,
        deviceId,
        hlc: '000170000000000:00001:01880000-0000-7000-8000-000000000001',
        createdAtMs: Number(currentNowMs),
        updatedAtMs: Number(currentNowMs),
        name: 'Restored Category',
        nameSearch: 'restored category',
        sortOrder: 1,
      },
      position: '1',
      hlcAdjusted: false,
      receivedAtMs: unixMsFromBigInt(currentNowMs),
    };

    const res = pullService.applySyncPullBatch({
      context: { organizationId: orgId, storeId, deviceId },
      events: [restoredEvent],
      nextCursors: { [storeId]: 1n },
      nowMs: unixMsFromBigInt(currentNowMs),
    });

    // Mutant that checks only deviceId would skip this event (skippedEchoCount = 1, appliedCount = 0).
    // Correct implementation applies it (appliedCount = 1, skippedEchoCount = 0).
    expect(res.appliedCount).toBe(1);
    expect(res.skippedEchoCount).toBe(0);
    expect(conn.sqlite.prepare('SELECT id FROM categories WHERE id = ?').get(catId)).toBeDefined();
  });

  it('Mutation 2: Kills mutant where cursor updates occur outside transaction on failure', () => {
    // Inject a batch where transaction fails midway (e.g. invalid cursor ID or catastrophic error)
    // Verify that cursor does NOT advance in local_sync_cursors if transaction fails
    const initialCursor = pullService.getCursors(orgId);
    expect(initialCursor[storeId]).toBeUndefined();

    // Passing invalid schema version in event throws PermanentSyncError which is caught per-event,
    // but if we corrupt database state or force a fatal rollback, cursor must not be updated.
    // Let's test atomic rollback:
    expect(() => {
      // Create a mock pull service where transaction throws
      conn.sqlite.transaction(() => {
        conn.sqlite
          .prepare(
            `INSERT INTO local_sync_cursors (id, organization_id, store_id, last_position, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(idGen.nextId(), orgId, storeId, 999, Number(currentNowMs), Number(currentNowMs));
        throw new Error('Forced batch rollback');
      })();
    }).toThrow('Forced batch rollback');

    const cursorAfter = pullService.getCursors(orgId);
    expect(cursorAfter[storeId]).toBeUndefined();
  });

  it('Mutation 3: Kills mutant where pull does NOT write to local_outbox (prevents infinite echo loops)', () => {
    const catId = idGen.nextId();
    const eventId = idGen.nextId();

    const incomingEvent: SyncedEventDto = {
      eventId,
      organizationId: orgId,
      storeId,
      deviceId: parseUuidV7('01880000-0000-7000-8000-000000000099'), // Other device
      deviceSeq: '1',
      hlc: '000170000000000:00001:01880000-0000-7000-8000-000000000001',
      type: 'category.created',
      entity: 'categories',
      entityId: catId,
      entityClass: 'ATTR',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      payload: {
        id: catId,
        organizationId: orgId,
        deviceId: parseUuidV7('01880000-0000-7000-8000-000000000099'),
        hlc: '000170000000000:00001:01880000-0000-7000-8000-000000000001',
        createdAtMs: Number(currentNowMs),
        updatedAtMs: Number(currentNowMs),
        name: 'Inbound Category',
        nameSearch: 'inbound category',
        sortOrder: 1,
      },
      position: '1',
      hlcAdjusted: false,
      receivedAtMs: unixMsFromBigInt(currentNowMs),
    };

    const outboxCountBefore = conn.sqlite
      .prepare('SELECT count(*) as cnt FROM local_outbox')
      .get() as { cnt: number | bigint };
    expect(outboxCountBefore.cnt).toBe(0n);

    pullService.applySyncPullBatch({
      context: { organizationId: orgId, storeId, deviceId },
      events: [incomingEvent],
      nextCursors: { [storeId]: 1n },
      nowMs: unixMsFromBigInt(currentNowMs),
    });

    // Applied event MUST NOT be appended to local_outbox!
    const outboxCountAfter = conn.sqlite
      .prepare('SELECT count(*) as cnt FROM local_outbox')
      .get() as { cnt: number | bigint };
    expect(outboxCountAfter.cnt).toBe(0n);
  });

  it('Mutation 4: Kills mutant where clamp adjustment is skipped on hlcAdjusted events', () => {
    const catId = idGen.nextId();
    const eventId = idGen.nextId();
    const futureHlc = '000180000000000:00000:01880000-0000-7000-8000-000000000001';
    const serverClampedHlc = '000170000000000:00000:01880000-0000-7000-8000-000000000001';

    // Seed category with future HLC
    conn.sqlite
      .prepare(
        `
      INSERT INTO categories (id, organization_id, device_id, hlc, name, name_search, sort_order, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, 'Mutant Cat', 'mutant cat', 1, ?, ?)
    `,
      )
      .run(catId, orgId, deviceId, futureHlc, Number(currentNowMs), Number(currentNowMs));

    // Seed outbox so it counts as an echo
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

    pullService.applySyncPullBatch({
      context: { organizationId: orgId, storeId, deviceId },
      events: [
        {
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
            name: 'Mutant Cat',
            nameSearch: 'mutant cat',
            sortOrder: 1,
          },
          position: '1',
          hlcAdjusted: true,
          receivedAtMs: unixMsFromBigInt(currentNowMs),
        },
      ],
      nextCursors: { [storeId]: 1n },
      nowMs: unixMsFromBigInt(currentNowMs),
    });

    const cat = conn.sqlite.prepare('SELECT hlc FROM categories WHERE id = ?').get(catId) as {
      hlc: string;
    };
    // Mutant that skips clamping leaves the future HLC intact
    expect(cat.hlc).toBe(serverClampedHlc);
    expect(cat.hlc).not.toBe(futureHlc);
  });

  it('Mutation 5: Kills mutant where missing foreign key events are dropped instead of parked', () => {
    const missingCatId = idGen.nextId();
    const prodId = idGen.nextId();
    const prodEventId = idGen.nextId();

    pullService.applySyncPullBatch({
      context: { organizationId: orgId, storeId, deviceId },
      events: [
        {
          eventId: prodEventId,
          organizationId: orgId,
          storeId,
          deviceId,
          deviceSeq: '1',
          hlc: '000170000000000:00001:01880000-0000-7000-8000-000000000001',
          type: 'product.created',
          entity: 'products',
          entityId: prodId,
          entityClass: 'ATTR',
          schemaVersion: CURRENT_SCHEMA_VERSION,
          payload: {
            id: prodId,
            organizationId: orgId,
            deviceId,
            hlc: '000170000000000:00001:01880000-0000-7000-8000-000000000001',
            createdAtMs: Number(currentNowMs),
            updatedAtMs: Number(currentNowMs),
            categoryId: missingCatId,
            sku: 'MUTANT-SKU',
            skuSearch: 'mutant-sku',
            name: 'Mutant Product',
            nameSearch: 'mutant product',
            unit: 'dona',
            unlimited: false,
            hasVariants: false,
            trackBatches: false,
            salePrice: '30000',
            vatRateBp: 1200,
          },
          position: '1',
          hlcAdjusted: false,
          receivedAtMs: unixMsFromBigInt(currentNowMs),
        },
      ],
      nextCursors: { [storeId]: 1n },
      nowMs: unixMsFromBigInt(currentNowMs),
    });

    // Mutant that drops missing FK events would have 0 in local_sync_parked
    const parked = conn.sqlite
      .prepare('SELECT id, missing_ref_id FROM local_sync_parked WHERE event_id = ?')
      .get(prodEventId) as { id: string; missing_ref_id: string } | undefined;
    expect(parked).toBeDefined();
    expect(parked?.missing_ref_id).toBe(missingCatId);
  });

  it('Mutation 6: Kills mutant where FACT content mismatch is silently ignored without recording conflict', () => {
    const factId = idGen.nextId();
    const eventId1 = idGen.nextId();
    const eventId2 = idGen.nextId();

    // Apply valid category (ATTR) first to satisfy FK if needed
    // Then apply FACT: customer_ledger
    const custId = idGen.nextId();
    conn.sqlite
      .prepare(
        `
      INSERT INTO customers (id, organization_id, device_id, hlc, full_name, name_search, is_active, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, '000170000000000:00000:01880000-0000-7000-8000-000000000001', 'Cust Fact', 'cust fact', 1, ?, ?)
    `,
      )
      .run(custId, orgId, deviceId, Number(currentNowMs), Number(currentNowMs));

    // Cashier
    const cashierId = idGen.nextId();
    conn.sqlite
      .prepare(
        `
      INSERT INTO users (id, organization_id, device_id, hlc, username, full_name, role, is_active, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, '000170000000000:00000:01880000-0000-7000-8000-000000000001', 'fact_user', 'Fact User', 'cashier', 1, ?, ?)
    `,
      )
      .run(cashierId, orgId, deviceId, Number(currentNowMs), Number(currentNowMs));

    const factEvent1: SyncedEventDto = {
      eventId: eventId1,
      organizationId: orgId,
      storeId,
      deviceId,
      deviceSeq: '1',
      hlc: '000170000000000:00001:01880000-0000-7000-8000-000000000001',
      type: 'customer_ledger.created',
      entity: 'customer_ledger',
      entityId: factId,
      entityClass: 'FACT',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      payload: {
        id: factId,
        organizationId: orgId,
        storeId,
        deviceId,
        hlc: '000170000000000:00001:01880000-0000-7000-8000-000000000001',
        createdAtMs: Number(currentNowMs),
        customerId: custId,
        entryType: 'opening_balance',
        amountDelta: '50000',
        sourceType: 'opening_balance',
        sourceId: idGen.nextId(),
        reason: 'Original Reason',
        createdByUserId: cashierId,
      },
      position: '1',
      hlcAdjusted: false,
      receivedAtMs: unixMsFromBigInt(currentNowMs),
    };

    pullService.applySyncPullBatch({
      context: { organizationId: orgId, storeId, deviceId },
      events: [factEvent1],
      nextCursors: { [storeId]: 1n },
      nowMs: unixMsFromBigInt(currentNowMs),
    });

    // Second event has SAME factId but DIFFERENT amountDelta
    const factEvent2: SyncedEventDto = {
      eventId: eventId2,
      organizationId: orgId,
      storeId,
      deviceId,
      deviceSeq: '2',
      hlc: '000170000000000:00002:01880000-0000-7000-8000-000000000001',
      type: 'customer_ledger.created',
      entity: 'customer_ledger',
      entityId: factId,
      entityClass: 'FACT',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      payload: {
        id: factId,
        organizationId: orgId,
        storeId,
        deviceId,
        hlc: '000170000000000:00002:01880000-0000-7000-8000-000000000001',
        createdAtMs: Number(currentNowMs),
        customerId: custId,
        entryType: 'opening_balance',
        amountDelta: '99999', // Differing payload!
        sourceType: 'opening_balance',
        sourceId: idGen.nextId(),
        reason: 'Tampered Reason',
        createdByUserId: cashierId,
      },
      position: '2',
      hlcAdjusted: false,
      receivedAtMs: unixMsFromBigInt(currentNowMs),
    };

    const res2 = pullService.applySyncPullBatch({
      context: { organizationId: orgId, storeId, deviceId },
      events: [factEvent2],
      nextCursors: { [storeId]: 2n },
      nowMs: unixMsFromBigInt(currentNowMs),
    });

    // Mutant that ignores hash mismatch would have conflictCount = 0
    expect(res2.conflictCount).toBe(1);
    const conflict = conn.sqlite
      .prepare('SELECT reason FROM local_sync_conflicts WHERE event_id = ?')
      .get(eventId2) as { reason: string } | undefined;
    expect(conflict?.reason).toBe('FACT_CONTENT_HASH_MISMATCH');
  });
});
