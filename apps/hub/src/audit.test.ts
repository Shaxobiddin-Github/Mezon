import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LoginResponseSchema, ProductDetailResponseSchema } from '@mezon/contracts';
import { openLocalSqliteDatabase } from '@mezon/db-local';
import type { PinHasher } from '@mezon/domain';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { createHubServer } from './index.js';

const HOST = '127.0.0.1:47876';
const T0 = BigInt(Date.parse('2026-06-15T05:00:00.000Z')); // 10:00 Tashkent
const fastHasher: PinHasher = {
  hash: (pin) => Promise.resolve(`fast-stub-hash:${pin}`),
  verify: (stored, pin) => Promise.resolve(stored === `fast-stub-hash:${pin}`),
};
const hdr = (t?: string): Record<string, string> =>
  t ? { host: HOST, authorization: `Bearer ${t}` } : { host: HOST };
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});
const CLI = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../packages/db-local/scripts/audit-verify.mjs',
);

describe('T3.8 audit journal through the real hub paths', () => {
  it('every audited operation writes its row in the chain; verify (HTTP + CLI) is ok, and an edit is caught', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-audit-hub-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'hub.db');
    const clock = new FixedClock(T0);
    const hub = await createHubServer({
      dbPath,
      port: 47876,
      logLevel: 'silent',
      clock,
      random: new SeededRandomSource(38),
      pinHasher: fastHasher,
    });
    let n = 0;
    const req = () => `01997100-0000-7000-8000-${(++n).toString(16).padStart(12, '0')}`;
    try {
      await hub.app.inject({
        method: 'POST',
        url: '/setup',
        headers: hdr(),
        payload: { owner: { fullName: 'Egasi', username: 'owner', pin: '849201' } },
      });
      const login = (username: string, pin: string) =>
        hub.app.inject({
          method: 'POST',
          url: '/auth/login',
          headers: hdr(),
          payload: { username, pin },
        });
      expect((await login('owner', '000000')).statusCode).toBe(401); // auth.login_failed
      const owner = LoginResponseSchema.parse((await login('owner', '849201')).json()).token;
      const call = (
        method: 'POST' | 'PATCH' | 'PUT',
        url: string,
        payload: Record<string, unknown>,
      ) => hub.app.inject({ method, url, headers: hdr(owner), payload });

      const mgr = await call('POST', '/users', {
        fullName: 'Menejer',
        username: 'mgr',
        role: 'manager',
        pin: '739104',
      });
      expect(mgr.statusCode).toBe(201);
      const mgrId = mgr.json<{ user: { id: string } }>().user.id;
      expect((await call('PATCH', `/users/${mgrId}`, { role: 'cashier' })).statusCode).toBe(200);

      const product = ProductDetailResponseSchema.parse(
        (
          await call('POST', '/products', { name: 'Olma', unit: 'dona', salePrice: '10000' })
        ).json(),
      ).product.id;
      expect(
        (
          await call('PATCH', `/products/${product}`, {
            salePrice: '12000',
            priceChangeReason: 'Yangi narx',
          })
        ).statusCode,
      ).toBe(200);
      await call('POST', '/stock/moves/in', {
        productId: product,
        reason: 'purchase',
        qty: '9000',
        totalCostValue: '45000',
      });

      const shift = await call('POST', '/shifts/open', {
        clientRequestId: req(),
        openingCash: '0',
      });
      expect(shift.statusCode).toBe(201);
      const shiftId = shift.json<{ shift: { id: string } }>().shift.id;
      expect(
        (
          await call('POST', `/shifts/${shiftId}/cash-moves`, {
            clientRequestId: req(),
            type: 'cash_in',
            amount: '50000',
            reason: 'Maydalash',
          })
        ).statusCode,
      ).toBe(201);

      const sell = async (withDiscount: boolean) => {
        const cartId = (await call('POST', '/carts', {})).json<{ cart: { id: string } }>().cart.id;
        await call('POST', `/carts/${cartId}/lines`, {
          kind: 'catalog',
          productId: product,
          qty: '1000',
        });
        let total = '12000';
        if (withDiscount) {
          const d = await call('PUT', `/carts/${cartId}/discount`, {
            mode: 'percent',
            percentBp: 500,
            reason: 'Doimiy mijoz',
            override: { username: 'owner', pin: '849201' },
          });
          expect(d.statusCode, d.body).toBe(200);
          total = d.json<{ cart: { totalFinal: string } }>().cart.totalFinal;
        }
        const s = await call('POST', `/carts/${cartId}/complete`, {
          clientRequestId: req(),
          expectedTotal: total,
          payments: [{ method: 'cash', tenderedAmount: total }],
        });
        expect(s.statusCode, s.body).toBe(200);
        return s.json<{ sale: { id: string; lines: { id: string }[] } }>().sale;
      };
      const s1 = await sell(true);
      const s2 = await sell(false);
      expect(
        (
          await call('POST', `/sales/${s1.id}/void`, {
            clientRequestId: req(),
            reason: 'Xato chek',
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await call('POST', `/sales/${s2.id}/returns`, {
            clientRequestId: req(),
            reason: 'Mijoz qaytardi',
            items: [{ saleLineId: s2.lines[0].id, qty: '1000' }],
            payments: [{ method: 'cash', amount: '12000' }],
          })
        ).statusCode,
      ).toBe(201);
      const close = await call('POST', `/shifts/${shiftId}/close`, {
        clientRequestId: req(),
        countedCash: '50000',
      });
      expect(close.statusCode, close.body).toBe(200);
      const day = await call('POST', '/day-closes', {
        clientRequestId: req(),
        businessDate: '2026-06-15',
      });
      expect(day.statusCode, day.body).toBe(201);

      // Every audited kind is there, in order, in one chain.
      const list = await hub.app.inject({
        method: 'GET',
        url: '/audit?limit=500',
        headers: hdr(owner),
      });
      expect(list.statusCode).toBe(200);
      const kinds = new Set(
        list.json<{ entries: { eventType: string }[] }>().entries.map((e) => e.eventType),
      );
      for (const k of [
        'auth.login_failed',
        'auth.login',
        'user.created',
        'user.updated',
        'price.changed',
        'shift.opened',
        'shift.cash_move',
        'discount.applied',
        'sale.voided',
        'return.created',
        'shift.closed',
        'day_close.created',
      ]) {
        expect(kinds.has(k), k).toBe(true);
      }
      // Each row points at the exact object it audits.
      const entries = list.json<{
        entries: {
          eventType: string;
          entity: string;
          entityId: string | null;
          details: Record<string, unknown>;
        }[];
      }>().entries;
      const has = (
        eventType: string,
        entity: string,
        entityId: string | null,
        details?: Record<string, unknown>,
      ) =>
        entries.some(
          (e) =>
            e.eventType === eventType &&
            e.entity === entity &&
            e.entityId === entityId &&
            Object.entries(details ?? {}).every(([k, v]) => e.details[k] === v),
        );
      expect(has('sale.voided', 'sales', s1.id, { reason: 'Xato chek' })).toBe(true);
      expect(has('return.created', 'returns', null)).toBe(false);
      expect(
        entries.some((e) => e.eventType === 'return.created' && e.details.saleId === s2.id),
      ).toBe(true);
      expect(
        has('price.changed', 'products', product, { oldPrice: '10000', newPrice: '12000' }),
      ).toBe(true);
      expect(has('user.updated', 'users', mgrId, { roleFrom: 'manager', roleTo: 'cashier' })).toBe(
        true,
      );
      expect(has('shift.opened', 'shifts', shiftId)).toBe(true);
      expect(has('shift.closed', 'shifts', shiftId)).toBe(true);
      expect(entries.filter((e) => e.eventType === 'sale.voided')).toHaveLength(1);
      // No secret ever lands in the journal.
      expect(list.body).not.toContain('849201');
      expect(list.body).not.toContain('739104');

      const verify = await hub.app.inject({
        method: 'GET',
        url: '/audit/verify',
        headers: hdr(owner),
      });
      expect(verify.json()).toMatchObject({ ok: true, firstBrokenSeq: null });
      const cashier = LoginResponseSchema.parse((await login('mgr', '739104')).json()).token;
      expect(
        (await hub.app.inject({ method: 'GET', url: '/audit/verify', headers: hdr(cashier) }))
          .statusCode,
      ).toBe(403);
    } finally {
      await hub.close();
    }

    // The verification command on the closed database.
    const ok = spawnSync(process.execPath, [CLI, dbPath], { encoding: 'utf8' });
    expect(ok.status, ok.stderr).toBe(0);
    // Someone edits a row directly in the file: the command fails and names the row.
    const raw = openLocalSqliteDatabase(dbPath);
    raw.sqlite.exec('DROP TRIGGER "trg_local_audit_log_no_update"');
    raw.sqlite.exec(`UPDATE local_audit_log SET details_json = '[]' WHERE seq = 3`);
    raw.close();
    const bad = spawnSync(process.execPath, [CLI, dbPath], { encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain('"firstBrokenSeq":"3"');
  });
});
