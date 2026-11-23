import React, { useEffect, useState } from 'react';
import type { DailySalesReportResponseDto } from '@mezon/contracts';
import { t } from '@mezon/i18n';
import { adminApi } from '../api-client.js';
import { describeApiError, formatSom, tashkentDateKey } from '../utils/format.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const DailyReportView: React.FC = () => {
  // Day boundaries are Tashkent days (same as the till reports), not UTC days.
  const [fromDate, setFromDate] = useState(() => tashkentDateKey(Date.now() - 30 * DAY_MS));
  const [toDate, setToDate] = useState(() => tashkentDateKey(Date.now()));
  const [report, setReport] = useState<DailySalesReportResponseDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadReport = async () => {
    setLoading(true);
    setError(null);
    try {
      setReport(await adminApi.getDailySalesReport({ fromDate, toDate, limit: 100 }));
    } catch (err) {
      setError(describeApiError(err));
      setReport(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadReport();
  }, []);

  const minus = (tiyin: string) => (tiyin !== '0' ? `-${formatSom(tiyin)}` : formatSom('0'));
  const columns = [
    'admin.report.col.date',
    'admin.report.col.counts',
    'admin.report.col.gross',
    'admin.report.col.returns',
    'admin.report.col.net',
    'admin.report.col.vat',
    'admin.report.col.cash',
    'admin.report.col.nonCash',
    'admin.report.col.cost',
    'admin.report.col.profit',
  ] as const;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="page-title">{t('admin.report.title')}</h2>
          <p className="page-subtitle">{t('admin.report.subtitle')}</p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
            {t('admin.report.from')}
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="text-xs px-2.5 py-1.5 rounded border border-slate-300 bg-white"
            />
          </label>
          <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
            {t('admin.report.to')}
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="text-xs px-2.5 py-1.5 rounded border border-slate-300 bg-white"
            />
          </label>
          <button
            onClick={() => {
              void loadReport();
            }}
            className="text-xs px-3 py-1.5 rounded bg-indigo-600 hover:bg-indigo-700 text-white font-medium transition-colors shadow-sm"
          >
            {t('admin.report.build')}
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
          <table className="min-w-full divide-y divide-slate-200 text-left text-xs">
            <thead className="bg-slate-50 font-semibold text-slate-500 uppercase tracking-wider">
              <tr>
                {columns.map((key, i) => (
                  <th key={key} className={`px-4 py-3 ${i === 0 ? '' : 'text-right'}`}>
                    {t(key)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700 font-mono">
              {loading ? (
                <tr>
                  <td colSpan={10} className="text-center py-10 text-slate-400 font-sans text-sm">
                    {t('admin.report.loading')}
                  </td>
                </tr>
              ) : !report || report.days.length === 0 ? (
                <tr>
                  <td colSpan={10} className="text-center py-10 text-slate-400 font-sans text-sm">
                    {t('admin.report.empty')}
                  </td>
                </tr>
              ) : (
                report.days.map((d) => (
                  <tr key={d.date} className="hover:bg-slate-50 transition-colors">
                    <td className="px-4 py-2.5 font-sans font-semibold text-slate-900">{d.date}</td>
                    <td className="px-4 py-2.5 text-right font-sans">
                      {d.salesCount} / <span className="text-red-600">{d.returnsCount}</span>
                    </td>
                    <td className="px-4 py-2.5 text-right">{formatSom(d.grossSales)}</td>
                    <td className="px-4 py-2.5 text-right text-red-600">{minus(d.returnsTotal)}</td>
                    <td className="px-4 py-2.5 text-right font-bold text-slate-900">
                      {formatSom(d.netSales)}
                    </td>
                    <td className="px-4 py-2.5 text-right text-slate-500">
                      {formatSom(d.vatTotal)}
                    </td>
                    <td className="px-4 py-2.5 text-right">{formatSom(d.cashSales)}</td>
                    <td className="px-4 py-2.5 text-right">{formatSom(d.nonCashSales)}</td>
                    <td className="px-4 py-2.5 text-right text-slate-500">
                      {formatSom(d.costValue)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-bold text-emerald-600">
                      {formatSom(d.grossProfit)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>

            {!loading && report && report.days.length > 0 && (
              <tfoot className="bg-slate-100 font-mono font-bold text-slate-900 border-t-2 border-slate-300">
                <tr>
                  <td className="px-4 py-3 font-sans">{t('admin.report.total')}</td>
                  <td className="px-4 py-3 text-right font-sans">
                    {report.totalSalesCount} /{' '}
                    <span className="text-red-600">{report.totalReturnsCount}</span>
                  </td>
                  <td className="px-4 py-3 text-right">{formatSom(report.totalGrossSales)}</td>
                  <td className="px-4 py-3 text-right text-red-600">
                    {minus(report.totalReturns)}
                  </td>
                  <td className="px-4 py-3 text-right text-indigo-700">
                    {formatSom(report.totalNetSales)}
                  </td>
                  <td className="px-4 py-3 text-right">{formatSom(report.totalVat)}</td>
                  <td className="px-4 py-3 text-right">{formatSom(report.totalCashSales)}</td>
                  <td className="px-4 py-3 text-right">{formatSom(report.totalNonCashSales)}</td>
                  <td className="px-4 py-3 text-right">{formatSom(report.totalCostValue)}</td>
                  <td className="px-4 py-3 text-right text-emerald-700">
                    {formatSom(report.totalGrossProfit)}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
};
