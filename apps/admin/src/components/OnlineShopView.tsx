import type {
  AdminShopProductDto,
  AdminShopSettingsDto,
  ShopOrderDto,
  ShopOrderStatusDto,
} from '@mezon/contracts';
import { t } from '@mezon/i18n';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { adminApi } from '../api-client.js';
import {
  describeApiError,
  formatDateTime,
  formatQty,
  formatSom,
  unitLabel,
} from '../utils/format.js';
import { Icon } from './Icon.js';
import { QrSvg } from './QrSvg.js';

const NEXT: Record<ShopOrderStatusDto, readonly ShopOrderStatusDto[]> = {
  new: ['accepted', 'cancelled'],
  accepted: ['ready', 'cancelled'],
  ready: ['done', 'cancelled'],
  done: [],
  cancelled: [],
};

const STATUS_TONE: Record<ShopOrderStatusDto, string> = {
  new: 'bg-amber-50 text-amber-800 ring-amber-200',
  accepted: 'bg-sky-50 text-sky-800 ring-sky-200',
  ready: 'bg-indigo-50 text-indigo-800 ring-indigo-200',
  done: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  cancelled: 'bg-slate-100 text-slate-600 ring-slate-200',
};

const EMPTY: AdminShopSettingsDto = {
  slug: '',
  title: '',
  phone: null,
  address: null,
  about: null,
  isEnabled: true,
};

/**
 * V2 / F5 cabinet page "Onlayn do'kon": the shop link (with a QR to print), which products are on
 * sale online, and the orders customers placed.
 */
