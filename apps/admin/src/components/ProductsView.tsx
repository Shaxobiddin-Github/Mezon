import React, { useEffect, useState } from 'react';
import type { AdminProductItemDto } from '@mezon/contracts';
import { t } from '@mezon/i18n';
import { type PriceChange, adminApi } from '../api-client.js';
import {
  describeApiError,
  formatDateTime,
  formatQty,
  formatSom,
  parseSomToTiyin,
  unitLabel,
} from '../utils/format.js';

/** T2.7b: one product's price editor and price history (who, when, why). */
const PriceEditor: React.FC<{
  readonly product: AdminProductItemDto;
  readonly onSaved: (newPriceTiyin: string) => void;
  readonly onClose: () => void;
}> = ({ product, onSaved, onClose }) => {
  const [price, setPrice] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [history, setHistory] = useState<PriceChange[] | null>(null);

  const loadHistory = async () => {
    try {
      setHistory((await adminApi.getPriceChanges(product.id)).changes);
    } catch (err) {
      setMessage(describeApiError(err));
    }
  };

  useEffect(() => {
    void loadHistory();
  }, [product.id]);

  const save = async () => {
    const tiyin = parseSomToTiyin(price);
    if (tiyin === null) {
      setMessage(t('admin.products.invalidPrice'));
      return;
    }
    // Owner decision (2026-11-20): a zero price is allowed, but only after an explicit confirmation.
    if (BigInt(tiyin) === 0n && !window.confirm(t('admin.products.confirmFree'))) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await adminApi.changeProductPrice(product.id, {
        newPrice: tiyin,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      setMessage(res.changed ? t('admin.products.saved') : t('admin.products.unchanged'));
      if (res.changed) {
        onSaved(tiyin);
        setPrice('');
        setReason('');
        await loadHistory();
      }
    } catch (err) {
      setMessage(describeApiError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-slate-50 border-t border-slate-200 px-4 py-3 space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-600">
          {t('admin.products.newPrice')}
          <input
            className="block mt-1 w-40 rounded border border-slate-300 px-2 py-1 text-sm"
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            data-testid="price-input"
          />
        </label>
        <label className="text-xs text-slate-600 flex-1 min-w-48">
          {t('admin.products.reason')}
          <input
            className="block mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm"
            maxLength={200}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={saving}
          onClick={() => void save()}
          className="btn btn-primary"
        >
          {t('admin.products.save')}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-slate-300 px-3 py-1.5 text-sm"
        >
          {t('admin.products.cancel')}
        </button>
      </div>
      {message && <p className="text-xs text-slate-700">{message}</p>}
      <div>
        <p className="text-xs font-semibold text-slate-500">{t('admin.products.history')}</p>
        {history !== null && history.length === 0 && (
          <p className="text-xs text-slate-400">{t('admin.products.historyEmpty')}</p>
        )}
        <ul className="text-xs text-slate-700 space-y-0.5">
          {(history ?? []).map((h) => (
            <li key={h.id}>
              {t('admin.products.historyRow', {
                when: formatDateTime(h.createdAtMs),
                old: formatSom(h.oldPrice),
                new: formatSom(h.newPrice),
                who: h.changedByName ?? t('admin.products.unknownUser'),
              })}
              {h.reason ? ` — ${h.reason}` : ''}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};

export const ProductsView: React.FC = () => {
  const [items, setItems] = useState<AdminProductItemDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = async (reset: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminApi.getProducts({
        search: search.trim() || undefined,
        cursor: reset ? undefined : (nextCursor ?? undefined),
        limit: 30,
      });
      setItems((prev) => (reset ? res.items : [...prev, ...res.items]));
      setNextCursor(res.nextCursor);
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(true);
  }, [search]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="page-title">{t('admin.products.title')}</h1>
        <p className="page-subtitle">{t('admin.products.subtitle')}</p>
      </div>
      <input
        className="w-full sm:w-80 rounded border border-slate-300 px-3 py-2 text-sm"
        placeholder={t('admin.products.search')}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="card divide-y divide-slate-100">
        {!loading && items.length === 0 && (
          <p className="p-4 text-sm text-slate-400">{t('admin.products.empty')}</p>
        )}
        {items.map((p) => (
          <div key={p.id}>
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <div className="min-w-0">
                <p className="font-medium text-slate-900 truncate">{p.name}</p>
                <p className="text-xs text-slate-500">
                  {t('admin.products.col.stock')}: {formatQty(p.currentStockMilli)}{' '}
                  {unitLabel(p.unit)}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-semibold text-slate-900">{formatSom(p.priceTiyin)}</span>
                <button
                  type="button"
                  className="text-xs font-semibold text-indigo-600"
                  onClick={() => setOpenId(openId === p.id ? null : p.id)}
                >
                  {t('admin.products.changePrice')}
                </button>
              </div>
            </div>
            {openId === p.id && (
              <PriceEditor
                product={p}
                onClose={() => setOpenId(null)}
                onSaved={(tiyin) =>
                  setItems((prev) =>
                    prev.map((x) => (x.id === p.id ? { ...x, priceTiyin: tiyin } : x)),
                  )
                }
              />
            )}
          </div>
        ))}
      </div>
      {nextCursor && (
        <button
          type="button"
          disabled={loading}
          onClick={() => void load(false)}
          className="text-sm font-semibold text-indigo-600"
        >
          {t('admin.products.more')}
        </button>
      )}
    </div>
  );
};
