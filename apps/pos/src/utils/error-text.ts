import { type I18nKey, UZ_LATN_MESSAGES, t } from '@mezon/i18n';
import { HubApiError } from '../api/hub-client.js';

function isKnownKey(key: string): key is I18nKey {
  return Object.prototype.hasOwnProperty.call(UZ_LATN_MESSAGES, key);
}

/**
 * C11: a hub error shown to a cashier in their language. A known code uses its `error.<CODE>`
 * text; an unknown one gets a generic sentence with the code (never the English server message).
 */
export function describeHubError(err: unknown): string {
  if (err instanceof HubApiError) {
    if (err.code === 'BARCODE_NOT_FOUND') {
      const rawCode = err.details?.['barcode'];
      return t('error.BARCODE_NOT_FOUND', { code: typeof rawCode === 'string' ? rawCode : '' });
    }
    if (err.isNetworkError) return t('error.network');
    const key = `error.${err.code}`;
    if (isKnownKey(key)) return t(key);
    return t('error.generic', { code: err.code });
  }
  return err instanceof Error ? err.message : String(err);
}
