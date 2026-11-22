import type { SaleListItemDto, SaleReturnContextResponseDto } from '@mezon/contracts';
import { parseQuantityDecimal, quantityToMilli } from '@mezon/domain';
import { t } from '@mezon/i18n';
import { formatMilliToQtyString, formatTiyinToSom } from '@mezon/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { type HubApiClient, HubApiError } from '../api/hub-client.js';
import { generateBrowserUuidV7 } from '../utils/browser-uuid.js';
import { describeHubError } from '../utils/error-text.js';
import { lineRefundTiyin, planRefund, remainingQtyMilli } from '../utils/return-plan.js';
import { Icon } from './Icon.js';

type Period = 'today' | 'yesterday' | 'week' | 'all';
const PAGE = 50;

function periodRange(period: Period, now = new Date()): { fromMs?: string; toMs?: string } {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 24 * 60 * 60 * 1000;
  if (period === 'today') return { fromMs: String(startOfToday) };
  if (period === 'yesterday')
    return { fromMs: String(startOfToday - day), toMs: String(startOfToday) };
  if (period === 'week') return { fromMs: String(startOfToday - 6 * day) };
  return {};
}

function formatTime(ms: string): string {
  const d = new Date(Number(ms));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function statusOf(s: SaleListItemDto): { key: string; tone: string } {
  if (s.status === 'voided') return { key: 'receipts.status.voided', tone: 'danger' };
  const returned = BigInt(s.returnedTotal);
  if (returned > 0n && returned >= BigInt(s.totalFinal)) {
    return { key: 'receipts.status.returned', tone: 'warning' };
  }
  if (returned > 0n) return { key: 'receipts.status.partReturned', tone: 'warning' };
  return { key: 'receipts.status.completed', tone: 'success' };
}

function som(tiyin: string | bigint): string {
  return `${formatTiyinToSom(typeof tiyin === 'bigint' ? tiyin : BigInt(tiyin))} ${t('common.currency')}`;
}

/** C12: receipts history with detail, reprint and return (owner 11-21: a proper section). */
export function ReceiptsPage(props: {
  readonly api: HubApiClient;
  readonly role: 'owner' | 'manager' | 'cashier' | null;
  readonly onError: (err: unknown) => void;
}) {
  const { api, role, onError } = props;
  const [period, setPeriod] = useState<Period>('today');
  const [query, setQuery] = useState('');
  const [sales, setSales] = useState<readonly SaleListItemDto[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ctx, setCtx] = useState<SaleReturnContextResponseDto | null>(null);
  const [returning, setReturning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(
    async (offset: number) => {
      try {
        const res = await api.listSales({ q: query, ...periodRange(period), limit: PAGE, offset });
        setSales((prev) => (offset === 0 ? res.sales : [...prev, ...res.sales]));
        setHasMore(res.sales.length === PAGE);
      } catch (err) {
        onError(err);
      }
    },
    [api, query, period, onError],
  );

  useEffect(() => {
    const id = setTimeout(() => void load(0), 200);
    return () => clearTimeout(id);
  }, [load]);

  const loadContext = useCallback(
    async (saleId: string) => {
      try {
        setCtx(await api.getSaleReturnContext(saleId));
      } catch (err) {
        onError(err);
      }
    },
    [api, onError],
  );

  useEffect(() => {
    setNotice(null);
    if (selectedId === null) {
      setCtx(null);
      return;
    }
    void loadContext(selectedId);
  }, [selectedId, loadContext]);

  const canReturn =
    ctx !== null &&
    ctx.sale.status === 'completed' &&
    ctx.lines.some((l) => remainingQtyMilli(l) > 0n);

  const reprint = async () => {
    if (!ctx) return;
    try {
      const res = await api.printSaleReceipt(ctx.sale.id, {
        clientRequestId: generateBrowserUuidV7(),
        reprint: true,
      });
      setNotice(
        res.printRecord.status === 'disabled'
          ? t('receipts.printDisabled')
          : t('receipts.reprinted'),
      );
    } catch (err) {
      onError(err);
    }
  };

  return (
    <section className="pos-page" data-testid="receipts-page">
      <header className="pos-page-header">
        <div>
          <h2 className="pos-page-title pos-title-icon">
            <Icon name="receipts" />
            {t('receipts.title')}
          </h2>
          <p className="pos-page-subtitle">{t('receipts.subtitle')}</p>
        </div>
        <div className="pos-toolbar-row">
          <input
            className="pos-input pos-input-search"
            data-testid="receipts-search"
            placeholder={t('receipts.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="pos-segmented" role="tablist">
            {(['today', 'yesterday', 'week', 'all'] as const).map((p) => (
              <button
                key={p}
                type="button"
                role="tab"
                aria-selected={period === p}
                className={period === p ? 'pos-segmented-active' : ''}
                data-testid={`receipts-period-${p}`}
                onClick={() => setPeriod(p)}
              >
                {t(`receipts.period.${p}`)}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="pos-split">
        <div className="pos-card pos-card-flush">
          {sales.length === 0 ? (
            <p className="pos-empty" data-testid="receipts-empty">
              {t('receipts.empty')}
            </p>
          ) : (
            <table className="pos-table" data-testid="receipts-table">
              <thead>
                <tr>
                  <th>{t('receipts.col.no')}</th>
                  <th>{t('receipts.col.time')}</th>
                  <th>{t('receipts.col.cashier')}</th>
                  <th className="pos-num">{t('receipts.col.total')}</th>
                  <th>{t('receipts.col.status')}</th>
                </tr>
              </thead>
              <tbody>
                {sales.map((s) => {
                  const st = statusOf(s);
                  return (
                    <tr
                      key={s.id}
                      className={`pos-row-click ${selectedId === s.id ? 'pos-cart-row-selected' : ''}`}
                      data-testid={`receipts-row-${s.receiptNo}`}
                      onClick={() => setSelectedId(s.id)}
                    >
                      <td>
                        <strong>№{s.receiptNo}</strong>
                        <div className="pos-muted pos-small">{s.receiptCode}</div>
                      </td>
                      <td className="pos-muted">{formatTime(s.createdAtMs)}</td>
                      <td className="pos-muted">{s.cashierName ?? '—'}</td>
                      <td className="pos-num">
                        <strong>{som(s.totalFinal)}</strong>
                      </td>
                      <td>
                        <span className={`pos-badge pos-badge-${st.tone}`}>
                          {t(st.key as 'receipts.status.completed')}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {hasMore && (
            <div className="pos-card-footer">
              <button type="button" className="pos-btn" onClick={() => void load(sales.length)}>
                {t('receipts.loadMore')}
              </button>
            </div>
          )}
        </div>

        <aside className="pos-card pos-detail" data-testid="receipt-detail">
          {ctx === null ? (
            <p className="pos-empty">{t('receipts.selectHint')}</p>
          ) : (
            <>
              <div className="pos-detail-head">
                <div>
                  <h3>{t('receipts.detail.title', { code: `№${ctx.sale.receiptNo}` })}</h3>
                  <div className="pos-muted pos-small">
                    {ctx.sale.receiptCode} · {formatTime(ctx.sale.createdAtMs)}
                    {ctx.sale.customerName ? ` · ${ctx.sale.customerName}` : ''}
                  </div>
                </div>
                <span className={`pos-badge pos-badge-${statusOf(ctx.sale).tone}`}>
                  {t(statusOf(ctx.sale).key as 'receipts.status.completed')}
                </span>
              </div>

              <ul className="pos-line-list">
                {ctx.lines.map((l) => (
                  <li key={l.id}>
                    <div>
                      <div className="pos-line-name">{l.itemName}</div>
                      <div className="pos-muted pos-small">
                        {formatMilliToQtyString(l.qty)} {t(`unit.${l.unit}`)} ×{' '}
                        {formatTiyinToSom(BigInt(l.unitPriceSnapshot))}
                        {BigInt(l.returnedQty) > 0n && (
                          <span className="pos-returned-note">
                            {' · '}
                            {t('receipts.detail.returned', {
                              qty: `${formatMilliToQtyString(l.returnedQty)} ${t(`unit.${l.unit}`)}`,
                            })}
                          </span>
                        )}
                      </div>
                    </div>
                    <strong className="pos-num">{som(l.finalTotal)}</strong>
                  </li>
                ))}
              </ul>

              <dl className="pos-summary">
                <div>
                  <dt>{t('pos.totalPayable')}</dt>
                  <dd>{som(ctx.sale.totalFinal)}</dd>
                </div>
                <div>
                  <dt>{t('receipts.detail.paid')}</dt>
                  <dd>
                    {som(ctx.sale.totalPaid)}{' '}
                    <span className="pos-muted pos-small">
                      ({ctx.sale.paymentMethods.map((m) => t(`payment.method.${m}`)).join(', ')})
                    </span>
                  </dd>
                </div>
                {BigInt(ctx.sale.debtAmount) > 0n && (
                  <div>
                    <dt>{t('receipts.detail.debt')}</dt>
                    <dd>{som(ctx.sale.debtAmount)}</dd>
                  </div>
                )}
                {BigInt(ctx.sale.returnedTotal) > 0n && (
                  <div>
                    <dt>{t('receipts.detail.returnedTotal')}</dt>
                    <dd className="pos-text-danger">−{som(ctx.sale.returnedTotal)}</dd>
                  </div>
                )}
              </dl>

              {notice && (
                <div className="pos-success-banner" role="status" data-testid="receipts-notice">
                  {notice}
                </div>
              )}

              <div className="pos-detail-actions">
                <button
                  type="button"
                  className="pos-btn"
                  data-testid="receipt-reprint-btn"
                  onClick={() => void reprint()}
                >
                  {t('receipts.reprint')}
                </button>
                <button
                  type="button"
                  className="pos-btn pos-btn-primary"
                  data-testid="receipt-return-btn"
                  disabled={!canReturn}
                  onClick={() => setReturning(true)}
                >
                  {t('receipts.return')}
                </button>
              </div>
            </>
          )}
        </aside>
      </div>

      {returning && ctx && (
        <ReturnModal
          api={api}
          ctx={ctx}
          needsSupervisor={role === 'cashier'}
          onClose={() => setReturning(false)}
          onDone={(message) => {
            setReturning(false);
            setNotice(message);
            void loadContext(ctx.sale.id);
            void load(0);
          }}
        />
      )}
    </section>
  );
}

function ReturnModal(props: {
  readonly api: HubApiClient;
  readonly ctx: SaleReturnContextResponseDto;
  readonly needsSupervisor: boolean;
  readonly onClose: () => void;
  readonly onDone: (message: string) => void;
}) {
  const { api, ctx, onClose, onDone } = props;
  const [qtyText, setQtyText] = useState<Readonly<Record<string, string>>>({});
  const [reason, setReason] = useState('');
  const [supervisor, setSupervisor] = useState({ username: '', pin: '' });
  const [showSupervisor, setShowSupervisor] = useState(props.needsSupervisor);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // One id per dialog: a retry after a network error is the same return, never a second one.
  const [clientRequestId] = useState(() => generateBrowserUuidV7());

  const computed = useMemo(() => {
    let total = 0n;
    const items: { saleLineId: string; qty: string }[] = [];
    const perLine: Record<string, bigint | null> = {};
    let invalid = false;
    for (const line of ctx.lines) {
      const raw = (qtyText[line.id] ?? '').trim().replace(',', '.');
      if (raw === '' || raw === '0') continue;
      try {
        const milli = quantityToMilli(parseQuantityDecimal(raw));
        const refund = lineRefundTiyin(line, milli);
        perLine[line.id] = refund;
        total += refund;
        items.push({ saleLineId: line.id, qty: milli.toString() });
      } catch {
        perLine[line.id] = null;
        invalid = true;
      }
    }
    return { total, items, perLine, invalid, plan: planRefund(total, ctx) };
  }, [ctx, qtyText]);

  const submit = async () => {
    if (computed.items.length === 0 || computed.invalid) {
      setError(t('return.nothing'));
      return;
    }
    if (reason.trim() === '') {
      setError(t('return.reasonRequired'));
      return;
    }
    if (computed.plan === null) {
      setError(t('return.noLimit'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await api.createReturn(ctx.sale.id, {
        clientRequestId,
        reason: reason.trim(),
        items: computed.items,
        payments: computed.plan.payments.map((p) => ({
          method: p.method,
          amount: p.amount.toString(),
        })),
        ...(computed.plan.debtOffset > 0n
          ? { debtOffsetAmount: computed.plan.debtOffset.toString() }
          : {}),
        ...(showSupervisor && supervisor.username !== '' && supervisor.pin !== ''
          ? { override: { username: supervisor.username, pin: supervisor.pin } }
          : {}),
      });
      onDone(t('return.done', { amount: formatTiyinToSom(BigInt(res.returnDoc.totalRefund)) }));
    } catch (err) {
      if (err instanceof HubApiError && err.code === 'SUPERVISOR_OVERRIDE_REQUIRED') {
        setShowSupervisor(true);
        setError(t('error.SUPERVISOR_OVERRIDE_REQUIRED_RETURN'));
      } else {
        setError(describeHubError(err));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="pos-modal-backdrop" data-testid="return-modal">
      <div className="pos-modal-card pos-modal-wide">
        <div className="pos-modal-header">
          <h3 className="pos-modal-title">
            {t('return.title', { code: `№${ctx.sale.receiptNo}` })}
          </h3>
          <button type="button" className="pos-btn" onClick={onClose}>
            <Icon name="close" />
            {t('common.close')}
          </button>
        </div>
        <div className="pos-modal-body">
          <table className="pos-table">
            <thead>
              <tr>
                <th>{t('return.colItem')}</th>
                <th className="pos-num">{t('return.colSold')}</th>
                <th>{t('return.colReturn')}</th>
                <th className="pos-num">{t('return.colRefund')}</th>
              </tr>
            </thead>
            <tbody>
              {ctx.lines.map((line, idx) => {
                const left = remainingQtyMilli(line);
                const refund = computed.perLine[line.id];
                return (
                  <tr key={line.id}>
                    <td>
                      <strong>{line.itemName}</strong>
                    </td>
                    <td className="pos-num pos-muted">
                      {formatMilliToQtyString(left)} / {formatMilliToQtyString(line.qty)}{' '}
                      {t(`unit.${line.unit}`)}
                    </td>
                    <td>
                      <div className="pos-qty-controls">
                        <input
                          className="pos-input pos-input-qty"
                          inputMode="decimal"
                          data-testid={`return-qty-${String(idx)}`}
                          disabled={left === 0n}
                          value={qtyText[line.id] ?? ''}
                          placeholder="0"
                          onChange={(e) => setQtyText({ ...qtyText, [line.id]: e.target.value })}
                        />
                        <button
                          type="button"
                          className="pos-btn pos-btn-ghost"
                          disabled={left === 0n}
                          data-testid={`return-all-${String(idx)}`}
                          onClick={() =>
                            setQtyText({ ...qtyText, [line.id]: formatMilliToQtyString(left) })
                          }
                        >
                          {t('return.all')}
                        </button>
                      </div>
                    </td>
                    <td className="pos-num">
                      {refund === undefined ? '—' : refund === null ? '!' : som(refund)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <label className="pos-form-field">
            <span>{t('return.reason')}</span>
            <input
              className="pos-input"
              data-testid="return-reason"
              placeholder={t('return.reasonPlaceholder')}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>

          <div className="pos-totals-box">
            {computed.plan !== null && computed.plan.debtOffset > 0n && (
              <div className="pos-totals-row">
                <span>{t('return.debtOffset')}</span>
                <span>{som(computed.plan.debtOffset)}</span>
              </div>
            )}
            {computed.plan?.payments.map((p) => (
              <div className="pos-totals-row" key={p.method}>
                <span>{t('return.byMethod', { method: t(`payment.method.${p.method}`) })}</span>
                <span>{som(p.amount)}</span>
              </div>
            ))}
            <div className="pos-totals-grand">
              <span>{t('return.total')}</span>
              <span data-testid="return-total">{som(computed.total)}</span>
            </div>
          </div>

          {showSupervisor && (
            <div className="pos-warning-banner pos-supervisor" data-testid="return-supervisor-box">
              <strong>{t('supervisor.title')}</strong>
              <div className="pos-form-row">
                <label className="pos-form-field">
                  <span>{t('supervisor.username')}</span>
                  <input
                    className="pos-input"
                    data-testid="return-supervisor-username"
                    value={supervisor.username}
                    onChange={(e) => setSupervisor({ ...supervisor, username: e.target.value })}
                  />
                </label>
                <label className="pos-form-field">
                  <span>{t('supervisor.pin')}</span>
                  <input
                    className="pos-input"
                    type="password"
                    inputMode="numeric"
                    data-testid="return-supervisor-pin"
                    value={supervisor.pin}
                    onChange={(e) => setSupervisor({ ...supervisor, pin: e.target.value })}
                  />
                </label>
              </div>
            </div>
          )}

          {error && (
            <div className="pos-error-banner" role="alert" data-testid="return-error">
              {error}
            </div>
          )}
        </div>
        <div className="pos-modal-footer">
          <button type="button" className="pos-btn" onClick={onClose}>
            <Icon name="close" />
            {t('common.close')}
          </button>
          <button
            type="button"
            className="pos-btn pos-btn-primary"
            data-testid="return-submit"
            disabled={saving}
            onClick={() => void submit()}
          >
            {t('return.submit')}
          </button>
        </div>
      </div>
    </div>
  );
}
