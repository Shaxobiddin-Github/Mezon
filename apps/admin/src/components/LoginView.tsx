import React, { useState } from 'react';
import { useAuthStore } from '../state/auth.js';

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
      const msg = err instanceof Error ? err.message : 'Kirishda xatolik yuz berdi';
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-4 bg-slate-100">
      <div className="w-full max-w-md bg-white rounded-xl shadow-lg p-8 border border-slate-200">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-slate-800 tracking-tight">
            Guzar — Biznes Kabineti
          </h1>
          <p className="text-sm text-slate-500 mt-2">Boshqaruv va tahlil tizimiga kirish</p>
        </div>

        {error && (
          <div className="mb-6 p-4 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
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
            <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">
              Login (Email yoki telefon)
            </label>
            <input
              type="text"
              required
              value={login}
              onChange={(e) => setLogin(e.target.value)}
              placeholder="owner@guzar.uz"
              className="w-full px-4 py-2.5 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">
              Parol
            </label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full px-4 py-2.5 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm"
            />
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full mt-6 py-2.5 px-4 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-medium text-sm transition-colors shadow disabled:opacity-50"
          >
            {submitting ? 'Kirilmoqda...' : 'Tizimga kirish'}
          </button>
        </form>

        <div className="mt-8 text-center text-xs text-slate-400">
          Guzar Platformasi © 2026. Barcha huquqlar himoyalangan.
        </div>
      </div>
    </div>
  );
};