export const OnlineShopView: React.FC = () => {
  const [shop, setShop] = useState<AdminShopSettingsDto | null>(null);
  const [form, setForm] = useState<AdminShopSettingsDto>(EMPTY);
  const [products, setProducts] = useState<AdminShopProductDto[]>([]);
  const [orders, setOrders] = useState<ShopOrderDto[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const loadOrders = useCallback(async () => {
    try {
      setOrders((await adminApi.getShopOrders(showAll ? 'all' : 'open')).orders);
    } catch (err) {
      setError(describeApiError(err));
    }
  }, [showAll]);

  useEffect(() => {
    void (async () => {
      try {
        const [s, p] = await Promise.all([adminApi.getShop(), adminApi.getShopProducts()]);
        setShop(s.shop);
        setForm(s.shop ?? EMPTY);
        setProducts(p.items);
      } catch (err) {
        setError(describeApiError(err));
      }
    })();
  }, []);

  useEffect(() => {
    void loadOrders();
    const timer = setInterval(() => void loadOrders(), 30_000);
    return () => clearInterval(timer);
  }, [loadOrders]);

  const link = shop ? `${window.location.origin}/s/${shop.slug}` : '';

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await adminApi.saveShop({
        slug: form.slug.trim().toLowerCase(),
        title: form.title.trim(),
        phone: form.phone ?? '',
        address: form.address ?? '',
        about: form.about ?? '',
        isEnabled: form.isEnabled,
      });
      setShop(res.shop);
      if (res.shop) setForm(res.shop);
      setSaved(true);
    } catch {
      setError(t('admin.shop.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const togglePublished = async (ids: readonly string[], isPublished: boolean) => {
    try {
      await adminApi.setShopProducts(ids, isPublished);
      setProducts((prev) =>
        prev.map((p) => (ids.includes(p.productId) ? { ...p, isPublished } : p)),
      );
    } catch (err) {
      setError(describeApiError(err));
    }
  };

  const move = async (id: string, status: ShopOrderStatusDto) => {
    try {
      const res = await adminApi.setShopOrderStatus(id, status);
      setOrders((prev) => prev.map((o) => (o.id === id ? res.order : o)));
    } catch (err) {
      setError(describeApiError(err));
      void loadOrders();
    }
  };

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? products.filter((p) => p.name.toLowerCase().includes(q)) : products;
  }, [products, search]);
  const publishedCount = products.filter((p) => p.isPublished).length;

  const input = 'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm';

  return (
    <div className="space-y-6">
      <div>
        <h2 className="page-title">{t('admin.shop.title')}</h2>
        <p className="page-subtitle">{t('admin.shop.subtitle')}</p>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="card space-y-4 p-5 lg:col-span-2">
          <h3 className="text-base font-semibold text-slate-900">{t('admin.shop.settings')}</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span className="font-medium text-slate-600">{t('admin.shop.name')}</span>
              <input
                className={input}
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="font-medium text-slate-600">{t('admin.shop.slug')}</span>
              <div className="flex items-center rounded-lg border border-slate-300">
                <span className="pl-3 text-xs text-slate-400">/s/</span>
                <input
                  className="w-full rounded-lg px-1 py-2 text-sm outline-none"
                  value={form.slug}
                  onChange={(e) => setForm({ ...form, slug: e.target.value })}
                />
              </div>
              <span className="text-xs text-slate-400">{t('admin.shop.slugHint')}</span>
            </label>
            <label className="space-y-1 text-sm">
              <span className="font-medium text-slate-600">{t('admin.shop.phone')}</span>
              <input
                className={input}
                value={form.phone ?? ''}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="font-medium text-slate-600">{t('admin.shop.address')}</span>
              <input
                className={input}
                value={form.address ?? ''}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
              />
            </label>
            <label className="space-y-1 text-sm sm:col-span-2">
              <span className="font-medium text-slate-600">{t('admin.shop.about')}</span>
              <textarea
                className={input}
                rows={2}
                value={form.about ?? ''}
                onChange={(e) => setForm({ ...form, about: e.target.value })}
              />
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={form.isEnabled}
              onChange={(e) => setForm({ ...form, isEnabled: e.target.checked })}
            />
            {t('admin.shop.enabled')}
          </label>
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void save()}
            >
              {t('admin.shop.save')}
            </button>
            {saved && <span className="text-sm text-emerald-700">{t('admin.shop.saved')}</span>}
          </div>
        </div>

        <div className="card flex flex-col items-center gap-3 p-5 text-center">
          <h3 className="text-base font-semibold text-slate-900">{t('admin.shop.link')}</h3>
          {shop && shop.isEnabled ? (
            <>
              <QrSvg text={link} label={t('admin.shop.link')} />
              <a
                href={link}
                target="_blank"
                rel="noreferrer"
                className="break-all text-sm font-semibold text-indigo-700"
              >
                {link}
              </a>
              <button
                type="button"
                className="btn btn-soft"
                onClick={() => {
                  void navigator.clipboard?.writeText(link).then(() => setCopied(true));
                }}
              >
                <Icon name="receipt" className="h-4 w-4" />
                {copied ? t('admin.shop.copied') : t('admin.shop.copy')}
              </button>
              <p className="text-xs text-slate-500">{t('admin.shop.qrHint')}</p>
            </>
          ) : (
            <p className="text-sm text-slate-500">{t('admin.shop.linkOff')}</p>
          )}
        </div>
      </div>

      <div className="card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-6 py-4">
          <h3 className="text-base font-semibold text-slate-900">{t('admin.shop.orders')}</h3>
          <div className="flex items-center gap-2">
            <button type="button" className="btn btn-outline" onClick={() => setShowAll(!showAll)}>
              {showAll ? t('admin.shop.ordersOpen') : t('admin.shop.ordersAll')}
            </button>
            <button type="button" className="btn btn-soft" onClick={() => void loadOrders()}>
              <Icon name="refresh" className="h-4 w-4" />
              {t('admin.refresh')}
            </button>
          </div>
        </div>
        {orders.length === 0 ? (
          <p className="px-6 py-8 text-center text-sm text-slate-500">{t('admin.shop.noOrders')}</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {orders.map((o) => (
              <div key={o.id} className="space-y-3 px-6 py-4" data-testid="shop-order">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-3">
                    <span className="text-base font-bold text-slate-900">#{o.orderNo}</span>
                    <span
                      className={`rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${STATUS_TONE[o.status]}`}
                    >
                      {t(`admin.shop.status.${o.status}`)}
                    </span>
                    <span className="text-xs text-slate-500">{formatDateTime(o.createdAtMs)}</span>
                  </div>
                  <span className="text-base font-bold tabular-nums text-slate-900">
                    {formatSom(o.total)}
                  </span>
                </div>
                <div className="text-sm text-slate-700">
                  <strong>{o.customerName}</strong> ·{' '}
                  <a className="text-indigo-700" href={`tel:${o.customerPhone}`}>
                    {o.customerPhone}
                  </a>{' '}
                  ·{' '}
                  {o.fulfilment === 'delivery'
                    ? `${t('admin.shop.delivery')}: ${o.address ?? ''}`
                    : t('admin.shop.pickup')}
                  {o.note && <div className="mt-1 text-slate-500">{o.note}</div>}
                </div>
                <ul className="space-y-0.5 text-sm text-slate-600">
                  {o.lines.map((l) => (
                    <li key={l.productId} className="flex justify-between gap-3">
                      <span>
                        {l.name} — {formatQty(l.qty)} {unitLabel(l.unit)}
                      </span>
                      <span className="tabular-nums">{formatSom(l.total)}</span>
                    </li>
                  ))}
                </ul>
                {NEXT[o.status].length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {NEXT[o.status].map((s) => (
                      <button
                        key={s}
                        type="button"
                        className={`btn ${s === 'cancelled' ? 'btn-outline' : 'btn-primary'}`}
                        onClick={() => void move(o.id, s)}
                      >
                        {t(`admin.shop.action.${s}`)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-6 py-4">
          <div>
            <h3 className="text-base font-semibold text-slate-900">{t('admin.shop.products')}</h3>
            <p className="text-xs text-slate-500">
              {t('admin.shop.productsCount', {
                count: String(publishedCount),
                total: String(products.length),
              })}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
              placeholder={t('admin.shop.search')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button
              type="button"
              className="btn btn-soft"
              onClick={() =>
                void togglePublished(
                  visible.map((p) => p.productId),
                  true,
                )
              }
            >
              {t('admin.shop.publishAll')}
            </button>
          </div>
        </div>
        {visible.length === 0 ? (
          <p className="px-6 py-8 text-center text-sm text-slate-500">
            {t('admin.shop.noProducts')}
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th className="px-6 py-3">{t('admin.shop.onSale')}</th>
                <th className="px-3 py-3">{t('admin.shop.product')}</th>
                <th className="px-3 py-3 text-right">{t('admin.shop.price')}</th>
                <th className="px-6 py-3 text-right">{t('admin.shop.stock')}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((p) => (
                <tr key={p.productId}>
                  <td className="px-6 py-2.5">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={p.isPublished}
                      aria-label={p.name}
                      onChange={(e) => void togglePublished([p.productId], e.target.checked)}
                    />
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="font-medium text-slate-800">{p.name}</div>
                    {p.category && <div className="text-xs text-slate-400">{p.category}</div>}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{formatSom(p.price)}</td>
                  <td className="px-6 py-2.5 text-right tabular-nums">
                    {p.stock === null ? '∞' : `${formatQty(p.stock)} ${unitLabel(p.unit)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};
