import {
  type PlaceShopOrderResponseDto,
  type PublicShopProductDto,
  type PublicShopResponseDto,
  type ShopOrderDto,
} from '@mezon/contracts';
import { t } from '@mezon/i18n';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { formatQty, formatSom, unitLabel } from '../utils/format.js';
import { Icon } from './Icon.js';
import { LocaleSelect } from './LocaleSelect.js';

type Cart = Readonly<Record<string, number>>;
type OrderRef = { readonly id: string; readonly token: string } | null;
const EMPTY_CART: Cart = {};
const NO_ORDER: OrderRef = null;

const isWhole = (unit: string) => unit === 'dona' || unit === 'qadoq';
/** One "+" step: one piece, or 0.5 kg / l / m for goods sold by measure. */
const step = (unit: string) => (isWhole(unit) ? 1000 : 500);

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // private mode: the cart simply is not remembered
  }
}

const STATUS_STEPS = ['new', 'accepted', 'ready', 'done'] as const;

/**
 * V2 / F5 public shop window at `/s/<slug>`: no login, works on a phone, the cart lives in this
 * browser. Prices shown are informative; the server prices the order again when it is placed.
 */
export const PublicShopPage: React.FC<{ readonly slug: string }> = ({ slug }) => {
  const [data, setData] = useState<PublicShopResponseDto | null>(null);
  const [missing, setMissing] = useState(false);
  const [cart, setCart] = useState<Cart>(() => readJson(`guzar.cart.${slug}`, EMPTY_CART));
  const [category, setCategory] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [checkout, setCheckout] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('+998 ');
  const [fulfilment, setFulfilment] = useState<'pickup' | 'delivery'>('pickup');
  const [address, setAddress] = useState('');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [placed, setPlaced] = useState<OrderRef>(() => readJson(`guzar.order.${slug}`, NO_ORDER));
  const [order, setOrder] = useState<ShopOrderDto | null>(null);

  useEffect(() => {
    void fetch(`/api/v1/public/shops/${encodeURIComponent(slug)}`)
      .then(async (r) => {
        if (!r.ok) {
          setMissing(true);
          return;
        }
        const body = (await r.json()) as PublicShopResponseDto;
        setData(body);
        document.title = body.shop.title;
      })
      .catch(() => setMissing(true));
  }, [slug]);

  useEffect(() => writeJson(`guzar.cart.${slug}`, cart), [cart, slug]);

  const loadOrder = useCallback(async () => {
    if (!placed) return;
    const r = await fetch(
      `/api/v1/public/shops/${encodeURIComponent(slug)}/orders/${encodeURIComponent(placed.id)}?t=${encodeURIComponent(placed.token)}`,
    ).catch(() => null);
    if (r?.ok) setOrder(((await r.json()) as { order: ShopOrderDto }).order);
  }, [placed, slug]);

  useEffect(() => {
    void loadOrder();
    if (!placed) return undefined;
    const timer = setInterval(() => void loadOrder(), 20_000);
    return () => clearInterval(timer);
  }, [loadOrder, placed]);

  const products = data?.products ?? [];
  const categories = useMemo(
    () => [...new Set(products.map((p) => p.category).filter((c): c is string => c !== null))],
    [products],
  );
  const shown = products.filter(
    (p) =>
      (category === null || p.category === category) &&
      p.name.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const lines = Object.entries(cart)
    .map(([id, qty]) => ({ p: byId.get(id), qty }))
    .filter((l): l is { p: PublicShopProductDto; qty: number } => l.p !== undefined && l.qty > 0);
  const total = lines.reduce(
    (sum, l) => sum + (BigInt(l.p.price) * BigInt(l.qty) + 500n) / 1000n,
    0n,
  );
  const count = lines.length;

  const add = (p: PublicShopProductDto, dir: 1 | -1) =>
    setCart((c) => {
      const next = Math.max(0, (c[p.id] ?? 0) + dir * step(p.unit));
      const copy = { ...c };
      if (next === 0) delete copy[p.id];
      else copy[p.id] = next;
      return copy;
    });

  const submit = async () => {
    setSending(true);
    setError(null);
    try {
      const r = await fetch(`/api/v1/public/shops/${encodeURIComponent(slug)}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName: name,
          customerPhone: phone,
          fulfilment,
          ...(fulfilment === 'delivery' ? { address } : {}),
          ...(note.trim() ? { note } : {}),
          lines: lines.map((l) => ({ productId: l.p.id, qty: String(l.qty) })),
        }),
      });
      if (r.status === 409) {
        setError(t('shop.public.unavailable'));
        return;
      }
      if (!r.ok) {
        setError(r.status === 429 ? t('shop.public.tooMany') : t('shop.public.checkForm'));
        return;
      }
      const body = (await r.json()) as PlaceShopOrderResponseDto;
      const ref = { id: body.order.id, token: body.accessToken };
      writeJson(`guzar.order.${slug}`, ref);
      setPlaced(ref);
      setOrder(body.order);
      setCart({});
      setCheckout(false);
    } catch {
      setError(t('shop.public.network'));
    } finally {
      setSending(false);
    }
  };

  if (missing) {
    return (
      <div className="grid min-h-screen place-items-center bg-slate-50 p-6 text-center">
        <div className="space-y-2">
          <Icon name="store" className="mx-auto h-10 w-10 text-slate-300" />
          <p className="text-lg font-semibold text-slate-700">{t('shop.public.notFound')}</p>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="grid min-h-screen place-items-center bg-slate-50">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-indigo-600 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-28">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-700 text-lg font-extrabold text-white">
              {data.shop.title.trim().charAt(0).toUpperCase()}
            </span>
            <div className="min-w-0">
              <h1 className="truncate text-base font-bold text-slate-900">{data.shop.title}</h1>
              <p className="truncate text-xs text-slate-500">
                {[data.shop.address, data.shop.phone].filter(Boolean).join(' · ')}
              </p>
            </div>
          </div>
          <div className="w-28 shrink-0">
            <LocaleSelect />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-4 px-4 py-4">
        {order && (
          <div className="card space-y-3 p-4" data-testid="shop-order-status">
            <div className="flex items-center justify-between">
              <strong className="text-slate-900">
                {t('shop.public.yourOrder', { no: String(order.orderNo) })}
              </strong>
              <span className="font-bold tabular-nums">{formatSom(order.total)}</span>
            </div>
            {order.status === 'cancelled' ? (
              <p className="text-sm font-semibold text-red-700">
                {t('shop.public.status.cancelled')}
              </p>
            ) : (
              <ol className="grid grid-cols-4 gap-1 text-center text-[11px] font-semibold">
                {STATUS_STEPS.map((s, i) => {
                  const reached =
                    STATUS_STEPS.indexOf(order.status as (typeof STATUS_STEPS)[number]) >= i;
                  return (
                    <li
                      key={s}
                      className={`rounded-lg px-1 py-2 ${reached ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-500'}`}
                    >
                      {t(`shop.public.status.${s}`)}
                    </li>
                  );
                })}
              </ol>
            )}
            {(order.status === 'done' || order.status === 'cancelled') && (
              <button
                type="button"
                className="text-sm font-semibold text-indigo-700"
                onClick={() => {
                  writeJson(`guzar.order.${slug}`, null);
                  setPlaced(null);
                  setOrder(null);
                }}
              >
                {t('shop.public.hideOrder')}
              </button>
            )}
          </div>
        )}

        {data.shop.about && <p className="text-sm text-slate-600">{data.shop.about}</p>}

        <div className="space-y-3">
          <label className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2">
            <Icon name="search" className="h-4 w-4 text-slate-400" />
            <input
              className="w-full text-sm outline-none"
              placeholder={t('shop.public.search')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          {categories.length > 0 && (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {[null, ...categories].map((c) => (
                <button
                  key={c ?? 'all'}
                  type="button"
                  onClick={() => setCategory(c)}
                  className={`shrink-0 rounded-full px-3 py-1.5 text-sm font-semibold ${
                    category === c
                      ? 'bg-indigo-600 text-white'
                      : 'bg-white text-slate-600 ring-1 ring-slate-200'
                  }`}
                >
                  {c ?? t('shop.public.all')}
                </button>
              ))}
            </div>
          )}
        </div>

        {shown.length === 0 ? (
          <p className="py-10 text-center text-sm text-slate-500">{t('shop.public.empty')}</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {shown.map((p) => {
              const qty = cart[p.id] ?? 0;
              return (
                <div
                  key={p.id}
                  className="card flex flex-col justify-between gap-3 p-3"
                  data-testid="shop-product"
                >
                  <div className="space-y-1">
                    {p.image ? (
                      <img
                        src={p.image}
                        alt={p.name}
                        loading="lazy"
                        className="aspect-square w-full rounded-xl bg-slate-100 object-cover"
                        data-testid="shop-product-image"
                      />
                    ) : (
                      <span className="grid h-10 w-10 place-items-center rounded-xl bg-indigo-50 text-sm font-bold text-indigo-700">
                        {p.name.trim().charAt(0).toUpperCase()}
                      </span>
                    )}
                    <div className="text-sm font-semibold leading-snug text-slate-800">
                      {p.name}
                    </div>
                    <div className="text-sm font-bold text-indigo-700">
                      {formatSom(p.price)}
                      <span className="text-xs font-medium text-slate-400">
                        {' '}
                        / {unitLabel(p.unit)}
                      </span>
                    </div>
                  </div>
                  {!p.available ? (
                    <span className="rounded-lg bg-slate-100 py-2 text-center text-xs font-semibold text-slate-500">
                      {t('shop.public.soldOut')}
                    </span>
                  ) : qty === 0 ? (
                    <button
                      type="button"
                      className="btn btn-primary w-full"
                      onClick={() => add(p, 1)}
                    >
                      {t('shop.public.add')}
                    </button>
                  ) : (
                    <div className="flex items-center justify-between rounded-lg bg-indigo-50">
                      <button
                        type="button"
                        className="px-3 py-2 text-lg font-bold text-indigo-700"
                        onClick={() => add(p, -1)}
                      >
                        −
                      </button>
                      <span className="text-sm font-bold text-indigo-800">
                        {formatQty(String(qty))} {unitLabel(p.unit)}
                      </span>
                      <button
                        type="button"
                        className="px-3 py-2 text-lg font-bold text-indigo-700"
                        onClick={() => add(p, 1)}
                      >
                        +
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </main>

      {count > 0 && !checkout && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white p-3">
          <button
            type="button"
            className="btn btn-primary mx-auto flex w-full max-w-5xl justify-between py-3 text-base"
            data-testid="shop-cart-btn"
            onClick={() => setCheckout(true)}
          >
            <span>{t('shop.public.cart', { count: String(count) })}</span>
            <span className="tabular-nums">{formatSom(total.toString())}</span>
          </button>
        </div>
      )}

      {checkout && (
        <div className="fixed inset-0 z-40 flex items-end justify-center bg-slate-900/40 sm:items-center">
          <div className="max-h-[92vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-t-2xl bg-white p-5 sm:rounded-2xl">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-slate-900">{t('shop.public.checkout')}</h2>
              <button
                type="button"
                aria-label={t('admin.menu.close')}
                onClick={() => setCheckout(false)}
              >
                <Icon name="close" />
              </button>
            </div>
            <ul className="space-y-1 text-sm">
              {lines.map((l) => (
                <li key={l.p.id} className="flex justify-between gap-3">
                  <span>
                    {l.p.name} — {formatQty(String(l.qty))} {unitLabel(l.p.unit)}
                  </span>
                  <span className="tabular-nums">
                    {formatSom(((BigInt(l.p.price) * BigInt(l.qty) + 500n) / 1000n).toString())}
                  </span>
                </li>
              ))}
              <li className="flex justify-between border-t border-slate-100 pt-2 font-bold">
                <span>{t('shop.public.total')}</span>
                <span className="tabular-nums">{formatSom(total.toString())}</span>
              </li>
            </ul>
            <div className="space-y-3 text-sm">
              <input
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5"
                placeholder={t('shop.public.name')}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <input
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5"
                placeholder={t('shop.public.phone')}
                inputMode="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
              <div className="grid grid-cols-2 gap-2">
                {(['pickup', 'delivery'] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setFulfilment(f)}
                    className={`rounded-lg px-3 py-2.5 font-semibold ${
                      fulfilment === f ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-700'
                    }`}
                  >
                    {t(`shop.public.${f}`)}
                  </button>
                ))}
              </div>
              {fulfilment === 'delivery' && (
                <input
                  className="w-full rounded-lg border border-slate-300 px-3 py-2.5"
                  placeholder={t('shop.public.address')}
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                />
              )}
              <textarea
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5"
                rows={2}
                placeholder={t('shop.public.note')}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
            {error && <p className="text-sm font-semibold text-red-700">{error}</p>}
            <button
              type="button"
              className="btn btn-primary w-full py-3 text-base"
              disabled={sending || name.trim().length < 2}
              data-testid="shop-place-order"
              onClick={() => void submit()}
            >
              {sending ? t('shop.public.sending') : t('shop.public.place')}
            </button>
            <p className="text-center text-xs text-slate-500">{t('shop.public.payHint')}</p>
          </div>
        </div>
      )}
    </div>
  );
};
