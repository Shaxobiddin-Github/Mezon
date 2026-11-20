import { useEffect, useState } from 'react';
import type { LicenceStatusResponseDto } from '@mezon/contracts';
import { t } from '@mezon/i18n';
import type { HubApiClient } from '../api/hub-client.js';

/**
 * T4.7: tells the cashier when the plan is about to end or has ended. Purely informative —
 * sales are never blocked by the licence.
 */
export function licenceBannerText(s: LicenceStatusResponseDto | null): string | null {
  if (!s) return null;
  if (s.invalidLicence) return t('pos.licence.invalid');
  if (s.state === 'expired') return t('pos.licence.expired');
  if (s.state === 'grace') return t('pos.licence.grace', { days: s.daysLeft ?? 0 });
  if ((s.state === 'trial' || s.state === 'active') && s.daysLeft !== null && s.daysLeft <= 3) {
    return t('pos.licence.endsSoon', { days: s.daysLeft });
  }
  return null;
}

export function LicenceBanner(props: { readonly api: HubApiClient }) {
  const { api } = props;
  const [status, setStatus] = useState<LicenceStatusResponseDto | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      api
        .getLicenceStatus()
        .then((s) => {
          if (!cancelled) setStatus(s);
        })
        .catch(() => undefined);
    };
    load();
    const id = window.setInterval(load, 10 * 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [api]);

  const text = licenceBannerText(status);
  if (!text) return null;
  return (
    <div className="pos-error-banner" role="status" data-testid="licence-banner">
      {text}
    </div>
  );
}
