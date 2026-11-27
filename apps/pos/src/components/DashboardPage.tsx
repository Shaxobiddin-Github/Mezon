import type { DashboardResponseDto } from '@mezon/contracts';
import { t } from '@mezon/i18n';
import { formatTiyinToSom } from '@mezon/ui';
import { useCallback, useEffect, useState } from 'react';
import type { HubApiClient } from '../api/hub-client.js';
import type { PosSection } from '../store/pos-store.js';
import { Icon, type IconName } from './Icon.js';

/** "1 234 567" → "1,2 mln" style short amount for the week chart labels (so'm, not tiyin). */
export function shortSom(tiyin: string): string {
  const som = BigInt(tiyin) / 100n;
  const abs = som < 0n ? -som : som;
  const sign = som < 0n ? '−' : '';
  if (abs >= 1_000_000_000n) return `${sign}${fmt1(abs, 1_000_000_000n)} mlrd`;
  if (abs >= 1_000_000n) return `${sign}${fmt1(abs, 1_000_000n)} mln`;
  if (abs >= 1_000n) return `${sign}${(abs / 1_000n).toString()} ming`;
  return `${sign}${abs.toString()}`;
}

function fmt1(value: bigint, unit: bigint): string {
  const tenths = (value * 10n) / unit;
  const whole = tenths / 10n;
  const frac = tenths % 10n;
  return frac === 0n ? whole.toString() : `${whole.toString()},${frac.toString()}`;
}

/** Change of today against yesterday in whole percent; null when yesterday had no sales. */
export function percentChange(today: string, yesterday: string): number | null {
  const y = BigInt(yesterday);
  if (y <= 0n) return null;
  return Number(((BigInt(today) - y) * 100n) / y);
}

/** Markup of the shelf value over the purchase value, whole percent (owner only). */
export function markupPercent(cost: string | null, retail: string): number | null {
  if (cost === null) return null;
  const c = BigInt(cost);
  if (c <= 0n) return null;
  return Number(((BigInt(retail) - c) * 100n) / c);
}

const WEEKDAY_KEYS = [
  'dashboard.wd.sun',
  'dashboard.wd.mon',
  'dashboard.wd.tue',
  'dashboard.wd.wed',
  'dashboard.wd.thu',
  'dashboard.wd.fri',
  'dashboard.wd.sat',
] as const;

function weekdayOf(date: string): (typeof WEEKDAY_KEYS)[number] {
  const [y, m, d] = date.split('-').map(Number);
  const wd = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay();
  return WEEKDAY_KEYS[wd] ?? 'dashboard.wd.mon';
}

function Stat(props: {
  readonly icon: IconName;
  readonly label: string;
  readonly value: string;
  readonly tone?: 'good' | 'warn' | 'bad' | 'plain';
  readonly testId: string;
}) {
  return (
    <div className={`pos-dash-stat pos-dash-${props.tone ?? 'plain'}`} data-testid={props.testId}>
      <span className="pos-dash-stat-icon" aria-hidden="true">
        <Icon name={props.icon} />
      </span>
      <span className="pos-dash-stat-label">{props.label}</span>
      <strong className="pos-dash-stat-value">{props.value}</strong>
    </div>
  );
}

/**
 * C23 owner home: how today goes, the last 7 days, who owes whom, and what the shelves are worth.
 * Owners also see profit and the purchase value of the stock; managers do not.
 */
