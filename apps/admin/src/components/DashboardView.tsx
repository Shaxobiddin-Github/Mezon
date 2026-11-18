import React, { useEffect, useState } from 'react';
import type { AdminDashboardResponseDto } from '@mezon/contracts';
import { t } from '@mezon/i18n';
import { adminApi } from '../api-client.js';
import { describeApiError, formatDateTime, formatSom } from '../utils/format.js';
import { TelegramCard } from './TelegramCard.js';

const CARD = 'bg-white p-5 rounded-xl border border-slate-200 shadow-sm';
const CARD_LABEL = 'text-xs font-semibold text-slate-500 uppercase tracking-wider';

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

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-800">{t('admin.dashboard.title')}</h2>
          <p className="text-xs text-slate-500 mt-1">
            {t('admin.dashboard.date', { date: data.todayDate })}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowProfit(!showProfit)}
            className="text-xs px-3 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50 font-medium text-slate-700 transition-colors"
          >
            {showProfit ? t('admin.dashboard.hideProfit') : t('admin.dashboard.showProfit')}
          </button>
          <button
            onClick={() => {
              void loadDashboard();
            }}
            className="text-xs px-3 py-1.5 rounded-lg bg-indigo-50 text-indigo-700 hover:bg-indigo-100 font-medium transition-colors"
          >
            {t('admin.refresh')}
          </button>
        </div>
      </div>

      <TelegramCard />

      {staleStores.length > 0 && (
        <div
          role="status"
          data-testid="admin-stale-warning"
          className="p-3 rounded-lg border border-amber-300 bg-amber-50 text-amber-900 text-xs"
        >
          {t('admin.dashboard.staleWarning', {
            stores: staleStores.map((s) => s.storeName).join(', '),
          })}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className={CARD}>
          <span className={CARD_LABEL}>{t('admin.dashboard.netSales')}</span>
          <div className="text-2xl font-bold text-slate-900 mt-2">{formatSom(data.netSales)}</div>
          <div className="text-xs text-slate-400 mt-1">
            {t('admin.dashboard.gross', { amount: formatSom(data.grossSales) })}
          </div>
        </div>

        <div className={CARD}>
          <span className={CARD_LABEL}>{t('admin.dashboard.receipts')}</span>
          <div className="text-2xl font-bold text-slate-900 mt-2">
            {t('admin.dashboard.receiptsCount', { count: data.receiptsCount })}
          </div>
          <div className="text-xs text-slate-400 mt-1">
            {t('admin.dashboard.avgReceipt', { amount: formatSom(data.avgReceipt) })}
          </div>
        </div>

        <div className={CARD}>
          <span className={CARD_LABEL}>{t('admin.dashboard.returns')}</span>
          <div className="text-2xl font-bold text-red-600 mt-2">{formatSom(data.returnsTotal)}</div>
          <div className="text-xs text-slate-400 mt-1">{t('admin.dashboard.returnsHint')}</div>
        </div>

        <div className={CARD}>
          <span className={CARD_LABEL}>{t('admin.dashboard.grossProfit')}</span>
          <div className="text-2xl font-bold text-emerald-600 mt-2">
            {showProfit ? formatSom(data.grossProfit) : '••••••••'}
          </div>
          <div className="text-xs text-slate-400 mt-1">
            {showProfit
              ? t('admin.dashboard.margin', {
                  value:
                    data.marginBp !== null && data.marginBp !== undefined
                      ? `${(data.marginBp / 100).toFixed(1)}%`
                      : '—',
                })
              : t('admin.dashboard.hidden')}
          </div>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
        <h3 className="text-base font-bold text-slate-800 mb-4">{t('admin.dashboard.stores')}</h3>
        {data.stores.length === 0 ? (
          <p className="text-sm text-slate-500">{t('admin.dashboard.noStores')}</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {data.stores.map((s) => (
              <div key={s.storeId} className="py-3 flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-slate-800">{s.storeName}</div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    {s.lastEventAtMs
                      ? t('admin.dashboard.lastSync', { time: formatDateTime(s.lastEventAtMs) })
                      : t('admin.dashboard.neverSynced')}
                  </div>
                </div>

                {s.isStale ? (
                  <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-red-100 text-red-800">
                    <span className="w-1.5 h-1.5 rounded-full bg-red-600 mr-1.5" />
                    {t('admin.dashboard.stale')}
                  </span>
                ) : (
                  <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-600 mr-1.5" />
                    {t('admin.dashboard.online')}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
