import React, { useEffect, useState } from 'react';
import type { AdminDashboardResponseDto } from '@mezon/contracts';
import { adminApi } from '../api-client.js';
import { formatDateTime, formatTiyin } from '../utils/format.js';

export const DashboardView: React.FC = () => {
  const [data, setData] = useState<AdminDashboardResponseDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showProfit, setShowProfit] = useState(false);

  useEffect(() => {
    void loadDashboard();
  }, []);

  const loadDashboard = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminApi.getDashboard();
      setData(res);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Dashboard ma’lumotlarini yuklashda xatolik';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64 text-slate-400">
        Dashboard yuklanmoqda...
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-6 bg-red-50 text-red-700 rounded-lg border border-red-200">
        <p className="font-semibold">Xatolik:</p>
        <p className="text-sm mt-1">{error}</p>
        <button
          onClick={() => {
            void loadDashboard();
          }}
          className="mt-4 px-3 py-1.5 bg-red-600 text-white rounded text-xs hover:bg-red-700"
        >
          Qayta urinish
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-800">Bugungi koʻrsatkichlar</h2>
          <p className="text-xs text-slate-500 mt-1">Sana: {data.todayDate} (Osiyo/Toshkent)</p>
        </div>

        <div className="flex items-center space-x-3">
          <button
            onClick={() => setShowProfit(!showProfit)}
            className="text-xs px-3 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50 font-medium text-slate-700 transition-colors"
          >
            {showProfit ? 'Foydani yashirish' : 'Foydani koʻrsatish'}
          </button>
          <button
            onClick={() => {
              void loadDashboard();
            }}
            className="text-xs px-3 py-1.5 rounded-lg bg-indigo-50 text-indigo-700 hover:bg-indigo-100 font-medium transition-colors"
          >
            Yangilash
          </button>
        </div>
      </div>

      {/* Metric Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Sof savdo</span>
          <div className="text-2xl font-bold text-slate-900 mt-2">{formatTiyin(data.netSales)}</div>
          <div className="text-xs text-slate-400 mt-1">Yalpi: {formatTiyin(data.grossSales)}</div>
        </div>

        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Cheklar soni</span>
          <div className="text-2xl font-bold text-slate-900 mt-2">{data.receiptsCount} ta</div>
          <div className="text-xs text-slate-400 mt-1">Oʻrtacha chek: {formatTiyin(data.avgReceipt)}</div>
        </div>

        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Qaytarishlar</span>
          <div className="text-2xl font-bold text-red-600 mt-2">{formatTiyin(data.returnsTotal)}</div>
          <div className="text-xs text-slate-400 mt-1">Mijozlarga qaytarilgan mablagʻ</div>
        </div>

        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Yalpi foyda</span>
          <div className="text-2xl font-bold text-emerald-600 mt-2">
            {showProfit ? (data.grossProfit ? formatTiyin(data.grossProfit) : '—') : '••••••••'}
          </div>
          <div className="text-xs text-slate-400 mt-1">
            {showProfit ? `Marja: ${data.marginBp ? (data.marginBp / 100).toFixed(1) + '%' : '—'}` : 'Maxfiy'}
          </div>
        </div>
      </div>

      {/* Store Freshness (A2) */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
        <h3 className="text-base font-bold text-slate-800 mb-4">Filiallar va kassa holati</h3>
        {data.stores.length === 0 ? (
          <p className="text-sm text-slate-500">Hozircha birorta ham faol doʻkon roʻyxatdan oʻtmagan.</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {data.stores.map((s) => (
              <div key={s.storeId} className="py-3 flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold text-slate-800">{s.storeName}</div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    Oxirgi sinxron: {s.lastEventAtMs ? formatDateTime(s.lastEventAtMs) : 'Hali ulanmagan'}
                  </div>
                </div>

                <div>
                  {s.isStale ? (
                    <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-red-100 text-red-800">
                      <span className="w-1.5 h-1.5 rounded-full bg-red-600 mr-1.5 animate-pulse" />
                      Aloqa uzilgan (&gt;10 daqiqa)
                    </span>
                  ) : (
                    <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-600 mr-1.5" />
                      Faol onlayn
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
