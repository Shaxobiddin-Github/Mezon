import { describe, expect, it } from 'vitest';
import {
  normalizeSpreadsheetDecimal,
  parseSpreadsheetMoneyTiyin,
  parseSpreadsheetQuantityMilli,
  parseSpreadsheetVatPercentBp,
} from './excel-port.js';

/**
 * T3.1 (S4): float-free spreadsheet parsing built on the domain decimal parsers.
 */
describe('T3.1 Excel decimal parsing without floats', () => {
  it('normalizes grouping spaces (incl. NBSP / narrow NBSP) and a single decimal comma', () => {
    expect(normalizeSpreadsheetDecimal('1 500,50')).toBe('1500.50');
    expect(normalizeSpreadsheetDecimal('1 500,5')).toBe('1500.5');
    expect(normalizeSpreadsheetDecimal('1 234 567')).toBe('1234567');
    expect(normalizeSpreadsheetDecimal('1500.5')).toBe('1500.5');
    // Mixed separators stay ambiguous and are rejected by the parser below.
    expect(normalizeSpreadsheetDecimal('1,500.50')).toBe('1,500.50');
  });

  it('money: exact tiyin for valid inputs, explicit errors otherwise', () => {
    expect(parseSpreadsheetMoneyTiyin('1 500,50')).toBe(150_050n);
    expect(parseSpreadsheetMoneyTiyin('1500.5')).toBe(150_050n);
    expect(parseSpreadsheetMoneyTiyin('0.01')).toBe(1n);
    // Numeric Excel cell values arrive via String(number)
    expect(parseSpreadsheetMoneyTiyin(String(1500.5))).toBe(150_050n);
    expect(parseSpreadsheetMoneyTiyin(String(12345))).toBe(1_234_500n);
    // > 2 fraction digits, float artefacts, exponent form, text, mixed separators
    for (const bad of [
      '0.005',
      String(0.1 + 0.2),
      String(1e21),
      'abc',
      '1,500.50',
      '',
      '12.',
      '.5',
    ]) {
      expect(() => parseSpreadsheetMoneyTiyin(bad), bad).toThrow();
    }
    // Negative parses (caller rejects ≤ 0) — sign is preserved exactly, never via float.
    expect(parseSpreadsheetMoneyTiyin('-5')).toBe(-500n);
    // Very large values stay exact as bigint (caller bounds them to int64).
    expect(parseSpreadsheetMoneyTiyin('99999999999999999999')).toBe(99999999999999999999n * 100n);
  });

  it('quantity: exact milli-units', () => {
    expect(parseSpreadsheetQuantityMilli('2,5')).toBe(2_500n);
    expect(parseSpreadsheetQuantityMilli('0.125')).toBe(125n);
    expect(() => parseSpreadsheetQuantityMilli('0.0005')).toThrow();
  });

  it('VAT percent: "12", "12%", "12,5", "0" → basis points; > 100% or 3 decimals rejected', () => {
    expect(parseSpreadsheetVatPercentBp('12')).toBe(1200);
    expect(parseSpreadsheetVatPercentBp('12%')).toBe(1200);
    expect(parseSpreadsheetVatPercentBp('12,5')).toBe(1250);
    expect(parseSpreadsheetVatPercentBp('0')).toBe(0);
    expect(parseSpreadsheetVatPercentBp(String(15))).toBe(1500);
    for (const bad of ['150', '-1', '12.345', 'QQS', '100.01']) {
      expect(() => parseSpreadsheetVatPercentBp(bad), bad).toThrow();
    }
    expect(parseSpreadsheetVatPercentBp('100')).toBe(10_000);
  });
});
