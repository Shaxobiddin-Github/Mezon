import { describe, expect, it } from 'vitest';
import { HttpTelegramClient, TelegramSendError } from './telegram-client.js';

const TOKEN = '123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-ra';

function fakeFetch(status: number, body: unknown, calls: { url: string; body: string }[] = []) {
  return (url: string, init: { body: string }) => {
    calls.push({ url, body: init.body });
    return Promise.resolve({ status, json: () => Promise.resolve(body) });
  };
}

describe('@mezon/drivers - HttpTelegramClient', () => {
  it('sends plain text (no parse_mode) with an inline keyboard', async () => {
    const calls: { url: string; body: string }[] = [];
    const client = new HttpTelegramClient({
      token: TOKEN,
      fetchImpl: fakeFetch(200, { ok: true }, calls),
    });
    await client.sendMessage('42', '<b>x</b>', { buttons: [[{ text: 'Ha', data: 'c:1:y' }]] });
    expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    const body = JSON.parse(calls[0]?.body ?? '{}') as Record<string, unknown>;
    expect(body).not.toHaveProperty('parse_mode');
    expect(body.reply_markup).toEqual({
      inline_keyboard: [[{ text: 'Ha', callback_data: 'c:1:y' }]],
    });
  });

  it.each([
    [403, { ok: false, description: 'Forbidden: bot was blocked by the user' }, 'chatUnavailable'],
    [400, { ok: false, description: 'Bad Request: chat not found' }, 'chatUnavailable'],
    [429, { ok: false, description: 'Too Many Requests' }, 'transient'],
    [502, {}, 'transient'],
    [400, { ok: false, description: 'Bad Request: message is too long' }, 'permanent'],
    [401, { ok: false, description: 'Unauthorized' }, 'permanent'],
  ])('status %i -> %s', async (status, body, kind) => {
    const client = new HttpTelegramClient({ token: TOKEN, fetchImpl: fakeFetch(status, body) });
    const err = await client.sendMessage('1', 'x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TelegramSendError);
    expect((err as TelegramSendError).kind).toBe(kind);
  });

  it('a network failure is transient and never leaks the token', async () => {
    const client = new HttpTelegramClient({
      token: TOKEN,
      fetchImpl: () =>
        Promise.reject(new Error(`connect ECONNREFUSED https://api.telegram.org/bot${TOKEN}`)),
    });
    const err = (await client.sendMessage('1', 'x').catch((e: unknown) => e)) as TelegramSendError;
    expect(err.kind).toBe('transient');
    expect(err.message).not.toContain(TOKEN);
  });

  it('rejects a malformed token at construction', () => {
    expect(() => new HttpTelegramClient({ token: 'not-a-token' })).toThrow();
  });
});
