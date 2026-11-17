import { describe, expect, it } from 'vitest';
import {
  FISCAL_DOC_STATUSES,
  FISCAL_DOC_TRANSITIONS,
  type FiscalDocStatus,
  type FiscalReceiptFieldConfig,
  canVoidWithFiscalStatus,
  isFiscalDocTransitionAllowed,
  resolveReceiptFiscalBlock,
} from './fiscal.js';

const ALLOWED: readonly (readonly [FiscalDocStatus, FiscalDocStatus])[] = [
  ['pending', 'sent'],
  ['pending', 'cancelled'],
  ['sent', 'confirmed'],
  ['sent', 'rejected'],
  ['sent', 'failed'],
  ['failed', 'sent'],
  ['failed', 'cancelled'],
  ['rejected', 'cancelled'],
];

describe('T3.3 FISCAL_DOC_TRANSITIONS', () => {
  it('allows exactly the approved transitions and nothing else (all 36 pairs)', () => {
    for (const from of FISCAL_DOC_STATUSES) {
      for (const to of FISCAL_DOC_STATUSES) {
        const expected = ALLOWED.some(([f, t]) => f === from && t === to);
        expect(isFiscalDocTransitionAllowed(from, to), `${from}->${to}`).toBe(expected);
      }
    }
  });

  it('confirmed and cancelled are terminal; sent can never be cancelled; no confirm without sent', () => {
    expect(FISCAL_DOC_TRANSITIONS.confirmed).toEqual([]);
    expect(FISCAL_DOC_TRANSITIONS.cancelled).toEqual([]);
    expect(isFiscalDocTransitionAllowed('sent', 'cancelled')).toBe(false);
    expect(isFiscalDocTransitionAllowed('pending', 'confirmed')).toBe(false);
    expect(isFiscalDocTransitionAllowed('failed', 'confirmed')).toBe(false);
    expect(isFiscalDocTransitionAllowed('confirmed', 'pending')).toBe(false);
  });

  it('void table: pending/failed/rejected/none → allowed; sent/confirmed/cancelled → not', () => {
    expect(canVoidWithFiscalStatus(null)).toBe(true);
    expect(canVoidWithFiscalStatus('pending')).toBe(true);
    expect(canVoidWithFiscalStatus('failed')).toBe(true);
    expect(canVoidWithFiscalStatus('rejected')).toBe(true);
    expect(canVoidWithFiscalStatus('sent')).toBe(false);
    expect(canVoidWithFiscalStatus('confirmed')).toBe(false);
    expect(canVoidWithFiscalStatus('cancelled')).toBe(false);
  });
});

describe('T3.4 resolveReceiptFiscalBlock', () => {
  const fields: FiscalReceiptFieldConfig[] = [
    { key: 'fiscalSign', label: 'SINTETIK-A' },
    { key: 'fiscalNumber', label: 'SINTETIK-B' },
  ];
  const full = { fiscalSign: 'SINOV-S1', fiscalNumber: 'SINOV-N1' };

  it('confirmed + every configured field + QR → FISCAL with rows in config order', () => {
    const b = resolveReceiptFiscalBlock({
      status: 'confirmed',
      values: full,
      qrPayload: 'SINOV|1',
      fields,
      isTestDriver: false,
    });
    expect(b.mark).toBe('FISCAL');
    expect(b.rows).toEqual([
      { label: 'SINTETIK-A', value: 'SINOV-S1' },
      { label: 'SINTETIK-B', value: 'SINOV-N1' },
    ]);
    expect(b.qrPayload).toBe('SINOV|1');
  });

  it('a missing field, a blank field, a missing QR or an EMPTY config → never FISCAL', () => {
    const base = { status: 'confirmed' as const, isTestDriver: false };
    expect(
      resolveReceiptFiscalBlock({ ...base, values: { fiscalSign: 'X' }, qrPayload: 'Q', fields })
        .mark,
    ).toBe('FISCAL_INCOMPLETE');
    expect(
      resolveReceiptFiscalBlock({
        ...base,
        values: { ...full, fiscalNumber: '  ' },
        qrPayload: 'Q',
        fields,
      }).mark,
    ).toBe('FISCAL_INCOMPLETE');
    expect(resolveReceiptFiscalBlock({ ...base, values: full, qrPayload: null, fields }).mark).toBe(
      'FISCAL_INCOMPLETE',
    );
    expect(
      resolveReceiptFiscalBlock({ ...base, values: full, qrPayload: 'Q', fields: [] }).mark,
    ).toBe('FISCAL_INCOMPLETE');
    const inc = resolveReceiptFiscalBlock({
      ...base,
      values: { fiscalSign: 'X' },
      qrPayload: 'Q',
      fields,
    });
    expect(inc.rows).toEqual([]);
    expect(inc.qrPayload).toBeNull();
  });

  it('pending/sent/failed → FISCAL_PENDING; none/rejected/cancelled → NOT_FISCAL; test banner kept', () => {
    for (const status of ['pending', 'sent', 'failed'] as const) {
      expect(
        resolveReceiptFiscalBlock({
          status,
          values: full,
          qrPayload: 'Q',
          fields,
          isTestDriver: true,
        }),
      ).toEqual({ mark: 'FISCAL_PENDING', testBanner: true, rows: [], qrPayload: null });
    }
    for (const status of [null, 'rejected', 'cancelled'] as const) {
      expect(
        resolveReceiptFiscalBlock({
          status,
          values: full,
          qrPayload: 'Q',
          fields,
          isTestDriver: false,
        }).mark,
      ).toBe('NOT_FISCAL');
    }
    expect(
      resolveReceiptFiscalBlock({
        status: 'confirmed',
        values: full,
        qrPayload: 'Q',
        fields,
        isTestDriver: true,
      }).testBanner,
    ).toBe(true);
  });
});
