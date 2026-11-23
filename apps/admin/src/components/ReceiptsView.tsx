import React, { useEffect, useState } from 'react';
import type {
  AdminReceiptDetailResponseDto,
  AdminReceiptItemDto,
  AdminReceiptsResponseDto,
} from '@mezon/contracts';
import { t } from '@mezon/i18n';
import { adminApi } from '../api-client.js';
import {
  describeApiError,
  formatDateTime,
  formatQty,
  formatSom,
  paymentMethodLabel,
  unitLabel,
} from '../utils/format.js';

type StatusFilter = 'all' | 'completed' | 'voided';

export const ReceiptsView: React.FC = () => {
  const [receipts, setReceipts] = useState<AdminReceiptItemDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [selectedReceiptId, setSelectedReceiptId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminReceiptDetailResponseDto | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const loadReceipts = async (reset: boolean) => {
    if (reset) {
      setLoading(true);
      setReceipts([]);
    } else {
      setLoadingMore(true);
    }
    setError(null);
    try {
      const res: AdminReceiptsResponseDto = await adminApi.getReceipts({
        status: statusFilter === 'all' ? undefined : statusFilter,
        cursor: reset ? undefined : (nextCursor ?? undefined),
        limit: 15,
      });
      setReceipts((prev) => (reset ? res.items : [...prev, ...res.items]));
      setNextCursor(res.nextCursor);
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    void loadReceipts(true);
  }, [statusFilter]);

  const openReceipt = async (id: string) => {
    setSelectedReceiptId(id);
    setDetail(null);
    setDetailError(null);
    try {
      setDetail(await adminApi.getReceiptDetail(id));
    } catch (err) {
      setDetailError(describeApiError(err));
    }
  };

  const closeReceipt = () => {
    setSelectedReceiptId(null);
    setDetail(null);
    setDetailError(null);
  };

  const statusBadge = (status: string) =>
    status === 'voided' ? (
      <span className="px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">
        {t('admin.receipts.status.voided')}
      </span>
    ) : (
      <span className="px-2 py-0.5 rounded text-xs font-medium bg-emerald-100 text-emerald-700">
        {t('admin.receipts.status.completed')}
      </span>
    );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="page-title">{t('admin.receipts.title')}</h2>
          <p className="page-subtitle">{t('admin.receipts.subtitle')}</p>
        </div>

        <div className="flex items-center gap-3">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            className="text-xs px-3 py-2 rounded-lg border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 font-medium text-slate-700"
          >
            <option value="all">{t('admin.receipts.filter.all')}</option>
            <option value="completed">{t('admin.receipts.status.completed')}</option>
            <option value="voided">{t('admin.receipts.status.voided')}</option>
          </select>
          <button
            onClick={() => {
              void loadReceipts(true);
            }}
            className="btn btn-soft"
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

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
            <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase tracking-wider">
              <tr>
                <th className="px-4 py-3">{t('admin.receipts.col.number')}</th>
                <th className="px-4 py-3">{t('admin.receipts.col.store')}</th>
                <th className="px-4 py-3">{t('admin.receipts.col.cashier')}</th>
                <th className="px-4 py-3">{t('admin.receipts.col.total')}</th>
                <th className="px-4 py-3">{t('admin.receipts.col.payment')}</th>
                <th className="px-4 py-3">{t('admin.receipts.col.status')}</th>
                <th className="px-4 py-3">{t('admin.receipts.col.time')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {loading && receipts.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center py-10 text-slate-400">
                    {t('admin.receipts.loading')}
                  </td>
                </tr>
              ) : receipts.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center py-10 text-slate-400">
                    {t('admin.receipts.empty')}
                  </td>
                </tr>
              ) : (
                receipts.map((r) => (
                  <tr
                    key={r.id}
                    onClick={() => {
                      void openReceipt(r.id);
                    }}
                    className="hover:bg-indigo-50/50 cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-3 font-semibold text-indigo-600">{r.receiptNumber}</td>
                    <td className="px-4 py-3">{r.storeName}</td>
                    <td className="px-4 py-3">{r.cashierName || '—'}</td>
                    <td className="px-4 py-3 font-bold text-slate-900">
                      {formatSom(r.totalTiyin)}
                    </td>
                    <td className="px-4 py-3">
                      {r.paymentMethods.map(paymentMethodLabel).join(', ')}
                    </td>
                    <td className="px-4 py-3">{statusBadge(r.status)}</td>
                    <td className="px-4 py-3 text-xs text-slate-500">
                      {formatDateTime(r.createdAtMs)}
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
                void loadReceipts(false);
              }}
              disabled={loadingMore}
              className="px-4 py-2 text-xs font-semibold text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition-colors disabled:opacity-50"
            >
              {loadingMore ? t('common.loading') : t('admin.loadMore')}
            </button>
          </div>
        )}
      </div>

      {selectedReceiptId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm">
          <div
            role="dialog"
            aria-modal="true"
            className="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto p-6 border border-slate-200"
          >
            <div className="flex justify-end">
              <button
                onClick={closeReceipt}
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
                {t('admin.receipts.detailLoading')}
              </div>
            ) : (
              <div className="space-y-6">
                <div className="border-b border-slate-100 pb-4">
                  <h3 className="text-lg font-bold text-slate-900">
                    {t('admin.receipts.detailTitle', { number: detail.receiptNumber })}
                  </h3>
                  <p className="text-xs text-slate-500 mt-1">
                    {detail.storeName} | {formatDateTime(detail.createdAtMs)}
                  </p>
                </div>

                {detail.status === 'voided' && (
                  <div className="p-3 bg-red-50 text-red-700 rounded-lg text-xs">
                    <span className="font-bold">{t('admin.receipts.voided')}</span>{' '}
                    {detail.voidReason || t('admin.receipts.noReason')} (
                    {formatDateTime(detail.voidedAtMs)})
                  </div>
                )}

                <div>
                  <h4 className="text-xs font-bold text-slate-600 uppercase tracking-wider mb-2">
                    {t('admin.receipts.lines')}
                  </h4>
                  <table className="min-w-full text-xs divide-y divide-slate-100">
                    <thead className="text-slate-400 font-semibold">
                      <tr>
                        <th className="py-2 text-left">{t('admin.receipts.col.product')}</th>
                        <th className="py-2 text-right">{t('admin.receipts.col.qty')}</th>
                        <th className="py-2 text-right">{t('admin.receipts.col.price')}</th>
                        <th className="py-2 text-right">{t('admin.receipts.col.lineTotal')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {detail.lines.map((l) => (
                        <tr key={l.id}>
                          <td className="py-2">
                            <div className="font-semibold text-slate-800">{l.productName}</div>
                            {l.sku && (
                              <div className="text-[10px] text-slate-400">SKU: {l.sku}</div>
                            )}
                          </td>
                          <td className="py-2 text-right">
                            {formatQty(l.qtyMilli)} {unitLabel(l.unit)}
                          </td>
                          <td className="py-2 text-right">{formatSom(l.unitPriceTiyin)}</td>
                          <td className="py-2 text-right font-bold text-slate-900">
                            {formatSom(l.totalTiyin)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="border-t border-slate-100 pt-4 space-y-1.5 text-xs">
                  <div className="flex justify-between text-slate-500">
                    <span>{t('admin.receipts.gross')}</span>
                    <span>{formatSom(detail.grossTotalTiyin)}</span>
                  </div>
                  {detail.discountTotalTiyin !== '0' && (
                    <div className="flex justify-between text-red-600">
                      <span>{t('admin.receipts.discount')}</span>
                      <span>-{formatSom(detail.discountTotalTiyin)}</span>
                    </div>
                  )}
                  <div className="flex justify-between text-slate-500">
                    <span>{t('admin.receipts.vat')}</span>
                    <span>{formatSom(detail.vatTotalTiyin)}</span>
                  </div>
                  <div className="flex justify-between text-sm font-bold text-slate-900 pt-2 border-t border-slate-100">
                    <span>{t('admin.receipts.net')}</span>
                    <span>{formatSom(detail.netTotalTiyin)}</span>
                  </div>
                </div>

                <div>
                  <h4 className="text-xs font-bold text-slate-600 uppercase tracking-wider mb-2">
                    {t('admin.receipts.payments')}
                  </h4>
                  <div className="space-y-1 text-xs">
                    {detail.payments.map((p) => (
                      <div
                        key={p.id}
                        className="flex justify-between py-1 bg-slate-50 px-3 rounded"
                      >
                        <span className="font-medium text-slate-700">
                          {paymentMethodLabel(p.method)}
                        </span>
                        <span className="font-bold text-slate-900">{formatSom(p.amountTiyin)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
