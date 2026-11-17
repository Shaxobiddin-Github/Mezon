import type { CloudTelegramStore, TelegramLocale } from '@mezon/db-cloud';
import type { UnixMs } from '@mezon/domain';
import { type TelegramClient, isTelegramSendError } from '@mezon/drivers';
import { t } from '@mezon/i18n';
import { z } from 'zod';
import { clip, localeFromTelegram } from './messages.js';

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

export interface TelegramBotServiceOptions {
  readonly store: CloudTelegramStore;
  readonly client: TelegramClient;
  readonly clock: { nowMs(): UnixMs };
  readonly digestHour: number;
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
    const locale = localeFromTelegram(languageCode);
    const [command, arg] = text.trim().split(/\s+/, 2);
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
      await this.opts.client.sendMessage(chatId, t('telegram.start.welcome', undefined, locale));
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
      locale: locale as TelegramLocale,
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
    const locale = localeFromTelegram(cb.from?.language_code);
    await this.opts.client.sendMessage(
      chatId,
      t(consent ? 'telegram.consent.accepted' : 'telegram.consent.declined', undefined, locale),
    );
  }
}

function errorKind(err: unknown): string {
  if (isTelegramSendError(err)) return `telegram:${err.kind}`;
  return err instanceof Error ? err.name : 'unknown';
}
