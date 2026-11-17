import React, { useEffect, useState } from 'react';
import type {
  AdminCustomerDetailResponseDto,
  AdminCustomerItemDto,
  AdminCustomersResponseDto,
} from '@mezon/contracts';
import { t } from '@mezon/i18n';
import { adminApi } from '../api-client.js';
import { describeApiError, formatDateTime, formatSom } from '../utils/format.js';

/** A customer balance is the amount the customer owes; shown as debt (red) when non-zero. */
function debt(tiyin: string): React.ReactNode {
  return tiyin !== '0' ? (
    <span className="text-red-600">{formatSom(tiyin)}</span>
  ) : (
    <span className="text-slate-400">{formatSom('0')}</span>
  );
}

export const CustomersView: React.FC = () => {
  const [customers, setCustomers] = useState<AdminCustomerItemDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selectedCustId, setSelectedCustId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminCustomerDetailResponseDto | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const loadCustomers = async (reset: boolean) => {
    if (reset) {
      setLoading(true);
      setCustomers([]);
    } else {
      setLoadingMore(true);
    }
    setError(null);
    try {
      const res: AdminCustomersResponseDto = await adminApi.getCustomers({
        search: search.trim() || undefined,
        cursor: reset ? undefined : (nextCursor ?? undefined),
        limit: 15,
      });
      setCustomers((prev) => (reset ? res.items : [...prev, ...res.items]));
      setNextCursor(res.nextCursor);
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    void loadCustomers(true);
  }, [search]);

  const openCustomer = async (id: string) => {
    setSelectedCustId(id);
    setDetail(null);
    setDetailError(null);
    try {
      setDetail(await adminApi.getCustomerDetail(id));
    } catch (err) {
      setDetailError(describeApiError(err));
    }
  };

  const closeCustomer = () => {
    setSelectedCustId(null);
    setDetail(null);
    setDetailError(null);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-800">{t('admin.customers.title')}</h2>
          <p className="text-xs text-slate-500 mt-1">{t('admin.customers.subtitle')}</p>
        </div>

        <div className="flex items-center gap-3 w-full sm:w-auto">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('admin.customers.search')}
            aria-label={t('admin.customers.search')}
            className="text-xs px-3 py-2 rounded-lg border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 w-full sm:w-64"
          />
          <button
            onClick={() => {
              void loadCustomers(true);
            }}
            className="text-xs px-3 py-2 rounded-lg bg-indigo-50 text-indigo-700 hover:bg-indigo-100 font-medium transition-colors"
          >
            {t('admin.refresh')}
          </button>
        </div>
      </div>

      {error && (
        <div role="alert" className="p-3 rounded-lg bg-red-50 text-red-700 text-xs">
          {error}
        </div>
      )}

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
            <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase tracking-wider">
              <tr>
                <th className="px-4 py-3">{t('admin.customers.col.name')}</th>
                <th className="px-4 py-3">{t('admin.customers.col.phone')}</th>
                <th className="px-4 py-3">{t('admin.customers.col.balance')}</th>
                <th className="px-4 py-3">{t('admin.customers.col.overdue')}</th>
                <th className="px-4 py-3">{t('admin.customers.col.created')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {loading && customers.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-center py-10 text-slate-400">
                    {t('admin.customers.loading')}
                  </td>
                </tr>
              ) : customers.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-center py-10 text-slate-400">
                    {t('admin.customers.empty')}
                  </td>
                </tr>
              ) : (
                customers.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() => {
                      void openCustomer(c.id);
                    }}
                    className="hover:bg-indigo-50/50 cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-3 font-semibold text-slate-900">{c.fullName}</td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-600">
                      {c.maskedPhone || '—'}
                    </td>
                    <td className="px-4 py-3 font-bold">{debt(c.balanceTiyin)}</td>
                    <td className="px-4 py-3 text-xs text-red-500 font-semibold">
                      {c.overdueAmountTiyin !== '0' ? formatSom(c.overdueAmountTiyin) : '—'}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">
                      {formatDateTime(c.createdAtMs)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {nextCursor && (
          <div className="p-4 border-t border-slate-100 text-center">
            <button
              onClick={() => {
                void loadCustomers(false);
              }}
              disabled={loadingMore}
              className="px-4 py-2 text-xs font-semibold text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition-colors disabled:opacity-50"
            >
              {loadingMore ? t('common.loading') : t('admin.loadMore')}
            </button>
          </div>
        )}
      </div>

      {selectedCustId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm">
          <div
            role="dialog"
            aria-modal="true"
            className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6 border border-slate-200"
          >
            <div className="flex justify-end">
              <button
                onClick={closeCustomer}
                aria-label={t('common.close')}
                className="text-slate-400 hover:text-slate-600 text-xl font-bold"
              >
                ×
              </button>
            </div>
            {detailError ? (
              <div role="alert" className="py-8 text-center text-red-600 text-sm">
                {detailError}
              </div>
            ) : !detail ? (
              <div className="py-12 text-center text-slate-400">
                {t('admin.customers.detailLoading')}
              </div>
            ) : (
              <div className="space-y-6">
                <div className="border-b border-slate-100 pb-4">
                  <h3 className="text-lg font-bold text-slate-900">{detail.fullName}</h3>
                </div>

                <div className="space-y-3 text-sm">
                  <div className="flex justify-between py-1 border-b border-slate-50">
                    <span className="text-slate-500 text-xs">{t('admin.customers.phone')}</span>
                    <span className="font-mono font-semibold text-slate-900">
                      {detail.phone || t('admin.notSet')}
                    </span>
                  </div>

                  <div className="flex justify-between py-1 border-b border-slate-50">
                    <span className="text-slate-500 text-xs">{t('admin.customers.balance')}</span>
                    <span className="font-bold">{debt(detail.balanceTiyin)}</span>
                  </div>

                  <div className="flex justify-between py-1 border-b border-slate-50">
                    <span className="text-slate-500 text-xs">{t('admin.customers.overdue')}</span>
                    <span className="text-red-500 font-semibold">
                      {formatSom(detail.overdueAmountTiyin)}
                    </span>
                  </div>

                  {detail.notes && (
                    <div className="py-2 bg-slate-50 p-3 rounded text-xs text-slate-600">
                      <span className="font-bold block mb-1">{t('admin.customers.notes')}</span>
                      {detail.notes}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
