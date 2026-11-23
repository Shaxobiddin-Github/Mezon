import React, { useEffect, useState } from 'react';
import type { AdminDashboardResponseDto } from '@mezon/contracts';
import { t } from '@mezon/i18n';
import { adminApi } from '../api-client.js';
import { describeApiError, formatDateTime, formatSom } from '../utils/format.js';
import { LicenceCard } from './LicenceCard.js';
import { TelegramCard } from './TelegramCard.js';
import { Icon, type IconName } from './Icon.js';

export const DashboardView: React.FC = () => {
  const [data, setData] = useState<AdminDashboardResponseDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showProfit, setShowProfit] = useState(false);

  const loadDashboard = async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await adminApi.getDashboard());
    } catch (err: unknown) {
      setError(describeApiError(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadDashboard();
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64 text-slate-400">
        {t('common.loading')}
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-6 bg-red-50 text-red-700 rounded-lg border border-red-200">
        <p className="font-semibold">{t('admin.error.title')}</p>
        <p className="text-sm mt-1">{error}</p>
        <button
          onClick={() => {
            void loadDashboard();
          }}
          className="mt-4 px-3 py-1.5 bg-red-600 text-white rounded text-xs hover:bg-red-700"
        >
          {t('common.retry')}
        </button>
      </div>
    );
  }

  // A2: figures come from what the tills have synced; say so next to the numbers when a till is silent.
  const staleStores = data.stores.filter((s) => s.isStale);

  const kpis: ReadonlyArray<{
    readonly key: string;
    readonly label: string;
    readonly value: string;
    readonly hint: string;
    readonly icon: IconName;
    readonly tone: string;
    readonly valueTone?: string;
  }> = [
    {
      key: 'net',
      label: t('admin.dashboard.netSales'),
      value: formatSom(data.netSales),
      hint: t('admin.dashboard.gross', { amount: formatSom(data.grossSales) }),
      icon: 'wallet',
      tone: 'bg-indigo-50 text-indigo-600',
    },
    {
      key: 'receipts',
      label: t('admin.dashboard.receipts'),
      value: t('admin.dashboard.receiptsCount', { count: data.receiptsCount }),
      hint: t('admin.dashboard.avgReceipt', { amount: formatSom(data.avgReceipt) }),
      icon: 'receipt',
      tone: 'bg-sky-50 text-sky-600',
    },
    {
      key: 'returns',
      label: t('admin.dashboard.returns'),
      value: formatSom(data.returnsTotal),
      hint: t('admin.dashboard.returnsHint'),
      icon: 'return',
      tone: 'bg-rose-50 text-rose-600',
      valueTone: data.returnsTotal === '0' ? undefined : 'text-rose-600',
    },
    {
      key: 'profit',
      label: t('admin.dashboard.grossProfit'),
      value: showProfit ? formatSom(data.grossProfit) : '••••••',
      hint: showProfit
        ? t('admin.dashboard.margin', {
            value:
              data.marginBp !== null && data.marginBp !== undefined
                ? `${(data.marginBp / 100).toFixed(1)}%`
                : '—',
          })
        : t('admin.dashboard.hidden'),
      icon: 'trend',
      tone: 'bg-emerald-50 text-emerald-600',
      valueTone: showProfit ? 'text-emerald-600' : 'text-slate-300',
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="page-title">{t('admin.dashboard.title')}</h2>
          <p className="page-subtitle">{t('admin.dashboard.date', { date: data.todayDate })}</p>
        </div>

        <div className="flex items-center gap-2">
          <button onClick={() => setShowProfit(!showProfit)} className="btn btn-outline">
            <Icon name="eye" className="h-4 w-4" />
            {showProfit ? t('admin.dashboard.hideProfit') : t('admin.dashboard.showProfit')}
          </button>
          <button
            onClick={() => {
              void loadDashboard();
            }}
            className="btn btn-soft"
          >
            <Icon name="refresh" className="h-4 w-4" />
            {t('admin.refresh')}
          </button>
        </div>
      </div>

      {staleStores.length > 0 && (
        <div
          role="status"
          data-testid="admin-stale-warning"
          className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
          {t('admin.dashboard.staleWarning', {
            stores: staleStores.map((s) => s.storeName).join(', '),
          })}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        {kpis.map((k) => (
          <div key={k.key} className="card p-4 sm:p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-slate-500 sm:text-sm">{k.label}</span>
              <span
                className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl sm:h-10 sm:w-10 ${k.tone}`}
              >
                <Icon name={k.icon} />
              </span>
            </div>
            <div
              className={`mt-3 break-words text-lg font-bold tracking-tight tabular-nums sm:text-2xl ${k.valueTone ?? 'text-slate-900'}`}
            >
              {k.value}
            </div>
            <div className="mt-1 text-xs text-slate-500">{k.hint}</div>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="flex items-center gap-2 border-b border-slate-100 px-6 py-4">
          <Icon name="store" className="h-5 w-5 text-slate-400" />
          <h3 className="text-base font-semibold text-slate-900">{t('admin.dashboard.stores')}</h3>
        </div>
        {data.stores.length === 0 ? (
          <p className="px-6 py-8 text-center text-sm text-slate-500">
            {t('admin.dashboard.noStores')}
          </p>
        ) : (
          <div className="divide-y divide-slate-100">
            {data.stores.map((s) => (
              <div key={s.storeId} className="flex items-center justify-between gap-3 px-6 py-4">
                <div className="flex items-center gap-3">
                  <span className="grid h-10 w-10 place-items-center rounded-xl bg-slate-100 text-sm font-bold text-slate-600">
                    {s.storeName.trim().charAt(0).toUpperCase()}
                  </span>
                  <div>
                    <div className="text-sm font-semibold text-slate-800">{s.storeName}</div>
                    <div className="mt-0.5 text-xs text-slate-500">
                      {s.lastEventAtMs
                        ? t('admin.dashboard.lastSync', { time: formatDateTime(s.lastEventAtMs) })
                        : t('admin.dashboard.neverSynced')}
                    </div>
                  </div>
                </div>

                {s.isStale ? (
                  <span className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800 ring-1 ring-amber-200">
                    <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-amber-500" />
                    {t('admin.dashboard.stale')}
                  </span>
                ) : (
                  <span className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800 ring-1 ring-emerald-200">
                    <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    {t('admin.dashboard.online')}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <LicenceCard />
        <TelegramCard />
      </div>
    </div>
  );
};