export function DashboardPage(props: {
  readonly api: HubApiClient;
  readonly isOwner: boolean;
  readonly onGo: (section: PosSection) => void;
  readonly onError: (err: unknown) => void;
}) {
  const { api, isOwner, onGo, onError } = props;
  const [data, setData] = useState<DashboardResponseDto | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.getDashboard());
    } catch (err) {
      onError(err);
    } finally {
      setLoading(false);
    }
  }, [api, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const som = (tiyin: string) => `${formatTiyinToSom(tiyin)} ${t('common.currency')}`;

  if (data === null) {
    return (
      <div className="pos-dash" data-testid="dashboard-page">
        <p className="pos-dash-loading">{t('dashboard.loading')}</p>
      </div>
    );
  }

  const change = percentChange(data.today.netSales, data.yesterdayNetSales);
  const maxDay = data.week.reduce((m, d) => (BigInt(d.netSales) > m ? BigInt(d.netSales) : m), 0n);
  const markup = markupPercent(data.stock.costValue, data.stock.retailValue);

  return (
    <div className="pos-dash" data-testid="dashboard-page">
      <section className="pos-dash-hero">
        <div className="pos-dash-hero-top">
          <span>{t('dashboard.todaySales')}</span>
          <button
            type="button"
            className="pos-btn pos-dash-refresh"
            data-testid="dashboard-refresh"
            disabled={loading}
            onClick={() => void load()}
            aria-label={t('dashboard.refresh')}
            title={t('dashboard.refresh')}
          >
            <Icon name="refresh" />
          </button>
        </div>
        <strong className="pos-dash-hero-value" data-testid="dashboard-today-sales">
          {som(data.today.netSales)}
        </strong>
        <div className="pos-dash-hero-sub">
          <span>{t('dashboard.receipts', { count: String(data.today.salesCount) })}</span>
          {change !== null && (
            <span
              className={`pos-dash-change ${change >= 0 ? 'pos-dash-up' : 'pos-dash-down'}`}
              data-testid="dashboard-change"
            >
              {change >= 0 ? '▲' : '▼'} {Math.abs(change)}% {t('dashboard.vsYesterday')}
            </span>
          )}
        </div>
      </section>

      <div className="pos-dash-grid">
        {data.today.grossProfit !== null && (
          <Stat
            icon="chart"
            label={t('dashboard.profit')}
            value={som(data.today.grossProfit)}
            tone="good"
            testId="dashboard-profit"
          />
        )}
        <Stat
          icon="cash"
          label={t('dashboard.cash')}
          value={som(data.today.cashSales)}
          testId="dashboard-cash"
        />
        <Stat
          icon="card"
          label={t('dashboard.nonCash')}
          value={som(data.today.nonCashSales)}
          testId="dashboard-noncash"
        />
        <Stat
          icon="debt"
          label={t('dashboard.newDebt')}
          value={som(data.today.newDebt)}
          tone="warn"
          testId="dashboard-new-debt"
        />
        <Stat
          icon="wallet"
          label={t('dashboard.debtCollected')}
          value={som(data.today.debtCollected)}
          tone="good"
          testId="dashboard-debt-collected"
        />
        <Stat
          icon="arrowOut"
          label={t('dashboard.expenses')}
          value={som(data.today.expenses)}
          tone="bad"
          testId="dashboard-expenses"
        />
      </div>

      <section className="pos-dash-card">
        <h3>{t('dashboard.week')}</h3>
        <div className="pos-dash-chart" data-testid="dashboard-week">
          {data.week.map((d, i) => {
            const v = BigInt(d.netSales);
            const pct = maxDay > 0n ? Number((v * 100n) / maxDay) : 0;
            const isToday = i === data.week.length - 1;
            return (
              <div
                key={d.date}
                className="pos-dash-bar-col"
                title={`${d.date}: ${som(d.netSales)}`}
              >
                <span className="pos-dash-bar-val">{v > 0n ? shortSom(d.netSales) : ''}</span>
                <div className="pos-dash-bar-track">
                  <div
                    className={`pos-dash-bar ${isToday ? 'pos-dash-bar-today' : ''}`}
                    style={{ height: `${String(Math.max(pct, v > 0n ? 4 : 0))}%` }}
                  />
                </div>
                <span className="pos-dash-bar-day">{t(weekdayOf(d.date))}</span>
              </div>
            );
          })}
        </div>
      </section>

      <div className="pos-dash-two">
        <section className="pos-dash-card">
          <h3>{t('dashboard.debts')}</h3>
          <div className="pos-dash-row">
            <span>{t('dashboard.customersOwe')}</span>
            <strong data-testid="dashboard-customer-debt">{som(data.customerDebtTotal)}</strong>
          </div>
          <div className="pos-dash-row">
            <span>{t('dashboard.weOwe')}</span>
            <strong>{som(data.supplierDebtTotal)}</strong>
          </div>
        </section>

        <section className="pos-dash-card">
          <h3>{t('dashboard.stock')}</h3>
          {data.stock.costValue !== null && (
            <div className="pos-dash-row">
              <span>{t('dashboard.atCost')}</span>
              <strong>{som(data.stock.costValue)}</strong>
            </div>
          )}
          <div className="pos-dash-row">
            <span>{t('dashboard.atRetail')}</span>
            <strong data-testid="dashboard-stock-retail">{som(data.stock.retailValue)}</strong>
          </div>
          {markup !== null && (
            <div className="pos-dash-row">
              <span>{t('dashboard.markup')}</span>
              <strong className="pos-dash-up">+{markup}%</strong>
            </div>
          )}
          <div className="pos-dash-pills">
            <span className="pos-dash-pill">
              {t('dashboard.inStock', { count: String(data.stock.productsInStock) })}
            </span>
            <span className="pos-dash-pill pos-dash-pill-warn">
              {t('dashboard.low', { count: String(data.stock.lowStock) })}
            </span>
            <span className="pos-dash-pill pos-dash-pill-bad">
              {t('dashboard.out', { count: String(data.stock.outOfStock) })}
            </span>
          </div>
        </section>
      </div>

      <div className="pos-dash-actions">
        <button
          type="button"
          className="pos-btn pos-btn-primary pos-btn-xl"
          onClick={() => onGo('sale')}
        >
          <Icon name="sale" />
          {t('dashboard.goSale')}
        </button>
        <button type="button" className="pos-btn pos-btn-xl" onClick={() => onGo('products')}>
          <Icon name="products" />
          {t('dashboard.goProducts')}
        </button>
        <button type="button" className="pos-btn pos-btn-xl" onClick={() => onGo('receipts')}>
          <Icon name="receipts" />
          {t('dashboard.goReceipts')}
        </button>
      </div>
      {!isOwner && <p className="pos-form-hint">{t('dashboard.managerNote')}</p>}
    </div>
  );
}
