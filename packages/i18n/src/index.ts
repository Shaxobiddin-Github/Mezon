import { type I18nKey, UZ_LATN_MESSAGES } from './locales/uz-Latn.js';

export const I18N_PACKAGE = '@mezon/i18n';
export { UZ_LATN_MESSAGES, type I18nKey };

export type TranslationParams = Readonly<Record<string, string | number>>;

export function t(key: I18nKey, params?: TranslationParams): string {
  const template = UZ_LATN_MESSAGES[key];
  if (!params) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (_match, token: string) => {
    const val = params[token];
    return val !== undefined ? String(val) : `{${token}}`;
  });
}
