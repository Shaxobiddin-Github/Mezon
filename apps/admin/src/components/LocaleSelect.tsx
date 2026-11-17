import React from 'react';
import { LOCALE_LABELS, SUPPORTED_LOCALES, isLocale, t } from '@mezon/i18n';
import { useLocaleStore } from '../state/locale.js';

export const LocaleSelect: React.FC = () => {
  const { locale, setLocale } = useLocaleStore();
  return (
    <select
      aria-label={t('admin.language')}
      data-testid="admin-locale-select"
      value={locale}
      onChange={(e) => {
        if (isLocale(e.target.value)) setLocale(e.target.value);
      }}
      className="text-xs px-2 py-1.5 rounded border border-slate-200 bg-white text-slate-700"
    >
      {SUPPORTED_LOCALES.map((l) => (
        <option key={l} value={l}>
          {LOCALE_LABELS[l]}
        </option>
      ))}
    </select>
  );
};
