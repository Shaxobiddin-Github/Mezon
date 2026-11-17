import { DEFAULT_LOCALE, type Locale, isLocale, setLocale as setI18nLocale } from '@mezon/i18n';
import { create } from 'zustand';

/** Cabinet UI language, remembered per browser (T2.7a R3, same pattern as the POS). */
export const ADMIN_LOCALE_STORAGE_KEY = 'mezon.admin.locale';

export function readStoredAdminLocale(): Locale {
  try {
    const raw = globalThis.localStorage?.getItem(ADMIN_LOCALE_STORAGE_KEY);
    return isLocale(raw) ? raw : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

function persist(locale: Locale): void {
  try {
    globalThis.localStorage?.setItem(ADMIN_LOCALE_STORAGE_KEY, locale);
  } catch {
    // Private mode or blocked storage: the choice simply is not remembered.
  }
}

interface LocaleState {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

const initialLocale = readStoredAdminLocale();
setI18nLocale(initialLocale);

export const useLocaleStore = create<LocaleState>((set) => ({
  locale: initialLocale,
  setLocale: (locale) => {
    setI18nLocale(locale);
    persist(locale);
    if (typeof document !== 'undefined') document.documentElement.lang = locale;
    set({ locale });
  },
}));
