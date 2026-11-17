/**
 * T2.8 Telegram port. The cloud talks to Telegram only through this interface; tests use
 * `FakeTelegramClient`, production uses `HttpTelegramClient` (public Telegram Bot API).
 * Messages are always sent as plain text (no `parse_mode`), so user-supplied names cannot
 * inject markup.
 */
export interface TelegramButton {
  readonly text: string;
  /** Callback payload, at most 64 bytes (Telegram limit). */
  readonly data: string;
}

export interface TelegramSendOptions {
  /** Inline keyboard rows. */
  readonly buttons?: readonly (readonly TelegramButton[])[];
}

export type TelegramErrorKind =
  /** The user blocked the bot or deleted the chat: stop sending to this chat. */
  | 'chatUnavailable'
  /** Network, 429 or 5xx: try again later. */
  | 'transient'
  /** Anything else (bad request, bad token). */
  | 'permanent';

export class TelegramSendError extends Error {
  constructor(
    readonly kind: TelegramErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'TelegramSendError';
  }
}

export function isTelegramSendError(err: unknown): err is TelegramSendError {
  return err instanceof TelegramSendError;
}

export interface TelegramClient {
  sendMessage(chatId: string, text: string, options?: TelegramSendOptions): Promise<void>;
  /** Acknowledges an inline-button press (removes the client-side spinner). */
  answerCallback(callbackQueryId: string): Promise<void>;
}

export interface SentTelegramMessage {
  readonly chatId: string;
  readonly text: string;
  readonly buttons: readonly (readonly TelegramButton[])[];
}

/** In-memory client for tests: records every message; chats can be marked unavailable. */
export class FakeTelegramClient implements TelegramClient {
  readonly sent: SentTelegramMessage[] = [];
  readonly answeredCallbacks: string[] = [];
  private readonly unavailable = new Set<string>();
  private transientFailures = 0;

  markChatUnavailable(chatId: string): void {
    this.unavailable.add(chatId);
  }

  /** The next `count` sends fail with a transient error. */
  failNext(count: number): void {
    this.transientFailures = count;
  }

  sendMessage(chatId: string, text: string, options?: TelegramSendOptions): Promise<void> {
    if (this.transientFailures > 0) {
      this.transientFailures -= 1;
      return Promise.reject(new TelegramSendError('transient', 'Fake transient failure'));
    }
    if (this.unavailable.has(chatId)) {
      return Promise.reject(new TelegramSendError('chatUnavailable', 'Forbidden: bot was blocked'));
    }
    this.sent.push({ chatId, text, buttons: options?.buttons ?? [] });
    return Promise.resolve();
  }

  answerCallback(callbackQueryId: string): Promise<void> {
    this.answeredCallbacks.push(callbackQueryId);
    return Promise.resolve();
  }

  messagesTo(chatId: string): readonly SentTelegramMessage[] {
    return this.sent.filter((m) => m.chatId === chatId);
  }
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface HttpTelegramClientOptions {
  /** Bot token from configuration (never logged). */
  readonly token: string;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  readonly apiBaseUrl?: string;
}

/** Telegram Bot API over HTTPS (`sendMessage`, `answerCallbackQuery`). */
export class HttpTelegramClient implements TelegramClient {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: HttpTelegramClientOptions) {
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(options.token)) {
      throw new Error('Telegram bot token has an invalid format');
    }
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.baseUrl = `${options.apiBaseUrl ?? 'https://api.telegram.org'}/bot${options.token}`;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async sendMessage(chatId: string, text: string, options?: TelegramSendOptions): Promise<void> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    };
    if (options?.buttons && options.buttons.length > 0) {
      body.reply_markup = {
        inline_keyboard: options.buttons.map((row) =>
          row.map((b) => ({ text: b.text, callback_data: b.data })),
        ),
      };
    }
    await this.call('sendMessage', body);
  }

  async answerCallback(callbackQueryId: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: callbackQueryId });
  }

  private async call(method: string, body: Record<string, unknown>): Promise<void> {
    let status: number;
    let payload: { ok?: boolean; description?: string } = {};
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      status = res.status;
      payload = ((await res.json().catch(() => ({}))) ?? {}) as typeof payload;
    } catch {
      // The token is part of the URL: never include the underlying error text.
      throw new TelegramSendError('transient', `Telegram ${method}: network error`);
    }
    if (status === 200 && payload.ok === true) return;
    const description = typeof payload.description === 'string' ? payload.description : '';
    if (status === 403 || (status === 400 && /chat not found/i.test(description))) {
      throw new TelegramSendError(
        'chatUnavailable',
        `Telegram ${method}: ${status} ${description}`,
      );
    }
    if (status === 429 || status >= 500) {
      throw new TelegramSendError('transient', `Telegram ${method}: ${status}`);
    }
    throw new TelegramSendError('permanent', `Telegram ${method}: ${status} ${description}`);
  }
}
