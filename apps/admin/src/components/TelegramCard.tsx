import React, { useEffect, useState } from 'react';
import { t } from '@mezon/i18n';
import { type TelegramLink, type TelegramStatus, adminApi } from '../api-client.js';
import { describeApiError } from '../utils/format.js';

/** T2.8: the signed-in owner/manager links their own Telegram chat for the daily digest. */
export const TelegramCard: React.FC = () => {
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [link, setLink] = useState<TelegramLink | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setStatus(await adminApi.getTelegramStatus());
    } catch (err) {
      setError(describeApiError(err));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  if (!status) return null;

  return (
    <div
      data-testid="admin-telegram-card"
      className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 flex flex-wrap items-center justify-between gap-3"
    >
      <div className="text-sm font-semibold text-slate-800">{t('admin.telegram.title')}</div>
      {!status.enabled ? (
        <span className="text-xs text-slate-500">{t('admin.telegram.disabled')}</span>
      ) : status.linked ? (
        <div className="flex items-center gap-3">
          <span className="text-xs text-emerald-700">{t('admin.telegram.connected')}</span>
          <button
            onClick={() => {
              void adminApi.deleteTelegramLink().then(load);
            }}
            className="text-xs px-3 py-1.5 rounded border border-slate-200 hover:bg-slate-50"
          >
            {t('admin.telegram.disconnect')}
          </button>
        </div>
      ) : (
        <div className="flex flex-col items-end gap-1">
          <button
            onClick={() => {
              void adminApi
                .createTelegramLink()
                .then(setLink)
                .catch((err: unknown) => setError(describeApiError(err)));
            }}
            className="text-xs px-3 py-1.5 rounded bg-indigo-600 text-white hover:bg-indigo-700"
          >
            {t('admin.telegram.connect')}
          </button>
          {link && (
            <span className="text-xs text-slate-600 break-all">
              {t('admin.telegram.openLink', { url: link.url ?? `/start ${link.code}` })}
            </span>
          )}
        </div>
      )}
      {error && <span className="text-xs text-red-600 w-full">{error}</span>}
    </div>
  );
};
