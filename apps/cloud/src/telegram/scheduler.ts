import type { AdminReadStore, CloudTelegramStore, TelegramDeliveryKind } from '@mezon/db-cloud';
import { type UnixMs, type UuidV7, moneyToTiyin } from '@mezon/domain';
import { type TelegramClient, isTelegramSendError } from '@mezon/drivers';
import type { Locale } from '@mezon/i18n';
import { formatDebtReminder, formatDigest } from './messages.js';

export interface TelegramSchedulerOptions {
  readonly store: CloudTelegramStore;
  readonly adminStore: AdminReadStore;
  readonly client: TelegramClient;
  readonly clock: { nowMs(): UnixMs };
  /** Store time zone (the cloud has one per platform for now). */
  readonly timeZone?: string;
  readonly digestHour: number;
  readonly reminderHour: number;
  readonly logger?: {
    warn(obj: object, msg: string): void;
    error(obj: object, msg: string): void;
  };
}

export interface TelegramTickResult {
  readonly digestsSent: number;
  readonly remindersSent: number;
  readonly failures: number;
}

/** Local calendar parts of an instant in a time zone. */
export function localParts(
  ms: number,
  tz: string,
): { date: string; hour: number; isoWeek: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  // ISO-8601 week of the local date (weeks start on Monday; week 1 contains a Thursday).
  const d = new Date(`${date}T00:00:00Z`);
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const weekYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(weekYear, 0, 4));
  const week =
    1 +
    Math.round(
      ((d.getTime() - firstThursday.getTime()) / 86_400_000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7,
    );
  return {
    date,
    hour: Number(get('hour')),
    isoWeek: `${weekYear}-W${String(week).padStart(2, '0')}`,
  };
}

/**
 * T2.8 scheduler. Each tick:
 * - after `digestHour` (store time) each linked owner/manager gets today's digest once;
 * - after `reminderHour` each consenting customer with debt gets a reminder at most once per
 *   ISO week.
 * A delivery is claimed in the database BEFORE sending (at most once, even with two cloud
 * instances or a restart). A blocked chat revokes its binding. A transient failure is retried ONCE
 * on a tick at least 15 minutes later (owner decision, 2026-11-20); after that it stays `failed`.
 */
export class TelegramScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<TelegramTickResult> | null = null;
  private readonly tz: string;

  constructor(private readonly opts: TelegramSchedulerOptions) {
    this.tz = opts.timeZone ?? 'Asia/Tashkent';
  }

  start(intervalMs = 5 * 60 * 1000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err: unknown) =>
        this.opts.logger?.error({ event: 'telegram.tick_failed', err }, 'Telegram tick failed'),
      );
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick(): Promise<TelegramTickResult> {
    if (this.running) return this.running;
    this.running = this.runTick().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runTick(): Promise<TelegramTickResult> {
    const nowMs = this.opts.clock.nowMs();
    const local = localParts(Number(nowMs), this.tz);
    const result = { digestsSent: 0, remindersSent: 0, failures: 0 };
    const orgs = await this.opts.store.listActiveOrganizations();
    for (const org of orgs) {
      if (local.hour >= this.opts.digestHour) {
        await this.sendDigests(org, nowMs, local.date, result);
      }
      if (local.hour >= this.opts.reminderHour) {
        await this.sendReminders(org, nowMs, local.isoWeek, result);
      }
    }
    return result;
  }

  private async sendDigests(
    org: UuidV7,
    nowMs: UnixMs,
    date: string,
    result: { digestsSent: number; failures: number },
  ) {
    const targets = await this.opts.store.listStaffTargets(org);
    if (targets.length === 0) return;
    let text: ((locale: Locale) => string) | null = null;
    for (const target of targets) {
      const deliveryId = await this.opts.store.claimDelivery({
        organizationId: org,
        linkId: target.linkId,
        kind: 'digest',
        periodKey: date,
        nowMs,
      });
      if (!deliveryId) continue;
      if (!text) {
        const [dash, orgName] = await Promise.all([
          this.opts.adminStore.getDashboard({
            organizationId: org,
            tz: this.tz,
            nowMs,
            includeProfit: true,
          }),
          this.opts.store.getOrganizationName(org),
        ]);
        const figures = {
          organizationName: orgName,
          date: dash.todayDate,
          netTiyin: moneyToTiyin(dash.netSales),
          receipts: dash.receiptsCount,
          returnsTiyin: moneyToTiyin(dash.returnsTotal),
          profitTiyin: dash.grossProfit ? moneyToTiyin(dash.grossProfit) : 0n,
          staleStores: dash.stores.filter((s) => s.isStale).map((s) => s.storeName),
        };
        text = (locale) => formatDigest(figures, locale);
      }
      const ok = await this.deliver(
        org,
        deliveryId,
        target.linkId,
        target.chatId,
        text(target.locale),
        'digest',
        nowMs,
      );
      if (ok) result.digestsSent += 1;
      else result.failures += 1;
    }
  }

  private async sendReminders(
    org: UuidV7,
    nowMs: UnixMs,
    isoWeek: string,
    result: { remindersSent: number; failures: number },
  ) {
    const targets = await this.opts.store.listDebtTargets({
      organizationId: org,
      asOfMs: nowMs,
      tz: this.tz,
    });
    if (targets.length === 0) return;
    const orgName = await this.opts.store.getOrganizationName(org);
    for (const target of targets) {
      const deliveryId = await this.opts.store.claimDelivery({
        organizationId: org,
        linkId: target.linkId,
        kind: 'debt_reminder',
        periodKey: isoWeek,
        nowMs,
      });
      if (!deliveryId) continue;
      const text = formatDebtReminder(
        {
          organizationName: orgName,
          customerName: target.customerName,
          balanceTiyin: target.balanceTiyin,
          overdueTiyin: target.overdueTiyin,
        },
        target.locale,
      );
      const ok = await this.deliver(
        org,
        deliveryId,
        target.linkId,
        target.chatId,
        text,
        'debt_reminder',
        nowMs,
      );
      if (ok) result.remindersSent += 1;
      else result.failures += 1;
    }
  }

  private async deliver(
    org: UuidV7,
    deliveryId: string,
    linkId: string,
    chatId: string,
    text: string,
    kind: TelegramDeliveryKind,
    nowMs: UnixMs,
  ): Promise<boolean> {
    try {
      await this.opts.client.sendMessage(chatId, text);
      await this.opts.store.finishDelivery({
        organizationId: org,
        deliveryId,
        status: 'sent',
        nowMs,
      });
      return true;
    } catch (err) {
      const kindOfError = isTelegramSendError(err) ? err.kind : 'unexpected';
      await this.opts.store.finishDelivery({
        organizationId: org,
        deliveryId,
        status: 'failed',
        error: kindOfError,
        nowMs,
      });
      if (kindOfError === 'chatUnavailable') {
        await this.opts.store.revokeLink(org, linkId, nowMs);
      }
      this.opts.logger?.warn(
        { event: 'telegram.delivery_failed', kind, errorKind: kindOfError },
        'Telegram delivery failed',
      );
      return false;
    }
  }
}
