import { describe, expect, it } from 'vitest';
import { UZ_LATN_MESSAGES, t } from './index.js';

describe('@mezon/i18n — Uzbek Latin POS dictionary', () => {
  it('interpolates parameters and keeps non-fiscal banner exact', () => {
    expect(t('receipt.nonFiscalBanner')).toBe('SINOV — FISKAL EMAS');
    expect(t('auth.rateLimited', { seconds: 42 })).toBe(
      'Koʻp xato urinish! 42 soniyadan keyin qayta urining.',
    );
    expect(Object.keys(UZ_LATN_MESSAGES).length).toBeGreaterThan(80);
  });
});
