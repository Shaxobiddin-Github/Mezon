import { describe, expect, it } from 'vitest';
import { toReplyMarkup } from './telegram-client.js';

describe('C24 Telegram reply markup', () => {
  it('inline buttons: callback, link and Mini App', () => {
    expect(
      toReplyMarkup({
        buttons: [
          [
            { text: 'Ha', data: 'c:1:y' },
            { text: 'Sayt', url: 'https://guzar.uz' },
            { text: 'Doʻkon', webAppUrl: 'https://guzar.uz/s/non' },
          ],
        ],
      }),
    ).toEqual({
      inline_keyboard: [
        [
          { text: 'Ha', callback_data: 'c:1:y' },
          { text: 'Sayt', url: 'https://guzar.uz' },
          { text: 'Doʻkon', web_app: { url: 'https://guzar.uz/s/non' } },
        ],
      ],
    });
  });

  it('a persistent menu under the input field; nothing when no options', () => {
    expect(toReplyMarkup({ menu: [['A', 'B'], ['C']] })).toEqual({
      keyboard: [[{ text: 'A' }, { text: 'B' }], [{ text: 'C' }]],
      resize_keyboard: true,
      is_persistent: true,
    });
    expect(toReplyMarkup()).toBeNull();
  });

  it('refuses a non-https button link', () => {
    expect(() => toReplyMarkup({ buttons: [[{ text: 'x', url: 'http://evil.test' }]] })).toThrow(
      /https/,
    );
    expect(() =>
      toReplyMarkup({ buttons: [[{ text: 'x', webAppUrl: 'javascript:alert(1)' }]] }),
    ).toThrow(/https/);
  });
});
