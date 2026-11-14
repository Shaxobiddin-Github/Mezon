import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ApiErrorEnvelopeSchema,
  CartResponseSchema,
  CompleteSaleResponseSchema,
  ListReceiptPrintsResponseSchema,
  LoginResponseSchema,
  OpenCashDrawerResponseSchema,
  PrintDocumentResponseSchema,
  PrinterSettingsResponseSchema,
} from '@mezon/contracts';
import type { PinHasher } from '@mezon/domain';
import { FakePrinterDriver, encodeCashDrawerPulse } from '@mezon/drivers';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { createHubServer } from './server.js';

const tempDirs: string[] = [];
const TEST_PORT = 47912;
const HOST_HEADER = `127.0.0.1:${TEST_PORT}`;

const fastHasher: PinHasher = {
  hash: (pin) => Promise.resolve(`stub:${pin}`),
  verify: (stored, pin) => Promise.resolve(stored === `stub:${pin}`),
};

function hostHeaders(): Record<string, string> {
  return { host: HOST_HEADER };
}
function authHeaders(token: string): Record<string, string> {
  return { host: HOST_HEADER, authorization: `Bearer ${token}` };
}
function endsWithPulse(bytes: Uint8Array): boolean {
  const pulse = encodeCashDrawerPulse(0);
  if (bytes.length < pulse.length) return false;
  const offset = bytes.length - pulse.length;
  return pulse.every((b, i) => bytes[offset + i] === b);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});

