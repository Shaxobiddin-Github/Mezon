import { type Locale, t } from '@mezon/i18n';
import { formatTiyinToSom } from '@mezon/ui';

/** Telegram caps a message at 4096 characters; names are user data, keep them short. */
const MAX_NAME = 80;

export function clip(text: string, max = MAX_NAME): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function som(tiyin: bigint, locale: Locale): string {
  return `${formatTiyinToSom(tiyin)} ${t('common.currency', undefined, locale)}`;
}

/** C24 customer menu rows in the chat's language. */
export function menuRows(locale: Locale): string[][] {
  return [
    [t('telegram.menu.debts', undefined, locale), t('telegram.menu.shop', undefined, locale)],
    [t('telegram.menu.lang', undefined, locale)],
  ];
}

/** Which menu button a text is (any language), or null. */
export function menuAction(text: string): 'debts' | 'shop' | 'lang' | null {
  const clean = text.trim();
  for (const locale of ['uz-Latn', 'ru'] as const) {
    if (clean === t('telegram.menu.debts', undefined, locale)) return 'debts';
    if (clean === t('telegram.menu.shop', undefined, locale)) return 'shop';
    if (clean === t('telegram.menu.lang', undefined, locale)) return 'lang';
  }
  return null;
}

function dayOf(ms: bigint, tz: string): string {
  const key = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Number(ms)));
  const [y, m, d] = key.split('-');
  return `${d ?? ''}.${m ?? ''}.${y ?? ''}`;
}

export interface CustomerCardFigures {
  readonly shopName: string;
  readonly customerName: string;
  readonly balanceTiyin: bigint;
  readonly overdueTiyin: bigint;
  readonly recentDebts: readonly {
    readonly receiptCode: string | null;
    readonly amountTiyin: bigint;
    readonly createdAtMs: bigint;
    readonly dueAtMs: bigint | null;
  }[];
}

/** C24 "Qarzlarim": one shop's balance and the latest credit receipts (plain text). */
export function formatCustomerCard(c: CustomerCardFigures, locale: Locale, tz: string): string {
  const lines = [
    t('telegram.debts.head', { shop: clip(c.shopName), name: clip(c.customerName) }, locale),
  ];
  if (c.balanceTiyin <= 0n) {
    lines.push(t('telegram.debts.none', undefined, locale));
    return lines.join('\n');
  }
  lines.push(t('telegram.debts.balance', { amount: som(c.balanceTiyin, locale) }, locale));
  if (c.overdueTiyin > 0n) {
    lines.push(t('telegram.debts.overdue', { amount: som(c.overdueTiyin, locale) }, locale));
  }
  if (c.recentDebts.length > 0) {
    lines.push('', t('telegram.debts.recent', undefined, locale));
    for (const d of c.recentDebts) {
      const due =
        d.dueAtMs !== null ? t('telegram.debts.due', { date: dayOf(d.dueAtMs, tz) }, locale) : '';
      lines.push(
        t(
          'telegram.debts.line',
          {
            date: dayOf(d.createdAtMs, tz),
            code: d.receiptCode ?? '—',
            amount: som(d.amountTiyin, locale),
            due,
          },
          locale,
        ),
      );
    }
  }
  lines.push('', t('telegram.debts.footer', undefined, locale));
  return lines.join('\n');
}

export function localeFromTelegram(languageCode: string | undefined): Locale {
  return languageCode?.toLowerCase().startsWith('ru') ? 'ru' : 'uz-Latn';
}

export interface DigestFigures {
  readonly organizationName: string;
  readonly date: string;
  readonly netTiyin: bigint;
  readonly receipts: number;
  readonly returnsTiyin: bigint;
  readonly profitTiyin: bigint;
  readonly staleStores: readonly string[];
}

/** Owner/manager daily digest; plain text, one figure per line. */
export function formatDigest(d: DigestFigures, locale: Locale): string {
  const lines = [
    t('telegram.digest.title', { org: clip(d.organizationName), date: d.date }, locale),
    t('telegram.digest.net', { amount: som(d.netTiyin, locale) }, locale),
    t('telegram.digest.receipts', { count: d.receipts }, locale),
    t('telegram.digest.returns', { amount: som(d.returnsTiyin, locale) }, locale),
    t('telegram.digest.profit', { amount: som(d.profitTiyin, locale) }, locale),
  ];
  if (d.staleStores.length > 0) {
    lines.push(
      t(
        'telegram.digest.stale',
        { stores: d.staleStores.map((s) => clip(s, 40)).join(', ') },
        locale,
      ),
    );
  }
  return lines.join('\n');
}

export interface DebtReminderFigures {
  readonly organizationName: string;
  readonly customerName: string;
  readonly balanceTiyin: bigint;
  readonly overdueTiyin: bigint;
}

/** Customer debt reminder: business, name and amounts only (no other customer data). */
export function formatDebtReminder(d: DebtReminderFigures, locale: Locale): string {
  const lines = [
    t(
      'telegram.debt.reminder',
      {
        org: clip(d.organizationName),
        name: clip(d.customerName),
        amount: som(d.balanceTiyin, locale),
      },
      locale,
    ),
  ];
  if (d.overdueTiyin > 0n) {
    lines.push(t('telegram.debt.overdue', { amount: som(d.overdueTiyin, locale) }, locale));
  }
  lines.push(t('telegram.debt.footer', undefined, locale));
  return lines.join('\n');
}
