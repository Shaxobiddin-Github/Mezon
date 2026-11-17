import { createHash } from 'node:crypto';
import {
  type FiscalDocStatus,
  type FiscalReceiptFieldConfig,
  resolveReceiptFiscalBlock,
} from '@mezon/domain';
import { describe, expect, it } from 'vitest';
import { ESC_POS_QR_MAX_BYTES, encodeEscPosDocument, encodeEscPosQr } from './escpos-encoder.js';
import type { SaleReceiptDocument } from './types.js';

/** Synthetic configuration: labels/values are NOT a real operator format (§3.3). */
const FIELDS: FiscalReceiptFieldConfig[] = [
  { key: 'fiscalSign', label: 'SINTETIK-FB' },
  { key: 'fiscalNumber', label: 'SINTETIK-FD' },
];
const VALUES = { fiscalSign: 'SINOV-FB-000001', fiscalNumber: 'SINOV-FD-000001' };
const QR = 'SINOV|01993300-0000-7000-8000-000000000001|000001';

const baseSale: SaleReceiptDocument = {
  kind: 'sale',
  headerTitle: 'GUZAR KASSA',
  footerText: 'Xaridingiz uchun rahmat!',
  receiptNo: 7n,
  receiptCode: 'R-0007',
  shiftCode: 'S-0001',
  cashierName: 'Kassir',
  customerName: null,
  formattedDateTime: '2026-11-17 10:00',
  copyNumber: 1,
  isReprint: false,
  lines: [
    {
      lineNo: 1,
      itemName: 'Mahsulot',
      isQuickSale: false,
      unit: 'dona',
      qtyMilli: 1000n,
      unitPriceTiyin: 100000n,
      grossTotalTiyin: 100000n,
      promoDiscountTiyin: 0n,
      allocatedOrderDiscountTiyin: 0n,
      finalTotalTiyin: 100000n,
      vatRateBp: 1200,
      vatTotalTiyin: 10714n,
    },
  ],
  subtotalGrossTiyin: 100000n,
  promoDiscountTotalTiyin: 0n,
  orderDiscountTotalTiyin: 0n,
  totalFinalTiyin: 100000n,
  totalVatTiyin: 10714n,
  paidAmountTiyin: 100000n,
  debtAmountTiyin: 0n,
  changeAmountTiyin: 0n,
  payments: [
    { method: 'cash', amountTiyin: 100000n, tenderedAmountTiyin: 100000n, providerRef: null },
  ],
  openCashDrawer: false,
};

function receipt(
  status: FiscalDocStatus | null,
  opts: { values?: Record<string, string>; qr?: string | null; test?: boolean } = {},
) {
  return {
    ...baseSale,
    fiscal: resolveReceiptFiscalBlock({
      status,
      values: opts.values ?? VALUES,
      qrPayload: opts.qr === undefined ? QR : opts.qr,
      fields: FIELDS,
      isTestDriver: opts.test ?? false,
    }),
  };
}

