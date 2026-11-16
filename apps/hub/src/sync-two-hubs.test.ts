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

describe('Two Hubs Convergence Model Test (T2.4)', () => {
  let tmpDirA: string;
  let tmpDirB: string;
  let dbPathA: string;
  let dbPathB: string;
  let connA: LocalSqliteConnection;
  let connB: LocalSqliteConnection;
  let pullServiceA: HubSyncPullService;
  let pullServiceB: HubSyncPullService;
  let idGen: IdGenerator;

  const baseNowMs = 1700000000000n;
  let currentNowMs = baseNowMs;
  const clock: Clock = {
    now: () => unixMsFromBigInt(currentNowMs),
  };

  const orgId = parseUuidV7('01880000-0000-7000-8000-000000000001');
  const storeA = parseUuidV7('01880000-0000-7000-8000-000000000011');
  const storeB = parseUuidV7('01880000-0000-7000-8000-000000000022');
  const deviceA = parseUuidV7('01880000-0000-7000-8000-000000000111');
  const deviceB = parseUuidV7('01880000-0000-7000-8000-000000000222');
  const cashierA = parseUuidV7('01880000-0000-7000-8000-000000000333');

  beforeEach(() => {
    tmpDirA = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-convergence-a-'));
    tmpDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-convergence-b-'));
    dbPathA = path.join(tmpDirA, 'hub-a.db');
    dbPathB = path.join(tmpDirB, 'hub-b.db');

    connA = openLocalSqliteDatabase(dbPathA);
    connB = openLocalSqliteDatabase(dbPathB);
    migrateLocalDatabase(connA.db);
    migrateLocalDatabase(connB.db);

    idGen = new MonotonicUuidV7Generator({
      clock,
      random: { nextBytes: (n: number) => new Uint8Array(n).fill(1) },
    });

    ensureDeviceStateRowSync(connA.sqlite, connA.db, {
      rowId: idGen.nextId(),
      organizationId: orgId,
      deviceId: deviceA,
      initialHlcStr: '000170000000000:00000:01880000-0000-7000-8000-000000000111',
      initialUuidMs: baseNowMs,
      nowMs: baseNowMs,
    });

    ensureDeviceStateRowSync(connB.sqlite, connB.db, {
      rowId: idGen.nextId(),
      organizationId: orgId,
      deviceId: deviceB,
      initialHlcStr: '000170000000000:00000:01880000-0000-7000-8000-000000000222',
      initialUuidMs: baseNowMs,
      nowMs: baseNowMs,
    });

    // Seed cashier on Hub A
    connA.sqlite
      .prepare(
        `
      INSERT INTO users (id, organization_id, device_id, hlc, username, full_name, role, is_active, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, '000170000000000:00000:01880000-0000-7000-8000-000000000111', 'cashier_a', 'Cashier A', 'cashier', 1, ?, ?)
    `,
      )
      .run(cashierA, orgId, deviceA, Number(baseNowMs), Number(baseNowMs));

    // Seed cashier on Hub B
    connB.sqlite
      .prepare(
        `
      INSERT INTO users (id, organization_id, device_id, hlc, username, full_name, role, is_active, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, '000170000000000:00000:01880000-0000-7000-8000-000000000222', 'cashier_a', 'Cashier A', 'cashier', 1, ?, ?)
    `,
      )
      .run(cashierA, orgId, deviceB, Number(baseNowMs), Number(baseNowMs));

    pullServiceA = new HubSyncPullService(connA);
    pullServiceB = new HubSyncPullService(connB);
  });

  afterEach(() => {
    try {
      connA.close();
      connB.close();
      fs.rmSync(tmpDirA, { recursive: true, force: true });
      fs.rmSync(tmpDirB, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('Hub A and Hub B converge: shared categories, customer edits via LWW, and cross-store debts', () => {
    const sharedCatId = idGen.nextId();
    const sharedCustId = idGen.nextId();

    // 1. Hub A creates Category and Customer
    const hlcA1 = '000170000000000:00001:01880000-0000-7000-8000-000000000111';
    connA.sqlite
      .prepare(
        `
      INSERT INTO categories (id, organization_id, device_id, hlc, name, name_search, sort_order, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, 'Ichimliklar', 'ichimliklar', 1, ?, ?)
    `,
      )
      .run(sharedCatId, orgId, deviceA, hlcA1, Number(baseNowMs), Number(baseNowMs));

    connA.sqlite
      .prepare(
        `
      INSERT INTO customers (id, organization_id, device_id, hlc, full_name, name_search, is_active, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, 'Akmal Saidov', 'akmal saidov', 1, ?, ?)
    `,
      )
      .run(sharedCustId, orgId, deviceA, hlcA1, Number(baseNowMs), Number(baseNowMs));

    // 2. Simulate Cloud holding the events pushed from Hub A
    const catEventFromA: SyncedEventDto = {
      eventId: idGen.nextId(),
      organizationId: orgId,
      storeId: storeA,
      deviceId: deviceA,
      deviceSeq: '1',
      hlc: hlcA1,
      type: 'category.created',
      entity: 'categories',
      entityId: sharedCatId,
      entityClass: 'ATTR',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      payload: {
        id: sharedCatId,
        organizationId: orgId,
        deviceId: deviceA,
        hlc: hlcA1,
        createdAtMs: Number(baseNowMs),
        updatedAtMs: Number(baseNowMs),
        name: 'Ichimliklar',
        nameSearch: 'ichimliklar',
        sortOrder: 1,
      },
      position: '1',
      hlcAdjusted: false,
      receivedAtMs: unixMsFromBigInt(baseNowMs),
    };

    const custEventFromA: SyncedEventDto = {
      eventId: idGen.nextId(),
      organizationId: orgId,
      storeId: storeA,
      deviceId: deviceA,
      deviceSeq: '2',
      hlc: hlcA1,
      type: 'customer.created',
      entity: 'customers',
      entityId: sharedCustId,
      entityClass: 'ATTR',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      payload: {
        id: sharedCustId,
        organizationId: orgId,
        deviceId: deviceA,
        hlc: hlcA1,
        createdAtMs: Number(baseNowMs),
        updatedAtMs: Number(baseNowMs),
        fullName: 'Akmal Saidov',
        nameSearch: 'akmal saidov',
        isActive: true,
      },
      position: '2',
      hlcAdjusted: false,
      receivedAtMs: unixMsFromBigInt(baseNowMs),
    };

    // 3. Hub B pulls from Cloud: applies category and customer
    const pullResB = pullServiceB.applySyncPullBatch({
      context: { organizationId: orgId, storeId: storeB, deviceId: deviceB },
      events: [catEventFromA, custEventFromA],
      nextCursors: { [storeA]: 2n },
      nowMs: unixMsFromBigInt(baseNowMs),
    });

    expect(pullResB.appliedCount).toBe(2);
    expect(
      connB.sqlite.prepare('SELECT name FROM categories WHERE id = ?').get(sharedCatId),
    ).toEqual({ name: 'Ichimliklar' });
    expect(
      connB.sqlite.prepare('SELECT full_name FROM customers WHERE id = ?').get(sharedCustId),
    ).toEqual({ full_name: 'Akmal Saidov' });

    // 4. Hub B updates Category name with a higher HLC
    currentNowMs = baseNowMs + 60000n;
    const hlcB2 = '000170000060000:00001:01880000-0000-7000-8000-000000000222';
    connB.sqlite
      .prepare(
        `
      UPDATE categories SET name = 'Salqin Ichimliklar', name_search = 'salqin ichimliklar', hlc = ?, updated_at_ms = ? WHERE id = ?
    `,
      )
      .run(hlcB2, Number(currentNowMs), sharedCatId);

    // Event pushed from Hub B to Cloud
    const catUpdateEventFromB: SyncedEventDto = {
      eventId: idGen.nextId(),
      organizationId: orgId,
      storeId: storeB,
      deviceId: deviceB,
      deviceSeq: '1',
      hlc: hlcB2,
      type: 'category.updated',
      entity: 'categories',
      entityId: sharedCatId,
      entityClass: 'ATTR',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      payload: {
        id: sharedCatId,
        organizationId: orgId,
        deviceId: deviceB,
        hlc: hlcB2,
        createdAtMs: Number(baseNowMs),
        updatedAtMs: Number(currentNowMs),
        name: 'Salqin Ichimliklar',
        nameSearch: 'salqin ichimliklar',
        sortOrder: 1,
      },
      position: '1',
      hlcAdjusted: false,
      receivedAtMs: unixMsFromBigInt(currentNowMs),
    };

    // 5. Hub A pulls from Cloud: category name is updated to Hub B's change via LWW!
    const pullResA = pullServiceA.applySyncPullBatch({
      context: { organizationId: orgId, storeId: storeA, deviceId: deviceA },
      events: [catUpdateEventFromB],
      nextCursors: { [storeB]: 1n },
      nowMs: unixMsFromBigInt(currentNowMs),
    });

    expect(pullResA.appliedCount).toBe(1);
    expect(
      connA.sqlite.prepare('SELECT name FROM categories WHERE id = ?').get(sharedCatId),
    ).toEqual({ name: 'Salqin Ichimliklar' });

    // 6. Hub A records customer debt of 70,000 UZS for Akmal Saidov
    currentNowMs = baseNowMs + 120000n;
    const ledgerId = idGen.nextId();
    const hlcA3 = '000170000120000:00001:01880000-0000-7000-8000-000000000111';

    const ledgerEventFromA: SyncedEventDto = {
      eventId: idGen.nextId(),
      organizationId: orgId,
      storeId: storeA,
      deviceId: deviceA,
      deviceSeq: '3',
      hlc: hlcA3,
      type: 'customer_ledger.created',
      entity: 'customer_ledger',
      entityId: ledgerId,
      entityClass: 'FACT',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      payload: {
        id: ledgerId,
        organizationId: orgId,
        storeId: storeA,
        deviceId: deviceA,
        hlc: hlcA3,
        createdAtMs: Number(currentNowMs),
        customerId: sharedCustId,
        entryType: 'opening_balance',
        amountDelta: '70000',
        sourceType: 'opening_balance',
        sourceId: idGen.nextId(),
        reason: 'Store A debt',
        createdByUserId: cashierA,
      },
      position: '3',
      hlcAdjusted: false,
      receivedAtMs: unixMsFromBigInt(currentNowMs),
    };

    // Apply to Hub A itself first (as local projection)
    pullServiceA.applySyncPullBatch({
      context: { organizationId: orgId, storeId: storeA, deviceId: deviceA },
      events: [ledgerEventFromA],
      nextCursors: { [storeA]: 3n },
      nowMs: unixMsFromBigInt(currentNowMs),
    });

    const balA = connA.sqlite
      .prepare('SELECT balance FROM local_customer_balances WHERE customer_id = ?')
      .get(sharedCustId) as { balance: bigint };
    expect(balA.balance).toBe(70000n);

    // 7. Hub B pulls customer_ledger event from Cloud (since customer_ledger has pullScope: 'organization')
    pullServiceB.applySyncPullBatch({
      context: { organizationId: orgId, storeId: storeB, deviceId: deviceB },
      events: [ledgerEventFromA],
      nextCursors: { [storeA]: 3n },
      nowMs: unixMsFromBigInt(currentNowMs),
    });

    // Hub B's local customer balance projection is updated with the debt from Store A!
    const balB = connB.sqlite
      .prepare('SELECT balance FROM local_customer_balances WHERE customer_id = ?')
      .get(sharedCustId) as { balance: bigint };
    expect(balB.balance).toBe(70000n);

    // Both Hubs are in complete convergence!
    expect(balA.balance).toEqual(balB.balance);
    const catA = connA.sqlite
      .prepare('SELECT name, hlc FROM categories WHERE id = ?')
      .get(sharedCatId);
    const catB = connB.sqlite
      .prepare('SELECT name, hlc FROM categories WHERE id = ?')
      .get(sharedCatId);
    expect(catA).toEqual(catB);
  });
});
