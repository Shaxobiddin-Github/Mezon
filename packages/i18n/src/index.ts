import { RU_MESSAGES } from './locales/ru.js';
import { type I18nKey, UZ_LATN_MESSAGES } from './locales/uz-Latn.js';
import { latnToCyrl } from './translit.js';

export const I18N_PACKAGE = '@mezon/i18n';
export { UZ_LATN_MESSAGES, RU_MESSAGES, latnToCyrl, type I18nKey };

/** T4.6: supported UI languages. `uz-Latn` is the source of truth and the fallback. */
export const SUPPORTED_LOCALES = ['uz-Latn', 'uz-Cyrl', 'ru'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'uz-Latn';

export const LOCALE_LABELS: Readonly<Record<Locale, string>> = {
  'uz-Latn': 'Oʻzbekcha',
  'uz-Cyrl': 'Ўзбекча',
  ru: 'Русский',
};

export type TranslationParams = Readonly<Record<string, string | number>>;
export type MessageDictionary = Readonly<Record<I18nKey, string>>;

let cyrlCache: MessageDictionary | null = null;

function buildCyrl(): MessageDictionary {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(UZ_LATN_MESSAGES)) {
    out[key] = latnToCyrl(value);
  }
  return out as MessageDictionary;
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export function getMessages(locale: Locale): MessageDictionary {
  if (locale === 'ru') return RU_MESSAGES;
  if (locale === 'uz-Cyrl') {
    cyrlCache ??= buildCyrl();
    return cyrlCache;
  }
  return UZ_LATN_MESSAGES;
}

let currentLocale: Locale = DEFAULT_LOCALE;

export function setLocale(locale: Locale): void {
  if (!isLocale(locale)) {
    throw new Error(`Unsupported locale: ${String(locale)}`);
  }
  currentLocale = locale;
}

export function getLocale(): Locale {
  return currentLocale;
}

export function t(
  key: I18nKey,
  params?: TranslationParams,
  locale: Locale = currentLocale,
): string {
  const template = getMessages(locale)[key];
  if (!params) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (_match, token: string) => {
    const val = params[token];
    return val !== undefined ? String(val) : `{${token}}`;
  });
}
