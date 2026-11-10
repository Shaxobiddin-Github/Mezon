import { DomainError, type UnixMs } from '@mezon/domain';

/**
 * Formats a Unix millisecond timestamp as `YYYY-MM-DD` in a concrete IANA timezone via `Intl`.
 * Injected into `@mezon/domain` timezone helpers as an outer adapter (`GEMINI.md` 2.2).
 */
export function resolveIntlDateKey(ms: UnixMs, tz: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(new Date(Number(ms)));
  const year = parts.find((p) => p.type === 'year')?.value ?? '';
  const month = parts.find((p) => p.type === 'month')?.value ?? '';
  const day = parts.find((p) => p.type === 'day')?.value ?? '';
  if (!year || !month || !day) {
    throw new DomainError('VALIDATION_ERROR', `Unable to format date in timezone "${tz}"`);
  }
  return `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}
