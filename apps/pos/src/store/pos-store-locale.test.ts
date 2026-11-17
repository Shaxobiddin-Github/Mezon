import { getLocale, t } from '@mezon/i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCALE_STORAGE_KEY, readStoredLocale, usePosStore } from './pos-store.js';

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k: string) => data.get(k) ?? null,
    key: (i: number) => [...data.keys()][i] ?? null,
    removeItem: (k: string) => void data.delete(k),
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  usePosStore.getState().setLocale('uz-Latn');
});

describe('T4.6 POS locale state', () => {
  it('setLocale switches the i18n dictionary, store state and persists the choice', () => {
    const storage = fakeStorage();
    vi.stubGlobal('localStorage', storage);
    usePosStore.getState().setLocale('ru');
    expect(usePosStore.getState().locale).toBe('ru');
    expect(getLocale()).toBe('ru');
    expect(t('common.save')).toBe('Сохранить');
    expect(storage.getItem(LOCALE_STORAGE_KEY)).toBe('ru');
  });

  it('readStoredLocale falls back to uz-Latn on unknown values and on throwing storage', () => {
    vi.stubGlobal('localStorage', fakeStorage({ [LOCALE_STORAGE_KEY]: 'uz-Cyrl' }));
    expect(readStoredLocale()).toBe('uz-Cyrl');
    vi.stubGlobal('localStorage', fakeStorage({ [LOCALE_STORAGE_KEY]: 'en' }));
    expect(readStoredLocale()).toBe('uz-Latn');
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
    });
    expect(readStoredLocale()).toBe('uz-Latn');
  });

  it('setLocale does not throw when storage writes fail', () => {
    vi.stubGlobal('localStorage', {
      setItem: () => {
        throw new Error('quota');
      },
    });
    expect(() => usePosStore.getState().setLocale('uz-Cyrl')).not.toThrow();
    expect(getLocale()).toBe('uz-Cyrl');
  });
});
