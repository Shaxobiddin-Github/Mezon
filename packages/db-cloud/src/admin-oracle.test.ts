import { unixMsFromBigInt } from '@mezon/domain';
import { describe, expect, it } from 'vitest';
import { resolveIntlDateKey } from './timezone.js';

/**
 * ishchi2 review of PR #29 (T2.7a): independent oracle for the cached day-key resolver that every
 * cloud report bucket depends on. The implementation caches per 15-minute slot; the oracle formats
 * EVERY timestamp from scratch with a fresh `Intl.DateTimeFormat` (no cache, no slots), so a wrong
 * slot assumption (offsets / DST changes not on a 15-minute grid) shows up as a different day.
 */
function oracleDayKey(ms: number, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** mulberry32 — deterministic. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ZONES = [
  'Asia/Tashkent', // the product zone, UTC+5, no DST
  'Asia/Kathmandu', // +05:45
  'Asia/Kolkata', // +05:30
  'Australia/Lord_Howe', // 30-minute DST shift
  'America/St_Johns', // -03:30 with DST
  'Pacific/Chatham', // +12:45 / +13:45
  'Europe/London',
  'UTC',
];

describe('ishchi2 oracle: resolveIntlDateKey equals an uncached Intl day key', () => {
  it('random timestamps 2000–2040 in odd-offset and DST zones', () => {
    const rnd = prng(29);
    const from = Date.UTC(2000, 0, 1);
    const span = Date.UTC(2040, 0, 1) - from;
    for (const tz of ZONES) {
      for (let i = 0; i < 4000; i += 1) {
        const ms = from + Math.floor(rnd() * span);
        expect(resolveIntlDateKey(unixMsFromBigInt(BigInt(ms)), tz), `${tz} ${ms}`).toBe(
          oracleDayKey(ms, tz),
        );
      }
    }
  });

  it('every minute around local midnight, around DST switches, and the 1 ms edges', () => {
    const cases: [string, number][] = [
      ['Asia/Tashkent', Date.UTC(2026, 5, 15, 19, 0, 0)], // 00:00 Tashkent
      ['Asia/Kathmandu', Date.UTC(2026, 5, 15, 18, 15, 0)], // 00:00 Kathmandu
      ['Australia/Lord_Howe', Date.UTC(2026, 3, 4, 14, 0, 0)], // DST end weekend
      ['America/St_Johns', Date.UTC(2026, 2, 8, 5, 30, 0)], // DST start
      ['Pacific/Chatham', Date.UTC(2026, 3, 4, 13, 0, 0)],
    ];
    for (const [tz, center] of cases) {
      for (let m = -180; m <= 180; m += 1) {
        for (const delta of [-1, 0, 1]) {
          const ms = center + m * 60_000 + delta;
          expect(resolveIntlDateKey(unixMsFromBigInt(BigInt(ms)), tz), `${tz} ${ms}`).toBe(
            oracleDayKey(ms, tz),
          );
        }
      }
    }
  });
});
