import React, { useEffect, useState } from 'react';
import type { DailySalesReportResponseDto } from '@mezon/contracts';
import { adminApi } from '../api-client.js';
import { formatTiyin } from '../utils/format.js';

export const DailyReportView: React.FC = () => {
  const today = new Date().toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const [fromDate, setFromDate] = useState(thirtyDaysAgo);
  const [toDate, setToDate] = useState(today);
  const [report, setReport] = useState<DailySalesReportResponseDto | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadReport();
  }, []);

  const loadReport = async () => {
    setLoading(true);
    try {
      const res = await adminApi.getDailySalesReport({
        fromDate,
        toDate,
        limit: 100,
      });
      setReport(res);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-800">Kunlik savdo hisoboti</h2>
          <p className="text-xs text-slate-500 mt-1">
            Har bir kun boʻyicha tushum, QQS, naqd/karta va yalpi foyda hisoboti
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center space-x-2">
            <label className="text-xs font-semibold text-slate-600">Dan:</label>
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="text-xs px-2.5 py-1.5 rounded border border-slate-300 bg-white"
            />
          </div>
          <div className="flex items-center space-x-2">
            <label className="text-xs font-semibold text-slate-600">Gacha:</label>
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="text-xs px-2.5 py-1.5 rounded border border-slate-300 bg-white"
            />
          </div>
          <button
            onClick={loadReport}
            className="text-xs px-3 py-1.5 rounded bg-indigo-600 hover:bg-indigo-700 text-white font-medium transition-colors shadow-sm"
          >
            Hisobotni shakllantirish
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-left text-xs">
            <thead className="bg-slate-50 font-semibold text-slate-500 uppercase tracking-wider">
              <tr>
                <th className="px-4 py-3">Sana</th>
                <th className="px-4 py-3 text-right">Cheklar (Savdo/Qayt)</th>
                <th className="px-4 py-3 text-right">Yalpi savdo</th>
                <th className="px-4 py-3 text-right">Qaytarishlar</th>
                <th className="px-4 py-3 text-right">Sof savdo</th>
                <th className="px-4 py-3 text-right">QQS jami</th>
                <th className="px-4 py-3 text-right">Naqd toʻlov</th>
                <th className="px-4 py-3 text-right">Karta/Boshqa</th>
                <th className="px-4 py-3 text-right">Tannarx</th>
                <th className="px-4 py-3 text-right">Yalpi foyda</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700 font-mono">
              {loading || !report ? (
                <tr>
                  <td colSpan={10} className="text-center py-10 text-slate-400 font-sans text-sm">
                    Hisobot yuklanmoqda...
                  </td>
                </tr>
              ) : report.days.length === 0 ? (
                <tr>
                  <td colSpan={10} className="text-center py-10 text-slate-400 font-sans text-sm">
                    Koʻrsatilgan oraliqda savdo ma’lumotlari topilmadi
                  </td>
                </tr>
              ) : (
                report.days.map((d) => (
                  <tr key={d.date} className="hover:bg-slate-50 transition-colors">
                    <td className="px-4 py-2.5 font-sans font-semibold text-slate-900">{d.date}</td>
                    <td className="px-4 py-2.5 text-right font-sans">
                      {d.salesCount} / <span className="text-red-600">{d.returnsCount}</span>
                    </td>
                    <td className="px-4 py-2.5 text-right">{formatTiyin(d.grossSales)}</td>
                    <td className="px-4 py-2.5 text-right text-red-600">
                      {d.returnsTotal !== '0' ? `-${formatTiyin(d.returnsTotal)}` : '0'}
                    </td>
                    <td className="px-4 py-2.5 text-right font-bold text-slate-900">
                      {formatTiyin(d.netSales)}
                    </td>
                    <td className="px-4 py-2.5 text-right text-slate-500">{formatTiyin(d.vatTotal)}</td>
                    <td className="px-4 py-2.5 text-right">{formatTiyin(d.cashSales)}</td>
                    <td className="px-4 py-2.5 text-right">{formatTiyin(d.nonCashSales)}</td>
                    <td className="px-4 py-2.5 text-right text-slate-500">
                      {d.costValue ? formatTiyin(d.costValue) : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right font-bold text-emerald-600">
                      {d.grossProfit ? formatTiyin(d.grossProfit) : '—'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>

            {report && report.days.length > 0 && (
              <tfoot className="bg-slate-100 font-mono font-bold text-slate-900 border-t-2 border-slate-300">
                <tr>
                  <td className="px-4 py-3 font-sans">JAMI:</td>
                  <td className="px-4 py-3 text-right font-sans">
                    {report.totalSalesCount} / <span className="text-red-600">{report.totalReturnsCount}</span>
                  </td>
                  <td className="px-4 py-3 text-right">{formatTiyin(report.totalGrossSales)}</td>
                  <td className="px-4 py-3 text-right text-red-600">
                    {report.totalReturns !== '0' ? `-${formatTiyin(report.totalReturns)}` : '0'}
                  </td>
                  <td className="px-4 py-3 text-right text-indigo-700">{formatTiyin(report.totalNetSales)}</td>
                  <td className="px-4 py-3 text-right">{formatTiyin(report.totalVat)}</td>
                  <td className="px-4 py-3 text-right">{formatTiyin(report.totalCashSales)}</td>
                  <td className="px-4 py-3 text-right">{formatTiyin(report.totalNonCashSales)}</td>
                  <td className="px-4 py-3 text-right">
                    {report.totalCostValue ? formatTiyin(report.totalCostValue) : '—'}
                  </td>
                  <td className="px-4 py-3 text-right text-emerald-700">
                    {report.totalGrossProfit ? formatTiyin(report.totalGrossProfit) : '—'}
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
