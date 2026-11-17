import React, { useEffect, useState } from 'react';
import type {
  AdminReceiptDetailResponseDto,
  AdminReceiptItemDto,
  AdminReceiptsResponseDto,
} from '@mezon/contracts';
import { adminApi } from '../api-client.js';
import { formatDateTime, formatTiyin } from '../utils/format.js';

export const ReceiptsView: React.FC = () => {
  const [receipts, setReceipts] = useState<AdminReceiptItemDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [selectedReceiptId, setSelectedReceiptId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminReceiptDetailResponseDto | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    void loadReceipts(true);
  }, [statusFilter]);

  const loadReceipts = async (reset = false) => {
    if (reset) {
      setLoading(true);
      setReceipts([]);
    } else {
      setLoadingMore(true);
    }

    try {
      const res: AdminReceiptsResponseDto = await adminApi.getReceipts({
        status: statusFilter === 'all' ? undefined : (statusFilter as 'completed' | 'voided'),
        cursor: reset ? undefined : (nextCursor ?? undefined),
        limit: 15,
      });

      setReceipts((prev) => (reset ? res.items : [...prev, ...res.items]));
      setNextCursor(res.nextCursor);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  };

  const handleSelectReceipt = async (id: string) => {
    setSelectedReceiptId(id);
    setDetailLoading(true);
    try {
      const res = await adminApi.getReceiptDetail(id);
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
          <h2 className="text-xl font-bold text-slate-800">Sotuv cheklari</h2>
          <p className="text-xs text-slate-500 mt-1">Barcha filiallar boʻyicha cheklar jurnali</p>
        </div>

        <div className="flex items-center space-x-3">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="text-xs px-3 py-2 rounded-lg border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 font-medium text-slate-700"
          >
            <option value="all">Barcha cheklar</option>
            <option value="completed">Yakunlangan</option>
            <option value="voided">Bekor qilingan</option>
          </select>
          <button
            onClick={() => {
              void loadReceipts(true);
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
                <th className="px-6 py-3">Chek №</th>
                <th className="px-6 py-3">Filial</th>
                <th className="px-6 py-3">Kassir</th>
                <th className="px-6 py-3">Summa</th>
                <th className="px-6 py-3">Toʻlov turi</th>
                <th className="px-6 py-3">Holati</th>
                <th className="px-6 py-3">Vaqti</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {loading && receipts.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center py-10 text-slate-400">
                    Cheklar yuklanmoqda...
                  </td>
                </tr>
              ) : receipts.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center py-10 text-slate-400">
                    Cheklar topilmadi
                  </td>
                </tr>
              ) : (
                receipts.map((r) => (
                  <tr
                    key={r.id}
                    onClick={() => {
                      void handleSelectReceipt(r.id);
                    }}
                    className="hover:bg-indigo-50/50 cursor-pointer transition-colors"
                  >
                    <td className="px-6 py-3 font-semibold text-indigo-600">{r.receiptNumber}</td>
                    <td className="px-6 py-3">{r.storeName}</td>
                    <td className="px-6 py-3">{r.cashierName || '—'}</td>
                    <td className="px-6 py-3 font-bold text-slate-900">
                      {formatTiyin(r.totalTiyin)}
                    </td>
                    <td className="px-6 py-3 capitalize">{r.paymentMethods.join(', ')}</td>
                    <td className="px-6 py-3">
                      {r.status === 'voided' ? (
                        <span className="px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">
                          Bekor qilingan
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded text-xs font-medium bg-emerald-100 text-emerald-700">
                          Yakunlangan
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-3 text-xs text-slate-500">
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
              {loadingMore ? 'Yuklanmoqda...' : 'Yana yuklash'}
            </button>
          </div>
        )}
      </div>

      {/* Receipt Detail Modal */}
      {selectedReceiptId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm">
          <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto p-6 border border-slate-200">
            {detailLoading || !detail ? (
              <div className="py-12 text-center text-slate-400">
                Chek ma’lumotlari yuklanmoqda...
              </div>
            ) : (
              <div className="space-y-6">
                <div className="flex justify-between items-start border-b border-slate-100 pb-4">
                  <div>
                    <h3 className="text-lg font-bold text-slate-900">
                      Chek № {detail.receiptNumber}
                    </h3>
                    <p className="text-xs text-slate-500 mt-1">
                      {detail.storeName} | {formatDateTime(detail.createdAtMs)}
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      setSelectedReceiptId(null);
                      setDetail(null);
                    }}
                    className="text-slate-400 hover:text-slate-600 text-xl font-bold"
                  >
                    ×
                  </button>
                </div>

                {detail.status === 'voided' && (
                  <div className="p-3 bg-red-50 text-red-700 rounded-lg text-xs">
                    <span className="font-bold">Bekor qilingan:</span>{' '}
                    {detail.voidReason || 'Sabab koʻrsatilmagan'} (
                    {formatDateTime(detail.voidedAtMs)})
                  </div>
                )}

                {/* Lines Table */}
                <div>
                  <h4 className="text-xs font-bold text-slate-600 uppercase tracking-wider mb-2">
                    Chek tarkibi
                  </h4>
                  <table className="min-w-full text-xs divide-y divide-slate-100">
                    <thead className="text-slate-400 font-semibold">
                      <tr>
                        <th className="py-2 text-left">Mahsulot</th>
                        <th className="py-2 text-right">Miqdor</th>
                        <th className="py-2 text-right">Narx</th>
                        <th className="py-2 text-right">Jami</th>
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
                            {(Number(l.qtyMilli) / 1000).toLocaleString('uz-UZ')} {l.unit}
                          </td>
                          <td className="py-2 text-right">{formatTiyin(l.unitPriceTiyin)}</td>
                          <td className="py-2 text-right font-bold text-slate-900">
                            {formatTiyin(l.totalTiyin)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Totals */}
                <div className="border-t border-slate-100 pt-4 space-y-1.5 text-xs">
                  <div className="flex justify-between text-slate-500">
                    <span>Yalpi summa:</span>
                    <span>{formatTiyin(detail.grossTotalTiyin)}</span>
                  </div>
                  {detail.discountTotalTiyin !== '0' && (
                    <div className="flex justify-between text-red-600">
                      <span>Chegirma:</span>
                      <span>-{formatTiyin(detail.discountTotalTiyin)}</span>
                    </div>
                  )}
                  <div className="flex justify-between text-slate-500">
                    <span>QQS jami:</span>
                    <span>{formatTiyin(detail.vatTotalTiyin)}</span>
                  </div>
                  <div className="flex justify-between text-sm font-bold text-slate-900 pt-2 border-t border-slate-100">
                    <span>Toʻlangan sof summa:</span>
                    <span>{formatTiyin(detail.netTotalTiyin)}</span>
                  </div>
                </div>

                {/* Payments */}
                <div>
                  <h4 className="text-xs font-bold text-slate-600 uppercase tracking-wider mb-2">
                    Toʻlovlar
                  </h4>
                  <div className="space-y-1 text-xs">
                    {detail.payments.map((p) => (
                      <div
                        key={p.id}
                        className="flex justify-between py-1 bg-slate-50 px-3 rounded"
                      >
                        <span className="capitalize font-medium text-slate-700">{p.method}</span>
                        <span className="font-bold text-slate-900">
                          {formatTiyin(p.amountTiyin)}
                        </span>
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
