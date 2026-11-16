import React from 'react';
import { useAuthStore } from '../state/auth.js';

export type AdminTab = 'dashboard' | 'receipts' | 'customers' | 'reports';

interface NavbarProps {
  currentTab: AdminTab;
  onSelectTab: (tab: AdminTab) => void;
}

export const Navbar: React.FC<NavbarProps> = ({ currentTab, onSelectTab }) => {
  const { user, logout } = useAuthStore();

  return (
    <header className="bg-white border-b border-slate-200 sticky top-0 z-30">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between h-16">
          <div className="flex items-center space-x-8">
            <div className="flex items-center space-x-2">
              <span className="text-xl font-extrabold text-indigo-600 tracking-tight">Guzar</span>
              <span className="text-xs px-2 py-0.5 rounded bg-indigo-50 text-indigo-700 font-semibold uppercase">
                Kabinet
              </span>
            </div>

            <nav className="flex space-x-1">
              <button
                onClick={() => onSelectTab('dashboard')}
                className={`px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                  currentTab === 'dashboard'
                    ? 'bg-indigo-50 text-indigo-700'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
                }`}
              >
                Dashboard
              </button>
              <button
                onClick={() => onSelectTab('receipts')}
                className={`px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                  currentTab === 'receipts'
                    ? 'bg-indigo-50 text-indigo-700'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
                }`}
              >
                Cheklar
              </button>
              <button
                onClick={() => onSelectTab('customers')}
                className={`px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                  currentTab === 'customers'
                    ? 'bg-indigo-50 text-indigo-700'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
                }`}
              >
                Mijozlar
              </button>
              <button
                onClick={() => onSelectTab('reports')}
                className={`px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                  currentTab === 'reports'
                    ? 'bg-indigo-50 text-indigo-700'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
                }`}
              >
                Kunlik hisobot
              </button>
            </nav>
          </div>

          <div className="flex items-center space-x-4">
            <div className="text-right hidden sm:block">
              <div className="text-sm font-semibold text-slate-800">{user?.name || 'Administrator'}</div>
              <div className="text-xs text-slate-500 capitalize">{user?.role || 'owner'}</div>
            </div>

            <button
              onClick={() => {
                void logout();
              }}
              className="text-xs font-medium text-slate-600 hover:text-red-600 px-3 py-1.5 rounded border border-slate-200 hover:border-red-200 hover:bg-red-50 transition-colors"
            >
              Chiqish
            </button>
          </div>
        </div>
      </div>
    </header>
  );
};
