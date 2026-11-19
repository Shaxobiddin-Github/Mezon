import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ApiErrorEnvelopeSchema,
  LoginResponseSchema,
  ProductDetailResponseSchema,
  ResolveSyncConflictResponseSchema,
  SyncConflictListResponseSchema,
  SyncParkedListResponseSchema,
} from '@mezon/contracts';
import {
  MonotonicUuidV7Generator,
  type PinHasher,
  parseUuidV7,
  unixMsFromBigInt,
} from '@mezon/domain';
import { type SyncedEventDto } from '@mezon/sync';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { type HubServer, createHubServer } from './index.js';

const PORT = 47873;
const HOST = `127.0.0.1:${PORT}`;
const T0 = 1_767_000_000_000n;
const fastHasher: PinHasher = {
  hash: (pin) => Promise.resolve(`fast-stub-hash:${pin}`),
  verify: (stored, pin) => Promise.resolve(stored === `fast-stub-hash:${pin}`),
};
const hdr = (t?: string): Record<string, string> =>
  t ? { host: HOST, authorization: `Bearer ${t}` } : { host: HOST };
const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

interface Env {
  hub: HubServer;
  clock: FixedClock;
  owner: string;
  manager: string;
  cashier: string;
  customer: string;
  n: () => string;
  outboxEvent: (where: string) => SyncedEventDto;
  pull: (events: SyncedEventDto[]) => void;
  clone: (e: SyncedEventDto, patch: Record<string, unknown>) => SyncedEventDto;
  one: <T>(sql: string, ...args: unknown[]) => T;
}

