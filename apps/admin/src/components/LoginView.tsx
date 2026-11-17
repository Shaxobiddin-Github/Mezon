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
    <div className="flex min-h-screen items-center justify-center p-4 bg-slate-100">
      <div className="w-full max-w-md bg-white rounded-xl shadow-lg p-8 border border-slate-200">
        <div className="flex justify-end mb-4">
          <LocaleSelect />
        </div>
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-slate-800 tracking-tight">
            {t('admin.login.title')}
          </h1>
          <p className="text-sm text-slate-500 mt-2">{t('admin.login.subtitle')}</p>
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
              className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1"
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
              className="w-full px-4 py-2.5 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm"
            />
          </div>

          <div>
            <label
              htmlFor="admin-password"
              className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1"
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
              className="w-full px-4 py-2.5 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm"
            />
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full mt-6 py-2.5 px-4 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-medium text-sm transition-colors shadow disabled:opacity-50"
          >
            {submitting ? t('admin.login.submitting') : t('admin.login.submit')}
          </button>
        </form>

        <div className="mt-8 text-center text-xs text-slate-400">{t('admin.login.footer')}</div>
      </div>
    </div>
  );
};