const GS_K = [0x1d, 0x28, 0x6b];
function hasQrCommand(bytes: Uint8Array): boolean {
  for (let i = 0; i + 2 < bytes.length; i += 1) {
    if (bytes[i] === GS_K[0] && bytes[i + 1] === GS_K[1] && bytes[i + 2] === GS_K[2]) return true;
  }
  return false;
}
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe('T3.4 fiscal receipt byte snapshots (58 / 80 mm)', () => {
  const cases: [string, ReturnType<typeof receipt>][] = [
    ['confirmed', receipt('confirmed')],
    ['confirmed-test-driver', receipt('confirmed', { test: true })],
    ['incomplete-field', receipt('confirmed', { values: { fiscalSign: 'SINOV-FB-000001' } })],
    ['incomplete-qr', receipt('confirmed', { qr: null })],
    ['pending', receipt('pending')],
    ['failed', receipt('failed')],
    ['rejected', receipt('rejected')],
  ];
  for (const width of [58, 80] as const) {
    for (const [name, doc] of cases) {
      it(`${name} @ ${String(width)}mm`, () => {
        const out = encodeEscPosDocument({
          document: doc,
          paperWidthMm: width,
          encoding: 'translit',
        });
        expect({ preview: out.textPreview, sha256: sha(out.bytes) }).toMatchSnapshot();
      });
    }
  }

  it('F5: FISKAL CHEK only when every configured field AND the QR exist; QR bytes only then', () => {
    const ok = encodeEscPosDocument({
      document: receipt('confirmed'),
      paperWidthMm: 80,
      encoding: 'translit',
    });
    expect(ok.textPreview).toContain('FISKAL CHEK');
    expect(ok.textPreview).toContain('SINTETIK-FB:');
    expect(hasQrCommand(ok.bytes)).toBe(true);
    for (const doc of [
      receipt('confirmed', { values: { fiscalSign: 'X' } }),
      receipt('confirmed', { qr: null }),
      receipt('pending'),
      receipt('rejected'),
      receipt(null),
    ]) {
      const out = encodeEscPosDocument({ document: doc, paperWidthMm: 80, encoding: 'translit' });
      expect(out.textPreview).not.toContain('FISKAL CHEK');
      expect(hasQrCommand(out.bytes)).toBe(false);
    }
  });

  it('QR payload is embedded VERBATIM (opaque UTF-8) between store and print commands', () => {
    const out = encodeEscPosDocument({
      document: receipt('confirmed'),
      paperWidthMm: 58,
      encoding: 'translit',
    });
    const data = new TextEncoder().encode(QR);
    const hex = Buffer.from(out.bytes).toString('hex');
    const store = Buffer.from([0x1d, 0x28, 0x6b, (data.length + 3) & 0xff, 0x00, 0x31, 0x50, 0x30]);
    expect(hex).toContain(store.toString('hex') + Buffer.from(data).toString('hex'));
    expect(hex).toContain('1d286b030031430' + '4'); // 58 mm → module size 4
  });

  it('test driver keeps "SINOV — FISKAL EMAS" whatever the state; a real driver does not print it', () => {
    const t = encodeEscPosDocument({
      document: receipt('confirmed', { test: true }),
      paperWidthMm: 80,
      encoding: 'translit',
    });
    expect(t.textPreview).toContain('SINOV');
    const r = encodeEscPosDocument({
      document: receipt('confirmed', { test: false }),
      paperWidthMm: 80,
      encoding: 'translit',
    });
    expect(r.textPreview).not.toContain('SINOV —');
  });
});

describe('T3.4 encodeEscPosQr boundaries', () => {
  it('rejects 0 bytes and > 7089 bytes; accepts exactly 7089 with correct length bytes', () => {
    expect(() => encodeEscPosQr('', 6)).toThrow(RangeError);
    expect(() => encodeEscPosQr('A'.repeat(ESC_POS_QR_MAX_BYTES + 1), 6)).toThrow(RangeError);
    const max = encodeEscPosQr('A'.repeat(ESC_POS_QR_MAX_BYTES), 6);
    const storeAt = 3 + 9 + 8 + 8; // center + model + size + ecc
    expect([...max.subarray(storeAt, storeAt + 8)]).toEqual([
      0x1d,
      0x28,
      0x6b,
      (ESC_POS_QR_MAX_BYTES + 3) & 0xff,
      (ESC_POS_QR_MAX_BYTES + 3) >> 8,
      0x31,
      0x50,
      0x30,
    ]);
    const one = encodeEscPosQr('Q', 6);
    expect([...one.subarray(storeAt, storeAt + 9)]).toEqual([
      0x1d, 0x28, 0x6b, 4, 0, 0x31, 0x50, 0x30, 0x51,
    ]);
  });

  it('counts UTF-8 bytes, not characters', () => {
    const cyr = 'Ў'.repeat(Math.floor(ESC_POS_QR_MAX_BYTES / 2)); // 2 bytes each
    expect(() => encodeEscPosQr(cyr, 6)).not.toThrow();
    expect(() => encodeEscPosQr(`${cyr}ЎЎ`, 6)).toThrow(RangeError);
  });
});
