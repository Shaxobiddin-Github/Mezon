import type { CloudTelegramStore } from '@mezon/db-cloud';
import type { UnixMs } from '@mezon/domain';
import { type TelegramClient, isTelegramSendError } from '@mezon/drivers';
import { t } from '@mezon/i18n';
import { z } from 'zod';
import type { Locale } from '@mezon/i18n';
import { clip, formatCustomerCard, localeFromTelegram, menuAction, menuRows } from './messages.js';

/** The parts of a Telegram `Update` the bot reads; everything else is ignored. */
const TelegramUpdateSchema = z.object({
  update_id: z.number().int(),
  message: z
    .object({
      chat: z.object({ id: z.number().int(), type: z.string() }),
      from: z.object({ language_code: z.string().optional() }).optional(),
      text: z.string().max(4096).optional(),
    })
    .optional(),
  callback_query: z
    .object({
      id: z.string().max(128),
      from: z.object({ language_code: z.string().optional() }).optional(),
      data: z.string().max(64).optional(),
      message: z.object({ chat: z.object({ id: z.number().int() }) }).optional(),
    })
    .optional(),
});

/** Callback data: `c:<linkId>:<y|n>` (≤ 64 bytes). */
const CONSENT_RE = /^c:([0-9a-f-]{36}):(y|n)$/;
/** C24 language choice: `l:<locale>`. */
const LANG_RE = /^l:(uz-Latn|ru)$/;
/** Store time zone for dates in the bot (all shops are in Uzbekistan for now). */
const BOT_TZ = 'Asia/Tashkent';

export interface TelegramBotServiceOptions {
  readonly store: CloudTelegramStore;
  readonly client: TelegramClient;
  readonly clock: { nowMs(): UnixMs };
  readonly digestHour: number;
  /** C24: https origin of the online shop, or null (no shop button). */
  readonly publicBaseUrl?: string | null;
  readonly logger?: { warn(obj: object, msg: string): void };
}

/**
 * Handles webhook updates: `/start <code>` binds a chat, the consent buttons answer the customer
 * question, `/stop` unbinds. Only private chats are served. Every failure is swallowed after
 * logging so Telegram does not retry an update forever.
 */
export class TelegramBotService {
  constructor(private readonly opts: TelegramBotServiceOptions) {}

  async handleUpdate(raw: unknown): Promise<void> {
    const parsed = TelegramUpdateSchema.safeParse(raw);
    if (!parsed.success) return;
    const update = parsed.data;
    try {
      if (update.callback_query) {
        await this.onCallback(update.callback_query);
      } else if (update.message?.text !== undefined && update.message.chat.type === 'private') {
        await this.onText(
          String(update.message.chat.id),
          update.message.text,
          update.message.from?.language_code,
        );
      }
    } catch (err) {
      this.opts.logger?.warn(
        { event: 'telegram.update_failed', updateId: update.update_id, kind: errorKind(err) },
        'Telegram update handling failed',
      );
    }
  }

  private async onText(chatId: string, text: string, languageCode: string | undefined) {
    const locale =
      (await this.opts.store.getChatLocale(chatId)) ?? localeFromTelegram(languageCode);
    const action = menuAction(text);
    if (action !== null) {
      await this.onMenu(chatId, action, locale);
      return;
    }
    const [command, arg] = text.trim().split(/\s+/, 2);
    if (command === '/menu') {
      await this.opts.client.sendMessage(chatId, t('telegram.menu.hint', undefined, locale), {
        menu: menuRows(locale),
      });
      return;
    }
    if (command === '/stop') {
      const n = await this.opts.store.revokeChat(chatId, this.opts.clock.nowMs());
      await this.opts.client.sendMessage(
        chatId,
        t(n > 0 ? 'telegram.stop.done' : 'telegram.stop.none', undefined, locale),
      );
      return;
    }
    if (command !== '/start') return;
    if (!arg) {
      const cards = await this.cards(chatId);
      await this.opts.client.sendMessage(
        chatId,
        t('telegram.start.welcome', undefined, locale),
        cards.length > 0 ? { menu: menuRows(locale) } : undefined,
      );
      return;
    }
    const target = await this.opts.store.consumeLinkCode(arg, this.opts.clock.nowMs());
    if (!target) {
      await this.opts.client.sendMessage(chatId, t('telegram.link.invalid', undefined, locale));
      return;
    }
    const { linkId } = await this.opts.store.bindChat({
      target,
      chatId,
      locale: locale,
      nowMs: this.opts.clock.nowMs(),
    });
    const org = clip(await this.opts.store.getOrganizationName(target.organizationId));
    if (target.kind === 'staff') {
      await this.opts.client.sendMessage(
        chatId,
        t('telegram.link.staffOk', { hour: this.opts.digestHour, org }, locale),
      );
      return;
    }
    await this.opts.client.sendMessage(chatId, t('telegram.link.customerAsk', { org }, locale), {
      buttons: [
        [
          { text: t('telegram.consent.yes', undefined, locale), data: `c:${linkId}:y` },
          { text: t('telegram.consent.no', undefined, locale), data: `c:${linkId}:n` },
        ],
      ],
    });
  }

