import { DomainError, type UnixMs } from '@mezon/domain';

/**
 * Formats a Unix millisecond timestamp as `YYYY-MM-DD` in a concrete IANA timezone via `Intl`.
 */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();
const DAY_KEYS = new Map<string, string>();
/** Every real UTC offset is a multiple of 15 minutes, so a 15-minute slot never spans two days. */
const SLOT_MS = 15 * 60 * 1000;
const DAY_KEY_CACHE_LIMIT = 50_000;

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = FORMATTERS.get(tz);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    FORMATTERS.set(tz, f);
  }
  return f;
}

export function resolveIntlDateKey(ms: UnixMs, tz: string): string {
  // Reports call this once per row; building an Intl formatter per call made a 31-day cloud
  // report on 50k receipts take ~15 s. The formatter is cached per zone and the result per slot.
  const slot = Math.floor(Number(ms) / SLOT_MS);
  const cacheKey = `${tz}|${slot}`;
  const cached = DAY_KEYS.get(cacheKey);
  if (cached !== undefined) return cached;

  const parts = formatterFor(tz).formatToParts(new Date(slot * SLOT_MS));
  const year = parts.find((p) => p.type === 'year')?.value ?? '';
  const month = parts.find((p) => p.type === 'month')?.value ?? '';
  const day = parts.find((p) => p.type === 'day')?.value ?? '';
  if (!year || !month || !day) {
    throw new DomainError('VALIDATION_ERROR', `Unable to format date in timezone "${tz}"`);
  }
  const key = `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  if (DAY_KEYS.size >= DAY_KEY_CACHE_LIMIT) DAY_KEYS.clear();
  DAY_KEYS.set(cacheKey, key);
  return key;
}
