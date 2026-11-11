import { describe, expect, it } from 'vitest';
import {
  formatMilliToQtyString,
  formatTiyinToSom,
  parseQtyInputToMilliString,
  parseSomInputToTiyinString,
  stepMilliQuantity,
  tiyinToSomInputString,
} from './index.js';

describe('@mezon/ui — pure bigint money and quantity formatting helpers', () => {
  it('formats and parses UZS soʻm <-> tiyin without floating point', () => {
    expect(formatTiyinToSom('0')).toBe('0');
    expect(formatTiyinToSom('1500000')).toBe('15 000');
    expect(formatTiyinToSom('1500050')).toBe('15 000.50');
    expect(formatTiyinToSom('-250000')).toBe('-2 500');

    expect(tiyinToSomInputString('1500000')).toBe('15000');
    expect(tiyinToSomInputString('1500050')).toBe('15000.50');

    expect(parseSomInputToTiyinString('15 000')).toBe('1500000');
    expect(parseSomInputToTiyinString('15000,5')).toBe('1500050');
    expect(parseSomInputToTiyinString('0')).toBe('0');
  });

  it('formats and parses milli quantities with unit integrity', () => {
    expect(formatMilliToQtyString('1000')).toBe('1');
    expect(formatMilliToQtyString('5500')).toBe('5.5');
    expect(formatMilliToQtyString('125')).toBe('0.125');

    expect(parseQtyInputToMilliString('5.5', 'kg')).toBe('5500');
    expect(parseQtyInputToMilliString('2', 'dona')).toBe('2000');
    expect(() => parseQtyInputToMilliString('1.5', 'dona')).toThrow();

    expect(stepMilliQuantity('1000', 1)).toBe('2000');
    expect(stepMilliQuantity('2000', -1)).toBe('1000');
    expect(stepMilliQuantity('1000', -1)).toBe('1000');
  });
});
