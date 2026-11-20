import React, { useEffect, useState } from 'react';
import { type I18nKey, t } from '@mezon/i18n';
import { type LicenceInfo, adminApi } from '../api-client.js';
import { formatSom } from '../utils/format.js';

const PLAN_KEY: Record<'start' | 'business' | 'pro', I18nKey> = {
  start: 'admin.licence.plan.start',
  business: 'admin.licence.plan.business',
  pro: 'admin.licence.plan.pro',
};

const INVOICE_KEY: Record<'issued' | 'paid' | 'void', I18nKey> = {
  issued: 'admin.licence.invoice.issued',
  paid: 'admin.licence.invoice.paid',
  void: 'admin.licence.invoice.void',
};

/** T4.7: plan, days left, usage against limits, and the last platform invoices. */
export const LicenceCard: React.FC = () => {
  const [info, setInfo] = useState<LicenceInfo | null>(null);

  useEffect(() => {
    void adminApi
      .getLicence()
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);

  if (!info) return null;

  const plan = info.plan ? t(PLAN_KEY[info.plan]) : '';
  const days = info.daysLeft ?? 0;
  const message =
    info.state === 'trial'
      ? t('admin.licence.trial', { days })
      : info.state === 'active'
        ? t('admin.licence.active', { plan, days })
        : info.state === 'grace'
          ? t('admin.licence.grace', { plan, days })
          : t('admin.licence.expired');
  const tone =
    info.state === 'expired'
      ? 'border-red-300 bg-red-50 text-red-900'
      : info.state === 'grace' || (info.daysLeft !== null && info.daysLeft <= 3)
        ? 'border-amber-300 bg-amber-50 text-amber-900'
        : 'border-slate-200 bg-white text-slate-800';
  const limit = (v: number | null) => (v === null ? t('admin.licence.unlimited') : String(v));

  return (
    <div
      data-testid="admin-licence-card"
      className={`rounded-xl border shadow-sm p-4 space-y-1 text-sm ${tone}`}
    >
      <div className="font-semibold">{t('admin.licence.title')}</div>
      <div>{message}</div>
      {info.invalidLicence && <div className="text-red-700">{t('admin.licence.invalid')}</div>}
      <div className="text-xs opacity-80">
        {t('admin.licence.usage', {
          stores: info.usage.stores,
          maxStores: limit(info.limits.maxStores),
          devices: info.usage.devices,
          maxDevices: limit(info.limits.maxDevices),
        })}
      </div>
      {info.invoices.slice(0, 3).map((inv) => (
        <div key={inv.period} className="text-xs opacity-80">
          {t('admin.licence.invoice', {
            period: inv.period,
            amount: formatSom(inv.amountTiyin),
            status: t(INVOICE_KEY[inv.status]),
          })}
        </div>
      ))}
    </div>
  );
};