  private async onCallback(cb: {
    id: string;
    data?: string;
    from?: { language_code?: string };
    message?: { chat: { id: number } };
  }) {
    await this.opts.client.answerCallback(cb.id);
    const lang = cb.data ? LANG_RE.exec(cb.data) : null;
    if (lang?.[1] && cb.message) {
      const chatId = String(cb.message.chat.id);
      const next = lang[1] as Locale;
      await this.opts.store.setChatLocale(chatId, next, this.opts.clock.nowMs());
      await this.opts.client.sendMessage(chatId, t('telegram.lang.done', undefined, next), {
        menu: menuRows(next),
      });
      return;
    }
    const m = cb.data ? CONSENT_RE.exec(cb.data) : null;
    if (!m?.[1] || !cb.message) return;
    const chatId = String(cb.message.chat.id);
    const consent = m[2] === 'y';
    const ok = await this.opts.store.setCustomerConsentByChat({
      chatId,
      linkId: m[1],
      consent,
      nowMs: this.opts.clock.nowMs(),
    });
    if (!ok) return;
    // the language the chat was linked in (or later chose with "Til") wins
    const locale =
      (await this.opts.store.getChatLocale(chatId)) ?? localeFromTelegram(cb.from?.language_code);
    await this.opts.client.sendMessage(
      chatId,
      t(consent ? 'telegram.consent.accepted' : 'telegram.consent.declined', undefined, locale),
      consent ? { menu: menuRows(locale) } : undefined,
    );
  }

  private cards(chatId: string) {
    return this.opts.store.listCustomerCardsForChat({
      chatId,
      asOfMs: this.opts.clock.nowMs(),
      tz: BOT_TZ,
    });
  }

  /** C24 customer menu: "Qarzlarim", "Do'kon", "Til". */
  private async onMenu(chatId: string, action: 'debts' | 'shop' | 'lang', locale: Locale) {
    if (action === 'lang') {
      await this.opts.client.sendMessage(chatId, t('telegram.lang.choose', undefined, locale), {
        buttons: [
          [
            { text: "O'zbekcha", data: 'l:uz-Latn' },
            { text: 'Русский', data: 'l:ru' },
          ],
        ],
      });
      return;
    }
    const cards = await this.cards(chatId);
    if (cards.length === 0) {
      await this.opts.client.sendMessage(chatId, t('telegram.debts.notLinked', undefined, locale));
      return;
    }
    if (action === 'debts') {
      for (const card of cards) {
        await this.opts.client.sendMessage(chatId, formatCustomerCard(card, locale, BOT_TZ), {
          menu: menuRows(locale),
        });
      }
      return;
    }
    const base = this.opts.publicBaseUrl ?? null;
    const shops = cards.filter((c) => c.shopSlug !== null);
    if (base === null || shops.length === 0) {
      await this.opts.client.sendMessage(chatId, t('telegram.shop.none', undefined, locale));
      return;
    }
    const seen = new Set<string>();
    const buttons = shops
      .filter((c) => (seen.has(c.organizationId) ? false : (seen.add(c.organizationId), true)))
      .map((c) => [
        {
          text: t('telegram.shop.open', { shop: clip(c.shopName, 40) }, locale),
          webAppUrl: `${base}/s/${c.shopSlug ?? ''}`,
        },
      ]);
    await this.opts.client.sendMessage(chatId, t('telegram.shop.text', undefined, locale), {
      buttons,
    });
  }
}

function errorKind(err: unknown): string {
  if (isTelegramSendError(err)) return `telegram:${err.kind}`;
  return err instanceof Error ? err.name : 'unknown';
}
