import { setLocale } from '@mezon/i18n';
import { beforeEach, describe, expect, it } from 'vitest';
import { HubApiError } from '../api/hub-client.js';
import { describeHubError } from './error-text.js';

function hubError(code: string, message = 'English server text'): HubApiError {
  return new HubApiError({ status: 409, code, message });
}

describe('C11 describeHubError', () => {
  beforeEach(() => {
    setLocale('uz-Latn');
  });

  it('a known code is shown in Uzbek, never the English server message', () => {
    const text = describeHubError(hubError('BARCODE_ALREADY_EXISTS'));
    expect(text).toBe('Bu shtrix-kod boshqa tovarga biriktirilgan.');
    expect(text).not.toContain('English');
  });

  it('an unknown code gets a generic Uzbek sentence with the code', () => {
    expect(describeHubError(hubError('SOMETHING_NEW'))).toBe(
      'Amalni bajarib boʻlmadi (SOMETHING_NEW). Qayta urinib koʻring.',
    );
  });

  it('follows the selected language', () => {
    setLocale('ru');
    expect(describeHubError(hubError('PRODUCT_SKU_ALREADY_EXISTS'))).toBe(
      'Такой артикул уже есть у другого товара.',
    );
  });
});