async function boot(seed: number): Promise<Env> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-sync-conflicts-'));
  tempDirs.push(dir);
  const clock = new FixedClock(T0);
  const hub = await createHubServer({
    dbPath: path.join(dir, 'hub.db'),
    port: PORT,
    logLevel: 'silent',
    clock,
    random: new SeededRandomSource(seed),
    pinHasher: fastHasher,
  });
  await hub.app.inject({
    method: 'POST',
    url: '/setup',
    headers: hdr(),
    payload: { owner: { fullName: 'Egasi', username: 'owner', pin: '849201' } },
  });
  const login = async (username: string, pin: string) =>
    LoginResponseSchema.parse(
      (
        await hub.app.inject({
          method: 'POST',
          url: '/auth/login',
          headers: hdr(),
          payload: { username, pin },
        })
      ).json(),
    ).token;
  const owner = await login('owner', '849201');
  for (const u of [
    { fullName: 'Menejer', username: 'mgr', role: 'manager', pin: '739104' },
    { fullName: 'Kassir', username: 'kassa', role: 'cashier', pin: '582914' },
  ]) {
    await hub.app.inject({ method: 'POST', url: '/users', headers: hdr(owner), payload: u });
  }
  let i = 0;
  const n = () => `01993400-0000-7000-8000-${(seed * 1000 + ++i).toString(16).padStart(12, '0')}`;
  const inject = (url: string, payload: Record<string, unknown>) =>
    hub.app.inject({ method: 'POST', url, headers: hdr(owner), payload });
  await inject('/shifts/open', { clientRequestId: n(), openingCash: '0' });
  const product = ProductDetailResponseSchema.parse(
    (await inject('/products', { name: 'Olma', unit: 'dona', salePrice: '10000' })).json(),
  ).product.id;
  const customer = (
    await inject('/customers', { fullName: 'Ali', creditLimit: '100000000' })
  ).json<{ customer: { id: string } }>().customer.id;
  // A 10 000 debt, then paid by card: the hub balance is 0.
  const cartId = (await inject('/carts', {})).json<{ cart: { id: string } }>().cart.id;
  await inject(`/carts/${cartId}/lines`, { kind: 'catalog', productId: product, qty: '1000' });
  const sale = await inject(`/carts/${cartId}/complete`, {
    clientRequestId: n(),
    expectedTotal: '10000',
    customerId: customer,
    debtAmount: '10000',
    payments: [],
  });
  expect(sale.statusCode, sale.body).toBe(200);
  const pay = await inject(`/customers/${customer}/payments`, {
    clientRequestId: n(),
    method: 'card',
    amount: '10000',
  });
  expect(pay.statusCode, pay.body).toBe(201);

  const one = <T>(sql: string, ...args: unknown[]) =>
    hub.connection.sqlite.prepare(sql).get(...args) as T;
  const ctx = one<{ o: string; s: string; d: string }>(
    'SELECT organization_id AS o, store_id AS s, device_id AS d FROM local_outbox WHERE store_id IS NOT NULL LIMIT 1',
  );
  const outboxEvent = (where: string): SyncedEventDto => {
    const x = one<Record<string, unknown>>(`SELECT * FROM local_outbox WHERE ${where} LIMIT 1`);
    return {
      eventId: parseUuidV7(String(x.id)),
      organizationId: parseUuidV7(ctx.o),
      storeId: parseUuidV7(ctx.s),
      deviceId: parseUuidV7(String(x.device_id)),
      deviceSeq: String(x.device_seq),
      hlc: String(x.hlc),
      type: String(x.type),
      entity: String(x.entity),
      entityId: parseUuidV7(String(x.entity_id)),
      entityClass: String(x.class) as SyncedEventDto['entityClass'],
      schemaVersion: Number(x.schema_version),
      payload: JSON.parse(String(x.payload)) as Record<string, unknown>,
      position: '1',
      hlcAdjusted: false,
      receivedAtMs: Number(T0),
    };
  };
  const gen = new MonotonicUuidV7Generator({
    clock: { now: () => unixMsFromBigInt(T0 + 5n) },
    random: new SeededRandomSource(seed + 1),
  });
  const clone = (e: SyncedEventDto, patch: Record<string, unknown>): SyncedEventDto => {
    const id = gen.nextId();
    return {
      ...e,
      eventId: gen.nextId(),
      entityId: id,
      storeId: parseUuidV7('01993400-0000-7000-8000-0000000057e2'),
      deviceId: parseUuidV7('01993400-0000-7000-8000-0000000d0e22'),
      payload: {
        ...e.payload,
        id,
        sourceId: id,
        clientRequestId: null,
        requestHash: null,
        ...patch,
      },
    };
  };
  const pull = (events: SyncedEventDto[]) => {
    clock.advance(1_000n);
    hub.pullService.applySyncPullBatch({
      context: {
        organizationId: parseUuidV7(ctx.o),
        storeId: parseUuidV7(ctx.s),
        deviceId: parseUuidV7(ctx.d),
      },
      events,
      nextCursors: {},
      nowMs: unixMsFromBigInt(BigInt(clock.now())),
    });
  };
  return {
    hub,
    clock,
    owner,
    manager: await login('mgr', '739104'),
    cashier: await login('kassa', '582914'),
    customer,
    n,
    outboxEvent,
    pull,
    clone,
    one,
  };
}

const list = async (env: Env, token: string, status = 'open') =>
  env.hub.app.inject({
    method: 'GET',
    url: `/sync/conflicts?status=${status}`,
    headers: hdr(token),
  });
const resolve = async (env: Env, token: string, id: string, payload: Record<string, unknown>) =>
  env.hub.app.inject({
    method: 'POST',
    url: `/sync/conflicts/${id}/resolve`,
    headers: hdr(token),
    payload,
  });
const code = (res: { json: () => unknown }) => ApiErrorEnvelopeSchema.parse(res.json()).error.code;

/** Every row of the business tables, to prove a resolve changes no data. */
function dataHash(env: Env): string {
  return ['customer_ledger', 'customers', 'sales', 'stock_moves', 'local_customer_balances']
    .map((t) =>
      JSON.stringify(
        env.hub.connection.sqlite.prepare(`SELECT * FROM "${t}" ORDER BY id`).all(),
        (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v),
      ),
    )
    .join('|');
}

