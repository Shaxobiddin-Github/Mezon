import React, { useEffect, useState } from 'react';
import type {
  AdminCustomerDetailResponseDto,
  AdminCustomerItemDto,
  AdminCustomersResponseDto,
} from '@mezon/contracts';
import { adminApi } from '../api-client.js';
import { formatDateTime, formatTiyin } from '../utils/format.js';

export const CustomersView: React.FC = () => {
  const [customers, setCustomers] = useState<AdminCustomerItemDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedCustId, setSelectedCustId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminCustomerDetailResponseDto | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    void loadCustomers(true);
  }, [search]);

  const loadCustomers = async (reset = false) => {
    if (reset) {
      setLoading(true);
      setCustomers([]);
    } else {
      setLoadingMore(true);
    }

    try {
      const res: AdminCustomersResponseDto = await adminApi.getCustomers({
        search: search.trim() || undefined,
        cursor: reset ? undefined : (nextCursor ?? undefined),
        limit: 15,
      });

      setCustomers((prev) => (reset ? res.items : [...prev, ...res.items]));
      setNextCursor(res.nextCursor);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  };

  const handleSelectCustomer = async (id: string) => {
    setSelectedCustId(id);
    setDetailLoading(true);
    try {
      const res = await adminApi.getCustomerDetail(id);
      setDetail(res);
    } catch (err) {
      console.error(err);
    } finally {
      setDetailLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-800">Mijozlar bazasi</h2>
          <p className="text-xs text-slate-500 mt-1">Mijozlar roʻyxati va qarz daftari nazorati</p>
        </div>

        <div className="flex items-center space-x-3 w-full sm:w-auto">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Ism yoki telefon..."
            className="text-xs px-3 py-2 rounded-lg border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 w-full sm:w-64"
          />
          <button
            onClick={() => {
              void loadCustomers(true);
            }}
            className="text-xs px-3 py-2 rounded-lg bg-indigo-50 text-indigo-700 hover:bg-indigo-100 font-medium transition-colors"
          >
            Yangilash
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
            <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase tracking-wider">
              <tr>
                <th className="px-6 py-3">Mijoz ismi</th>
                <th className="px-6 py-3">Telefon (Maskalangan)</th>
                <th className="px-6 py-3">Balans</th>
                <th className="px-6 py-3">Muddati oʻtgan qarz</th>
                <th className="px-6 py-3">Yaratilgan</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {loading && customers.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-center py-10 text-slate-400">
                    Mijozlar yuklanmoqda...
                  </td>
                </tr>
              ) : customers.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-center py-10 text-slate-400">
                    Mijozlar topilmadi
                  </td>
                </tr>
              ) : (
                customers.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() => {
                      void handleSelectCustomer(c.id);
                    }}
                    className="hover:bg-indigo-50/50 cursor-pointer transition-colors"
                  >
                    <td className="px-6 py-3 font-semibold text-slate-900">{c.fullName}</td>
                    <td className="px-6 py-3 font-mono text-xs text-slate-600">
                      {c.maskedPhone || '—'}
                    </td>
                    <td className="px-6 py-3 font-bold">
                      {c.balanceTiyin !== '0' ? (
                        <span className="text-red-600">-{formatTiyin(c.balanceTiyin)}</span>
                      ) : (
                        <span className="text-slate-400">0 soʻm</span>
                      )}
                    </td>
                    <td className="px-6 py-3 text-xs text-red-500 font-semibold">
                      {c.overdueAmountTiyin !== '0' ? formatTiyin(c.overdueAmountTiyin) : '—'}
                    </td>
                    <td className="px-6 py-3 text-xs text-slate-500">
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
              {loadingMore ? 'Yuklanmoqda...' : 'Yana yuklash'}
            </button>
          </div>
        )}
      </div>

      {/* Customer Detail Modal (A6 Unmasked phone in detail) */}
      {selectedCustId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm">
          <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6 border border-slate-200">
            {detailLoading || !detail ? (
              <div className="py-12 text-center text-slate-400">
                Mijoz ma’lumotlari yuklanmoqda...
              </div>
            ) : (
              <div className="space-y-6">
                <div className="flex justify-between items-start border-b border-slate-100 pb-4">
                  <div>
                    <h3 className="text-lg font-bold text-slate-900">{detail.fullName}</h3>
                    <p className="text-xs text-slate-500 mt-1">ID: {detail.id}</p>
                  </div>
                  <button
                    onClick={() => {
                      setSelectedCustId(null);
                      setDetail(null);
                    }}
                    className="text-slate-400 hover:text-slate-600 text-xl font-bold"
                  >
                    ×
                  </button>
                </div>

                <div className="space-y-3 text-sm">
                  <div className="flex justify-between py-1 border-b border-slate-50">
                    <span className="text-slate-500 text-xs">Toʻliq telefon raqami:</span>
                    <span className="font-mono font-semibold text-slate-900">
                      {detail.phone || 'Kiritilmagan'}
                    </span>
                  </div>

                  <div className="flex justify-between py-1 border-b border-slate-50">
                    <span className="text-slate-500 text-xs">Qarz balansi:</span>
                    <span className="font-bold text-red-600">
                      {detail.balanceTiyin !== '0'
                        ? `-${formatTiyin(detail.balanceTiyin)}`
                        : '0 soʻm'}
                    </span>
                  </div>

                  <div className="flex justify-between py-1 border-b border-slate-50">
                    <span className="text-slate-500 text-xs">Muddati oʻtgan:</span>
                    <span className="text-red-500 font-semibold">
                      {detail.overdueAmountTiyin !== '0'
                        ? formatTiyin(detail.overdueAmountTiyin)
                        : '0 soʻm'}
                    </span>
                  </div>

                  {detail.notes && (
                    <div className="py-2 bg-slate-50 p-3 rounded text-xs text-slate-600">
                      <span className="font-bold block mb-1">Eslatma:</span>
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