describe('@mezon/hub - T1.12 printer API', () => {
  it('prints once per clientRequestId (P1), guards LAN host (P2), marks NUSXA, survives printer failure, gates cash drawer', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-hub-printer-'));
    tempDirs.push(dir);
    const fake = new FakePrinterDriver({ mode: 'network_tcp', target: '192.168.1.200:9100' });
    const hub = await createHubServer({
      dbPath: path.join(dir, 'hub.db'),
      port: TEST_PORT,
      clock: new FixedClock(1_762_840_000_000n),
      random: new SeededRandomSource(1201),
      pinHasher: fastHasher,
      logLevel: 'silent',
      printerDriverFactory: () => fake,
    });
    let n = 1;
    const req = () => `01991200-0000-7000-8000-${(n++).toString(16).padStart(12, '0')}`;
    try {
      await hub.app.inject({
        method: 'POST',
        url: '/setup',
        headers: hostHeaders(),
        payload: { owner: { fullName: 'Egasi', username: 'owner', pin: '849201' } },
      });
      const login = async (username: string, pin: string) =>
        LoginResponseSchema.parse(
          (
            await hub.app.inject({
              method: 'POST',
              url: '/auth/login',
              headers: hostHeaders(),
              payload: { username, pin },
            })
          ).json(),
        ).token;
      const owner = await login('owner', '849201');
      await hub.app.inject({
        method: 'POST',
        url: '/users',
        headers: authHeaders(owner),
        payload: { fullName: 'Kassir', username: 'kassa', role: 'cashier', pin: '374829' },
      });
      const cashier = await login('kassa', '374829');

      // RBAC: cashier reads settings but cannot change them
      expect(
        (
          await hub.app.inject({
            method: 'GET',
            url: '/printer/settings',
            headers: authHeaders(cashier),
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await hub.app.inject({
            method: 'PATCH',
            url: '/printer/settings',
            headers: authHeaders(cashier),
            payload: { paperWidthMm: 58 },
          })
        ).statusCode,
      ).toBe(403);

      // P2: public IP and hostnames are rejected; LAN IPv4 accepted
      for (const host of ['8.8.8.8', 'example.com']) {
        const res = await hub.app.inject({
          method: 'PATCH',
          url: '/printer/settings',
          headers: authHeaders(owner),
          payload: { mode: 'network_tcp', host, port: 9100 },
        });
        expect(res.statusCode).toBe(400);
        expect(ApiErrorEnvelopeSchema.parse(res.json()).error.code).toBe('VALIDATION_ERROR');
      }
      const ok = await hub.app.inject({
        method: 'PATCH',
        url: '/printer/settings',
        headers: authHeaders(owner),
        payload: {
          mode: 'network_tcp',
          host: '192.168.1.200',
          port: 9100,
          receiptHeaderTitle: "GUZAR DO'KON",
        },
      });
      expect(ok.statusCode).toBe(200);
      expect(PrinterSettingsResponseSchema.parse(ok.json()).settings.host).toBe('192.168.1.200');

      // Open shift and make a cash sale
      expect(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/shifts/open',
            headers: authHeaders(cashier),
            payload: { clientRequestId: req(), openingCash: '1000000' },
          })
        ).statusCode,
      ).toBe(201);
      const sell = async (price: string, payments: unknown[]) => {
        const cart = CartResponseSchema.parse(
          (
            await hub.app.inject({
              method: 'POST',
              url: '/carts',
              headers: authHeaders(cashier),
              payload: {},
            })
          ).json(),
        ).cart;
        await hub.app.inject({
          method: 'POST',
          url: `/carts/${cart.id}/lines`,
          headers: authHeaders(cashier),
          payload: {
            kind: 'quick_sale',
            name: 'Qoʻshimcha non',
            unit: 'dona',
            qty: '1000',
            unitPrice: price,
          },
        });
        const res = await hub.app.inject({
          method: 'POST',
          url: `/carts/${cart.id}/complete`,
          headers: authHeaders(cashier),
          payload: { clientRequestId: req(), expectedTotal: price, payments },
        });
        expect(res.statusCode).toBe(200);
        return CompleteSaleResponseSchema.parse(res.json()).sale;
      };
      const sale = await sell('1500000', [{ method: 'cash', tenderedAmount: '2000000' }]);

      // First print: original copy, drawer pulse appended for cash sale
      const printReq = req();
      const first = await hub.app.inject({
        method: 'POST',
        url: `/sales/${sale.id}/print`,
        headers: authHeaders(cashier),
        payload: { clientRequestId: printReq },
      });
      expect(first.statusCode).toBe(200);
      const firstBody = PrintDocumentResponseSchema.parse(first.json());
      expect(firstBody.printRecord.status).toBe('printed');
      expect(firstBody.printRecord.copyNumber).toBe(1);
      expect(firstBody.printRecord.isReprint).toBe(false);
      expect(firstBody.printRecord.textPreview).toContain('SINOV');
      expect(firstBody.printRecord.textPreview).not.toContain('NUSXA');
      expect(fake.getSentJobs()).toHaveLength(1);
      expect(endsWithPulse(fake.getSentJobs()[0].bytes)).toBe(true);

      // P1: same clientRequestId twice (sequential and parallel) -> no new paper, same record
      const replays = await Promise.all(
        [0, 1, 2].map(() =>
          hub.app.inject({
            method: 'POST',
            url: `/sales/${sale.id}/print`,
            headers: authHeaders(cashier),
            payload: { clientRequestId: printReq },
          }),
        ),
      );
      for (const r of replays) {
        const b = PrintDocumentResponseSchema.parse(r.json());
        expect(b.idempotentReplay).toBe(true);
        expect(b.printRecord.id).toBe(firstBody.printRecord.id);
      }
      expect(fake.getSentJobs()).toHaveLength(1);

      // P1 parallel with a fresh id: still exactly one new job
      const parallelId = req();
      await Promise.all(
        [0, 1].map(() =>
          hub.app.inject({
            method: 'POST',
            url: `/sales/${sale.id}/print`,
            headers: authHeaders(cashier),
            payload: { clientRequestId: parallelId },
          }),
        ),
      );
      expect(fake.getSentJobs()).toHaveLength(2);
      const prints = ListReceiptPrintsResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'GET',
            url: `/sales/${sale.id}/prints`,
            headers: authHeaders(cashier),
          })
        ).json(),
      ).prints;
      expect(prints).toHaveLength(2);
      const reprint = prints.find((p) => p.clientRequestId === parallelId)!;
      expect(reprint.isReprint).toBe(true);
      expect(reprint.copyNumber).toBe(2);
      expect(reprint.textPreview).toContain('NUSXA');
      // reprint never opens the drawer again
      expect(endsWithPulse(fake.getSentJobs()[1].bytes)).toBe(false);

      // Printer failure: sale stays, print recorded as failed, next sale works
      fake.setSimulateFailure({ errorCode: 'PRINTER_OFFLINE', errorMessage: 'Printer ulanmagan' });
      const sale2 = await sell('500000', [{ method: 'card', amount: '500000' }]);
      const failed = PrintDocumentResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: `/sales/${sale2.id}/print`,
            headers: authHeaders(cashier),
            payload: { clientRequestId: req() },
          })
        ).json(),
      );
      expect(failed.printRecord.status).toBe('failed');
      expect(failed.printRecord.errorCode).toBe('PRINTER_OFFLINE');
      fake.setSimulateFailure(null);
      const retry = PrintDocumentResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: `/sales/${sale2.id}/print`,
            headers: authHeaders(cashier),
            payload: { clientRequestId: req() },
          })
        ).json(),
      );
      // a failed attempt does not count as a copy: the retry is still the original
      expect(retry.printRecord.status).toBe('printed');
      expect(retry.printRecord.copyNumber).toBe(1);
      expect(retry.printRecord.isReprint).toBe(false);
      await sell('300000', [{ method: 'cash', tenderedAmount: '300000' }]);

      // Cash drawer: cashier needs supervisor PIN; manager/owner direct; idempotent
      const noOverride = await hub.app.inject({
        method: 'POST',
        url: '/printer/cash-drawer/open',
        headers: authHeaders(cashier),
        payload: { clientRequestId: req(), reason: 'Maydalash' },
      });
      expect(noOverride.statusCode).toBe(403);
      expect(ApiErrorEnvelopeSchema.parse(noOverride.json()).error.code).toBe(
        'SUPERVISOR_OVERRIDE_REQUIRED',
      );
      const drawerId = req();
      const jobsBefore = fake.getSentJobs().length;
      const withOverride = OpenCashDrawerResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/printer/cash-drawer/open',
            headers: authHeaders(cashier),
            payload: {
              clientRequestId: drawerId,
              reason: 'Maydalash',
              override: { username: 'owner', pin: '849201' },
            },
          })
        ).json(),
      );
      expect(withOverride.event.overrideApprovedByUserId).not.toBeNull();
      expect(withOverride.event.status).toBe('printed');
      const drawerReplay = OpenCashDrawerResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/printer/cash-drawer/open',
            headers: authHeaders(owner),
            payload: { clientRequestId: drawerId, reason: 'Maydalash' },
          })
        ).json(),
      );
      expect(drawerReplay.idempotentReplay).toBe(true);
      expect(fake.getSentJobs().length).toBe(jobsBefore + 1);
    } finally {
      await hub.close();
    }
  });
});