describe('T2.6 sync conflicts API (view, retry, acknowledge — never edit)', () => {
  it('overpayment: listed for the manager, acknowledge only, audited, not raised again; cashier 403', async () => {
    const env = await boot(4101);
    try {
      const payment = env.outboxEvent(
        "entity = 'customer_ledger' AND json_extract(payload, '$.entryType') = 'debt_payment'",
      );
      env.pull([env.clone(payment, {})]); // store B took the same debt
      expect((await list(env, env.cashier)).statusCode).toBe(403);
      const res = await list(env, env.manager);
      expect(res.statusCode).toBe(200);
      const conflicts = SyncConflictListResponseSchema.parse(res.json()).conflicts;
      const overpaid = conflicts.find((c) => c.reason === 'CUSTOMER_OVERPAID')!;
      expect(overpaid).toMatchObject({
        origin: 'projection',
        entity: 'customers',
        entityId: env.customer,
        allowedActions: ['acknowledge'],
      });

      expect(
        (await resolve(env, env.cashier, overpaid.id, { action: 'acknowledge' })).statusCode,
      ).toBe(403);
      const retry = await resolve(env, env.manager, overpaid.id, { action: 'retry' });
      expect(retry.statusCode).toBe(409);
      expect(code(retry)).toBe('SYNC_CONFLICT_ACTION_NOT_ALLOWED');

      const before = dataHash(env);
      const ack = await resolve(env, env.manager, overpaid.id, {
        action: 'acknowledge',
        note: 'Egasi bilan gaplashildi',
      });
      expect(ack.statusCode, ack.body).toBe(200);
      const acked = ResolveSyncConflictResponseSchema.parse(ack.json());
      expect(acked.conflict).toMatchObject({
        resolution: 'acknowledged',
        resolutionNote: 'Egasi bilan gaplashildi',
        allowedActions: [],
      });
      expect(acked.conflict.resolvedByUserId).not.toBeNull();
      expect(dataHash(env)).toBe(before);

      const again = await resolve(env, env.manager, overpaid.id, { action: 'acknowledge' });
      expect(again.statusCode).toBe(409);
      expect(code(again)).toBe('SYNC_CONFLICT_ALREADY_RESOLVED');

      // Recomputed (the customer is touched again) with the same overpaid amount: not raised again.
      env.pull([
        env.clone(payment, {
          entryType: 'adjustment',
          sourceType: 'adjustment',
          amountDelta: '1',
          paymentMethod: null,
          providerRef: null,
          cashMoveId: null,
          reason: 'x',
        }),
        env.clone(payment, {
          entryType: 'adjustment',
          sourceType: 'adjustment',
          amountDelta: '-1',
          paymentMethod: null,
          providerRef: null,
          cashMoveId: null,
          reason: 'x',
        }),
      ]);
      const open = SyncConflictListResponseSchema.parse((await list(env, env.manager)).json());
      expect(open.conflicts.filter((c) => c.reason === 'CUSTOMER_OVERPAID')).toEqual([]);
      const resolved = SyncConflictListResponseSchema.parse(
        (await list(env, env.owner, 'resolved')).json(),
      );
      expect(resolved.conflicts.map((c) => c.id)).toContain(overpaid.id);
    } finally {
      await env.hub.close();
    }
  });

  it('a failed projection key: retry recomputes it and closes the conflict as "retried"', async () => {
    const env = await boot(4102);
    try {
      env.hub.connection.sqlite.exec(
        `CREATE TRIGGER t_boom BEFORE UPDATE ON local_customer_balances
         BEGIN SELECT RAISE(ABORT, 'boom'); END`,
      );
      const payment = env.outboxEvent(
        "entity = 'customer_ledger' AND json_extract(payload, '$.entryType') = 'debt_payment'",
      );
      env.pull([
        env.clone(payment, {
          entryType: 'adjustment',
          sourceType: 'adjustment',
          amountDelta: '5000',
          paymentMethod: null,
          providerRef: null,
          cashMoveId: null,
          reason: 'Tuzatish',
        }),
      ]);
      const failed = SyncConflictListResponseSchema.parse(
        (await list(env, env.manager)).json(),
      ).conflicts.find((c) => c.reason === 'PROJECTION_FAILED')!;
      expect(failed.allowedActions).toEqual(['retry', 'acknowledge']);

      const stillBroken = ResolveSyncConflictResponseSchema.parse(
        (await resolve(env, env.manager, failed.id, { action: 'retry' })).json(),
      );
      expect(stillBroken.applied).toBe(false);
      expect(stillBroken.conflict.resolvedAtMs).toBeNull();

      env.hub.connection.sqlite.exec('DROP TRIGGER t_boom');
      const fixed = ResolveSyncConflictResponseSchema.parse(
        (await resolve(env, env.manager, failed.id, { action: 'retry', note: 'Tuzatildi' })).json(),
      );
      expect(fixed.applied).toBe(true);
      expect(fixed.conflict).toMatchObject({ resolution: 'retried', resolutionNote: 'Tuzatildi' });
      expect(
        BigInt(
          env.one<{ balance: bigint }>(
            'SELECT balance FROM local_customer_balances WHERE customer_id = ?',
            env.customer,
          ).balance,
        ),
      ).toBe(5000n);
    } finally {
      await env.hub.close();
    }
  });

  it('a pulled event in conflict: retry re-applies the stored envelope; failing again re-opens it with the error', async () => {
    const env = await boot(4103);
    try {
      const payment = env.outboxEvent(
        "entity = 'customer_ledger' AND json_extract(payload, '$.entryType') = 'debt_payment'",
      );
      const first = env.clone(payment, {});
      env.pull([first]);
      // The same fact id arrives again with different content: FACT_CONTENT_HASH_MISMATCH.
      env.pull([
        {
          ...first,
          eventId: parseUuidV7('01993400-0000-7000-8000-00000000f00d'),
          payload: { ...first.payload, providerRef: 'OTHER' },
        },
      ]);
      const c = SyncConflictListResponseSchema.parse(
        (await list(env, env.manager)).json(),
      ).conflicts.find((x) => x.reason === 'FACT_CONTENT_HASH_MISMATCH')!;
      expect(c).toMatchObject({ origin: 'pull', allowedActions: ['retry', 'acknowledge'] });
      const r = ResolveSyncConflictResponseSchema.parse(
        (await resolve(env, env.manager, c.id, { action: 'retry' })).json(),
      );
      expect(r.applied).toBe(false);
      expect(r.conflict.resolvedAtMs).toBeNull();
      expect(r.conflict.reason).toBe('FACT_CONTENT_HASH_MISMATCH');
    } finally {
      await env.hub.close();
    }
  });

  it('S8: a pulled event whose retry now parks (its parent row is missing) keeps the conflict open and reports applied=false', async () => {
    const env = await boot(4106);
    try {
      const payment = env.outboxEvent(
        "entity = 'customer_ledger' AND json_extract(payload, '$.entryType') = 'debt_payment'",
      );
      const orphan = env.clone(payment, {
        customerId: '01993400-0000-7000-8000-0000000c0de0', // no such customer on this hub
      });
      const json = JSON.stringify(orphan, (_k, v: unknown) =>
        typeof v === 'bigint' ? v.toString() : v,
      );
      env.hub.connection.sqlite
        .prepare(
          `INSERT INTO local_sync_conflicts (id, organization_id, store_id, event_id, entity, entity_id, reason, error, payload, event_json, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, 'VALIDATION_ERROR', 'X', '{}', ?, ?, ?)`,
        )
        .run(
          env.n(),
          orphan.organizationId,
          orphan.storeId,
          orphan.eventId,
          orphan.entity,
          orphan.entityId,
          json,
          T0,
          T0,
        );
      const c = SyncConflictListResponseSchema.parse(
        (await list(env, env.manager)).json(),
      ).conflicts.find((x) => x.eventId === orphan.eventId)!;
      expect(c).toMatchObject({ origin: 'pull', allowedActions: ['retry', 'acknowledge'] });
      const before = dataHash(env);
      const r = ResolveSyncConflictResponseSchema.parse(
        (await resolve(env, env.manager, c.id, { action: 'retry', note: 'qayta' })).json(),
      );
      expect(r.applied).toBe(false);
      expect(r.conflict.resolvedAtMs).toBeNull();
      expect(r.conflict.resolution).toBeNull();
      expect(r.conflict.error).toBe('Still waiting for a referenced row');
      expect(
        Number(
          env.one<{ n: number | bigint }>(
            'SELECT count(*) AS n FROM local_sync_parked WHERE event_id = ?',
            orphan.eventId,
          ).n,
        ),
      ).toBe(1);
      expect(
        SyncConflictListResponseSchema.parse((await list(env, env.manager)).json()).conflicts.some(
          (x) => x.id === c.id,
        ),
      ).toBe(true);
      expect(dataHash(env)).toBe(before);
    } finally {
      await env.hub.close();
    }
  });

  it('a rejected push: retry puts the SAME event id back in the outbox queue', async () => {
    const env = await boot(4104);
    try {
      const ev = env.outboxEvent("entity = 'customers'");
      env.hub.connection.sqlite
        .prepare("UPDATE local_outbox SET status = 'rejected', last_error = 'X' WHERE id = ?")
        .run(ev.eventId);
      env.hub.connection.sqlite
        .prepare(
          `INSERT INTO local_sync_conflicts (id, organization_id, store_id, event_id, entity, entity_id, reason, error, payload, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, 'VALIDATION_ERROR', 'X', '{}', ?, ?)`,
        )
        .run(env.n(), ev.organizationId, ev.storeId, ev.eventId, ev.entity, ev.entityId, T0, T0);
      const c = SyncConflictListResponseSchema.parse(
        (await list(env, env.manager)).json(),
      ).conflicts.find((x) => x.origin === 'push')!;
      const r = ResolveSyncConflictResponseSchema.parse(
        (await resolve(env, env.manager, c.id, { action: 'retry' })).json(),
      );
      expect(r.conflict.resolution).toBe('retried');
      expect(
        env.one<{ status: string }>('SELECT status FROM local_outbox WHERE id = ?', ev.eventId)
          .status,
      ).toBe('pending');
    } finally {
      await env.hub.close();
    }
  });

  it('no data editing: the body is strict; unknown ids 404; parked list answers the manager', async () => {
    const env = await boot(4105);
    try {
      const payment = env.outboxEvent(
        "entity = 'customer_ledger' AND json_extract(payload, '$.entryType') = 'debt_payment'",
      );
      env.pull([env.clone(payment, {})]);
      const c = SyncConflictListResponseSchema.parse((await list(env, env.manager)).json())
        .conflicts[0];
      const edit = await resolve(env, env.manager, c.id, {
        action: 'acknowledge',
        payload: { amountDelta: '0' },
      });
      expect(edit.statusCode).toBe(400);
      expect((await resolve(env, env.manager, c.id, { action: 'delete' })).statusCode).toBe(400);
      const missing = await resolve(env, env.manager, '01993400-0000-7000-8000-00000000dead', {
        action: 'acknowledge',
      });
      expect(missing.statusCode).toBe(404);
      const parked = await env.hub.app.inject({
        method: 'GET',
        url: '/sync/parked',
        headers: hdr(env.manager),
      });
      expect(parked.statusCode).toBe(200);
      expect(SyncParkedListResponseSchema.parse(parked.json()).parked).toEqual([]);
      expect(
        (
          await env.hub.app.inject({
            method: 'GET',
            url: '/sync/parked',
            headers: hdr(env.cashier),
          })
        ).statusCode,
      ).toBe(403);
    } finally {
      await env.hub.close();
    }
  });
});

describe('T2.5 bootstrap endpoints', () => {
  it('status for manager/owner (cashier 403); an unpaired hub reports not_paired and stays loadable', async () => {
    const env = await boot(4106);
    try {
      const get = (token: string) =>
        env.hub.app.inject({ method: 'GET', url: '/sync/bootstrap', headers: hdr(token) });
      expect((await get(env.cashier)).statusCode).toBe(403);
      const st = await get(env.manager);
      expect(st.statusCode).toBe(200);
      expect(st.json()).toEqual({ state: 'none', pagesApplied: 0 });
      const run = await env.hub.app.inject({
        method: 'POST',
        url: '/sync/bootstrap',
        headers: hdr(env.owner),
      });
      expect(run.statusCode, run.body).toBe(200);
      expect(run.json()).toMatchObject({ stoppedBecause: 'not_paired', state: 'none' });
    } finally {
      await env.hub.close();
    }
  });
});
