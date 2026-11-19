import { setLocale } from '@mezon/i18n';
import { afterEach, describe, expect, it } from 'vitest';
import { licenceBannerText } from './LicenceBanner.js';

const base = { plan: null, daysLeft: null, invalidLicence: false, fetchedAtMs: null } as const;

describe('@mezon/pos - licence banner (T4.7)', () => {
  afterEach(() => setLocale('uz-Latn'));

  it('silent when unknown, active with time left, or trial with more than 3 days', () => {
    expect(licenceBannerText(null)).toBeNull();
    expect(licenceBannerText({ ...base, state: 'unknown' })).toBeNull();
    expect(licenceBannerText({ ...base, state: 'active', plan: 'start', daysLeft: 20 })).toBeNull();
    expect(licenceBannerText({ ...base, state: 'trial', daysLeft: 4 })).toBeNull();
  });

  it('warns when ending soon, in grace, expired, or invalid — and says sales continue', () => {
    expect(licenceBannerText({ ...base, state: 'trial', daysLeft: 3 })).toContain('3 kundan');
    expect(licenceBannerText({ ...base, state: 'grace', daysLeft: 5 })).toContain(
      'Savdo davom etadi',
    );
    expect(licenceBannerText({ ...base, state: 'expired' })).toContain('Savdo davom etadi');
    expect(licenceBannerText({ ...base, state: 'active', invalidLicence: true })).toContain(
      'tekshiruvdan',
    );
    setLocale('ru');
    expect(licenceBannerText({ ...base, state: 'expired' })).toContain('Продажи продолжаются');
  });
});
