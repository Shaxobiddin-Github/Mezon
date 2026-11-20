import { type I18nKey, type Locale, UZ_LATN_MESSAGES, getLocale, t } from '@mezon/i18n';
import { formatMilliToQtyString, formatTiyinToSom } from '@mezon/ui';
import { AdminApiError } from '../api-client.js';

/** Store time zone: every date the owner sees is Tashkent time, not the browser's. */
export const STORE_TIME_ZONE = 'Asia/Tashkent';

const INTL_LOCALE: Record<Locale, string> = {
  'uz-Latn': 'uz-Latn-UZ',
  'uz-Cyrl': 'uz-Cyrl-UZ',
  ru: 'ru-RU',
};

/**
 * Money in so'm with the localized currency word. Reuses the POS formatter from `@mezon/ui`
 * (pure bigint, keeps the sign; the previous local helper printed -50 tiyin as "0.50").
 */
export function formatSom(tiyin: string | null | undefined): string {
  if (tiyin === null || tiyin === undefined || tiyin === '') return '—';
  try {
    return `${formatTiyinToSom(tiyin)} ${t('common.currency')}`;
  } catch {
    return '—';
  }
}

/**
 * T2.7b: a price typed in so'm (`12500`, `12 500`, `12500.5`, `12500,50`) → tiyin as a decimal
 * string, without float math. Null when it is not a valid non-negative amount.
 */
export function parseSomToTiyin(input: string): string | null {
  const s = input.replace(/[\s ]/g, '').replace(',', '.');
  const m = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const tiyin = BigInt(m[1]) * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0');
  return tiyin.toString();
}

/** Quantity from milli-units without float math (`1500` → `1.5`). */
export function formatQty(milli: string): string {
  try {
    return formatMilliToQtyString(milli);
  } catch {
    return milli;
  }
}

export function formatDateTime(msStr: string | null | undefined): string {
  if (!msStr) return '—';
  const ms = Number(msStr);
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleString(INTL_LOCALE[getLocale()], {
    timeZone: STORE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** `YYYY-MM-DD` of an instant in Tashkent (the report day boundary), not in UTC. */
export function tashkentDateKey(ms: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: STORE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Localized message for a failed API call. */
export function describeApiError(err: unknown): string {
  if (err instanceof AdminApiError && err.status === 403) return t('admin.login.cashierForbidden');
  if (err instanceof AdminApiError && err.status === 429) return t('admin.login.locked');
  return t('admin.error.load');
}

function isI18nKey(key: string): key is I18nKey {
  return Object.prototype.hasOwnProperty.call(UZ_LATN_MESSAGES, key);
}

/** Localized unit (`kg`, `dona`, ...) with the raw code as fallback. */
export function unitLabel(unit: string): string {
  const key = `unit.${unit}`;
  return isI18nKey(key) ? t(key) : unit;
}

/** Localized payment method name with the raw code as fallback. */
export function paymentMethodLabel(method: string): string {
  const key = `payment.method.${method}`;
  return isI18nKey(key) ? t(key) : method;
}
