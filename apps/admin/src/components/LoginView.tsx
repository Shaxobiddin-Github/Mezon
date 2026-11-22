import React, { useState } from 'react';
import { t } from '@mezon/i18n';
import { AdminApiError } from '../api-client.js';
import { useAuthStore } from '../state/auth.js';
import { LocaleSelect } from './LocaleSelect.js';

function loginErrorMessage(err: unknown): string {
  if (err instanceof AdminApiError && err.status === 403) return t('admin.login.cashierForbidden');
  if (err instanceof AdminApiError && err.status === 429) return t('admin.login.locked');
  return t('admin.login.failed');
}

export const LoginView: React.FC = () => {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { login: doLogin } = useAuthStore();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!login.trim() || !password) return;

    setError(null);
    setSubmitting(true);
    try {
      await doLogin(login.trim(), password);
    } catch (err: unknown) {
      setError(loginErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="grid min-h-screen bg-slate-50 lg:grid-cols-2">
      {/* Brand side: what this place is, in three short lines */}
      <div className="relative hidden overflow-hidden bg-gradient-to-br from-indigo-600 via-indigo-700 to-indigo-900 p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-xl bg-white/15 text-xl font-extrabold ring-1 ring-white/25">
            G
          </span>
          <span className="text-lg font-bold">Guzar</span>
        </div>
        <div className="max-w-md space-y-6">
          <h2 className="text-3xl font-bold leading-tight tracking-tight">
            {t('admin.login.heroTitle')}
          </h2>
          <ul className="space-y-3 text-indigo-100">
            {(['admin.login.hero1', 'admin.login.hero2', 'admin.login.hero3'] as const).map(
              (key) => (
                <li key={key} className="flex items-start gap-3">
                  <span className="mt-1 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-white/20 text-xs">
                    ✓
                  </span>
                  {t(key)}
                </li>
              ),
            )}
          </ul>
        </div>
        <div className="text-sm text-indigo-200">{t('admin.login.footer')}</div>
        <div className="pointer-events-none absolute -right-24 -bottom-24 h-80 w-80 rounded-full bg-white/10 blur-2xl" />
      </div>

      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center justify-between">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-700 text-lg font-extrabold text-white shadow-sm lg:invisible">
              G
            </span>
            <LocaleSelect />
          </div>
          <div className="mb-8">
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">
              {t('admin.login.title')}
            </h1>
            <p className="mt-2 text-sm text-slate-500">{t('admin.login.subtitle')}</p>
          </div>

          {error && (
            <div
              role="alert"
              className="mb-6 p-4 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700"
            >
              {error}
            </div>
          )}

          <form
            onSubmit={(e) => {
              void handleSubmit(e);
            }}
            className="space-y-4"
          >
            <div>
              <label
                htmlFor="admin-login"
                className="mb-1.5 block text-sm font-medium text-slate-700"
              >
                {t('admin.login.login')}
              </label>
              <input
                id="admin-login"
                type="text"
                required
                autoComplete="username"
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
              />
            </div>

            <div>
              <label
                htmlFor="admin-password"
                className="mb-1.5 block text-sm font-medium text-slate-700"
              >
                {t('admin.login.password')}
              </label>
              <input
                id="admin-password"
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
              />
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="btn btn-primary mt-6 w-full py-3"
            >
              {submitting ? t('admin.login.submitting') : t('admin.login.submit')}
            </button>
          </form>

          <div className="mt-8 text-center text-xs text-slate-400 lg:hidden">
            {t('admin.login.footer')}
          </div>
        </div>
      </div>
    </div>
  );
};
