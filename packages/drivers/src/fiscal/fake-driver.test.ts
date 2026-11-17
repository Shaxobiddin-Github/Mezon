import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileFakeFiscalLedgerStore } from '../node/fake-fiscal-ledger-file.js';
import { FakeFiscalDriver } from './fake-driver.js';
import { type FiscalSubmitRequest, isFiscalDriverError } from './fiscal-driver.js';

const req = (key: string): FiscalSubmitRequest => ({
  kind: 'sale',
  idempotencyKey: key,
  docId: `doc-${key}`,
  saleId: key,
  returnId: null,
  shiftId: null,
});

describe('T3.3 FakeFiscalDriver', () => {
  it('100 repeated submits of one key yield ONE sign; submitCount counts every arrival (F8)', async () => {
    const d = new FakeFiscalDriver();
    const first = await d.submit(req('k1'));
    for (let i = 0; i < 99; i += 1) {
      expect(await d.submit(req('k1'))).toEqual(first);
    }
    expect(d.submitCount('k1')).toBe(100);
    expect(d.ledgerKeys()).toEqual(['k1']);
    const other = await d.submit(req('k2'));
    expect(other).not.toEqual(first);
    if (first.outcome !== 'confirmed' || other.outcome !== 'confirmed') throw new Error('confirm');
    expect(first.confirmation.fiscalSign).toMatch(/^SINOV-/);
    expect(first.confirmation.qrPayload).toMatch(/^SINOV\|k1\|/);
    expect(other.confirmation.fiscalSign).not.toBe(first.confirmation.fiscalSign);
  });

  it('error classification: offline=definitelyNotSent and timeout=outcomeUnknown leave no ledger entry', async () => {
    const d = new FakeFiscalDriver();
    d.queueSubmitModes('offline', 'timeout');
    const e1 = await d.submit(req('k')).catch((e: unknown) => e);
    const e2 = await d.submit(req('k')).catch((e: unknown) => e);
    expect(isFiscalDriverError(e1) && e1.kind).toBe('definitelyNotSent');
    expect(isFiscalDriverError(e2) && e2.kind).toBe('outcomeUnknown');
    expect(d.submitCount('k')).toBe(0);
    expect(await d.status('k')).toEqual({ state: 'notFound' });
    expect(d.totalSubmitAttempts()).toBe(2);
  });

  it('throw-after-accept records the receipt then throws outcomeUnknown; status() reveals it', async () => {
    let hook = 0;
    const d = new FakeFiscalDriver({ onAcceptedBeforeReply: () => (hook += 1) });
    d.queueSubmitModes('throw-after-accept');
    const err = await d.submit(req('k')).catch((e: unknown) => e);
    expect(isFiscalDriverError(err) && err.kind).toBe('outcomeUnknown');
    expect(hook).toBe(1);
    expect(d.submitCount('k')).toBe(1);
    const st = await d.status('k');
    expect(st.state).toBe('confirmed');
  });

  it('reject is remembered: status() answers rejected and a resubmit does not confirm', async () => {
    const d = new FakeFiscalDriver({ submitMode: 'reject' });
    const r = await d.submit(req('k'));
    expect(r.outcome).toBe('rejected');
    d.setSubmitMode('ok');
    expect((await d.submit(req('k'))).outcome).toBe('rejected');
    expect((await d.status('k')).state).toBe('rejected');
  });

  it('status/ping offline fail with outcomeUnknown', async () => {
    const d = new FakeFiscalDriver({ statusMode: 'offline' });
    const e = await d.status('k').catch((x: unknown) => x);
    expect(isFiscalDriverError(e) && e.kind).toBe('outcomeUnknown');
    await expect(d.ping()).rejects.toThrow();
    d.setStatusMode('ok');
    await expect(d.ping()).resolves.toBeUndefined();
  });

  it('file ledger survives a new driver instance (crash test basis)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-fake-fiscal-'));
    try {
      const file = path.join(dir, 'ledger.json');
      const a = new FakeFiscalDriver({ ledgerStore: new FileFakeFiscalLedgerStore(file) });
      const r = await a.submit(req('k'));
      const b = new FakeFiscalDriver({ ledgerStore: new FileFakeFiscalLedgerStore(file) });
      expect(b.submitCount('k')).toBe(1);
      const st = await b.status('k');
      expect(st.state === 'confirmed' && r.outcome === 'confirmed' && st.confirmation).toEqual(
        r.outcome === 'confirmed' ? r.confirmation : null,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
