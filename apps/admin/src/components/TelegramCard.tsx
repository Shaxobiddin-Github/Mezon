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
      className="card flex flex-wrap items-center justify-between gap-3 p-5"
    >
      <div>
        <div className="text-base font-semibold text-slate-900">{t('admin.telegram.title')}</div>
      </div>
      {!status.enabled ? (
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
          {t('admin.telegram.disabled')}
        </span>
      ) : status.linked ? (
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800 ring-1 ring-emerald-200">
            {t('admin.telegram.connected')}
          </span>
          <button
            onClick={() => {
              void adminApi.deleteTelegramLink().then(load);
            }}
            className="btn btn-outline"
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
            className="btn btn-primary"
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
