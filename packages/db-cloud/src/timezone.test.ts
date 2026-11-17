import { unixMsFromBigInt } from '@mezon/domain';
import { describe, expect, it } from 'vitest';
import { resolveIntlDateKey } from './timezone.js';

const at = (iso: string) => unixMsFromBigInt(BigInt(Date.parse(iso)));

describe('@mezon/db-cloud - resolveIntlDateKey (cached)', () => {
  it('splits the Tashkent day exactly at local midnight, also on repeated (cached) calls', () => {
    for (let round = 0; round < 2; round += 1) {
      expect(resolveIntlDateKey(at('2024-11-10T18:59:59.999Z'), 'Asia/Tashkent')).toBe(
        '2024-11-10',
      );
      expect(resolveIntlDateKey(at('2024-11-10T19:00:00.000Z'), 'Asia/Tashkent')).toBe(
        '2024-11-11',
      );
    }
  });

  it('handles a 45-minute offset zone (the 15-minute slot never spans two days)', () => {
    // Asia/Kathmandu is UTC+5:45: local midnight is 18:15 UTC.
    expect(resolveIntlDateKey(at('2024-11-10T18:14:59.999Z'), 'Asia/Kathmandu')).toBe('2024-11-10');
    expect(resolveIntlDateKey(at('2024-11-10T18:15:00.000Z'), 'Asia/Kathmandu')).toBe('2024-11-11');
  });

  it('the same instant in different zones is not mixed up by the cache', () => {
    const ms = at('2024-11-10T20:00:00.000Z');
    expect(resolveIntlDateKey(ms, 'Asia/Tashkent')).toBe('2024-11-11');
    expect(resolveIntlDateKey(ms, 'UTC')).toBe('2024-11-10');
    expect(resolveIntlDateKey(ms, 'America/New_York')).toBe('2024-11-10');
  });
});
