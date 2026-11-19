import React from 'react';
import { type I18nKey, t } from '@mezon/i18n';
import { useAuthStore } from '../state/auth.js';
import { LocaleSelect } from './LocaleSelect.js';

export type AdminTab = 'dashboard' | 'receipts' | 'customers' | 'products' | 'reports';

const TABS: ReadonlyArray<{ readonly id: AdminTab; readonly label: I18nKey }> = [
  { id: 'dashboard', label: 'admin.nav.dashboard' },
  { id: 'receipts', label: 'admin.nav.receipts' },
  { id: 'customers', label: 'admin.nav.customers' },
  { id: 'products', label: 'admin.nav.products' },
  { id: 'reports', label: 'admin.nav.reports' },
];

interface NavbarProps {
  currentTab: AdminTab;
  onSelectTab: (tab: AdminTab) => void;
}

export const Navbar: React.FC<NavbarProps> = ({ currentTab, onSelectTab }) => {
  const { user, logout } = useAuthStore();

  return (
    <header className="bg-white border-b border-slate-200 sticky top-0 z-30">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex flex-wrap justify-between items-center gap-2 py-2 min-h-16">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center space-x-2">
              <span className="text-xl font-extrabold text-indigo-600 tracking-tight">Guzar</span>
              <span className="text-xs px-2 py-0.5 rounded bg-indigo-50 text-indigo-700 font-semibold uppercase">
                {t('admin.brand')}
              </span>
            </div>

            <nav className="flex flex-wrap gap-1">
              {TABS.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => onSelectTab(tab.id)}
                  className={`px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                    currentTab === tab.id
                      ? 'bg-indigo-50 text-indigo-700'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
                  }`}
                >
                  {t(tab.label)}
                </button>
              ))}
            </nav>
          </div>

          <div className="flex items-center gap-3">
            <LocaleSelect />
            {user && (
              <div className="text-right hidden sm:block">
                <div className="text-sm font-semibold text-slate-800">{user.name}</div>
                <div className="text-xs text-slate-500">
                  {t(user.role === 'owner' ? 'admin.role.owner' : 'admin.role.manager')}
                </div>
              </div>
            )}

            <button
              onClick={() => {
                void logout();
              }}
              className="text-xs font-medium text-slate-600 hover:text-red-600 px-3 py-1.5 rounded border border-slate-200 hover:border-red-200 hover:bg-red-50 transition-colors"
            >
              {t('admin.logout')}
            </button>
          </div>
        </div>
      </div>
    </header>
  );
};
