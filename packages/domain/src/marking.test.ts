import { describe, expect, it } from 'vitest';
import {
  GS,
  gtinToEan13,
  isValidGtin14,
  looksLikeMarkingCode,
  markedUnitsFromQtyMilli,
  parseMarkingCode,
} from './marking.js';

// EAN-13 4006381333931 is a well-known valid barcode; as GTIN-14 it gets a leading 0.
const GTIN = '04006381333931';

const code = (serial: string, tail = `${GS}91EE10${GS}92dGVzdGNyeXB0b3RhaWw=`) =>
  `01${GTIN}21${serial}${tail}`;

describe('T3.7 GS1 DataMatrix parsing', () => {
  it.each([
    ['symbology id + GS separators + crypto tail', `]d2${code('ABC123xyz!')}`, 'ABC123xyz!'],
    ['leading FNC1 as GS', `${GS}${code('5RpDq8"aS')}`, '5RpDq8"aS'],
    ['serial last, no tail', `01${GTIN}21SERIAL-0001`, 'SERIAL-0001'],
    ['expiry and batch before the serial', `01${GTIN}17261231` + `10LOT7${GS}21S1`, 'S1'],
    ['CR/LF from the scanner', `${code('X1')}\r\n`, 'X1'],
  ])('%s', (_label, raw, serial) => {
    const p = parseMarkingCode(raw);
    expect(p.gtin).toBe(GTIN);
    expect(p.serial).toBe(serial);
    expect(p.key).toBe(`${GTIN}:${serial}`);
    expect(p.normalized.startsWith(']d2')).toBe(false);
  });

  it('keeps the crypto tail verbatim for the driver', () => {
    const p = parseMarkingCode(code('A1'));
    expect(p.ais['91']).toBe('EE10');
    expect(p.ais['92']).toBe('dGVzdGNyeXB0b3RhaWw=');
  });

  it.each([
    ['wrong GTIN check digit', `01040063813339302100`],
    ['no serial', `01${GTIN}`],
    ['unknown AI', `01${GTIN}99X`],
    ['repeated AI', `01${GTIN}21A${GS}21B`],
    ['short GTIN', `010400638133393`],
    ['empty serial', `01${GTIN}21${GS}91EE10`],
    ['serial too long', `01${GTIN}21${'x'.repeat(21)}`],
    ['control character in serial', `01${GTIN}21AB\x07C`],
  ])('rejects: %s', (_label, raw) => {
    expect(() => parseMarkingCode(raw)).toThrow(/MARKING_CODE_INVALID/);
  });

  it('an EAN / UPC barcode is NOT taken for a marking code (the ordinary scanner keeps working)', () => {
    for (const ean of ['4006381333931', '96385074', '036000291452', GTIN]) {
      expect(looksLikeMarkingCode(ean), ean).toBe(false);
    }
    expect(looksLikeMarkingCode(code('A1'))).toBe(true);
    expect(looksLikeMarkingCode(`]d2${code('A1')}`)).toBe(true);
  });

  it('GTIN helpers', () => {
    expect(isValidGtin14(GTIN)).toBe(true);
    expect(isValidGtin14('04006381333930')).toBe(false);
    expect(gtinToEan13(GTIN)).toBe('4006381333931');
    expect(gtinToEan13('14006381333938')).toBeNull();
  });

  it('one code per unit: units from a milli quantity, fractional quantities have none', () => {
    expect(markedUnitsFromQtyMilli(3000n)).toBe(3n);
    expect(markedUnitsFromQtyMilli(1500n)).toBeNull();
    expect(markedUnitsFromQtyMilli(0n)).toBeNull();
  });
});
