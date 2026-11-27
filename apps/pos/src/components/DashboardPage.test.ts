import { describe, expect, it } from 'vitest';
import { markupPercent, percentChange, shortSom } from './DashboardPage.js';

describe('C23 dashboard numbers', () => {
  it('short amounts for the chart', () => {
    expect(shortSom('9700000')).toBe('97 ming');
    expect(shortSom('123456700')).toBe('1,2 mln');
    expect(shortSom('200000000')).toBe('2 mln');
    expect(shortSom('250000000000')).toBe('2,5 mlrd');
    expect(shortSom('50000')).toBe('500');
  });

  it('change against yesterday, none when yesterday was empty', () => {
    expect(percentChange('12000', '10000')).toBe(20);
    expect(percentChange('7000', '10000')).toBe(-30);
    expect(percentChange('5000', '0')).toBeNull();
  });

  it('markup of shelf over purchase value', () => {
    expect(markupPercent('3267520000', '4084400000')).toBe(25);
    expect(markupPercent(null, '100')).toBeNull();
    expect(markupPercent('0', '100')).toBeNull();
  });
});
