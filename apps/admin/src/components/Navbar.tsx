import React, { useState } from 'react';
import { type I18nKey, t } from '@mezon/i18n';
import { useAuthStore } from '../state/auth.js';
import { Icon, type IconName } from './Icon.js';
import { LocaleSelect } from './LocaleSelect.js';

export type AdminTab =
  'dashboard' | 'receipts' | 'customers' | 'products' | 'shop' | 'devices' | 'reports';

const TABS: ReadonlyArray<{
  readonly id: AdminTab;
  readonly label: I18nKey;
  readonly icon: IconName;
}> = [
  { id: 'dashboard', label: 'admin.nav.dashboard', icon: 'home' },
  { id: 'receipts', label: 'admin.nav.receipts', icon: 'receipt' },
  { id: 'customers', label: 'admin.nav.customers', icon: 'users' },
  { id: 'products', label: 'admin.nav.products', icon: 'box' },
  { id: 'shop', label: 'admin.nav.shop', icon: 'cart' },
  { id: 'devices', label: 'admin.nav.devices', icon: 'device' },
  { id: 'reports', label: 'admin.nav.reports', icon: 'chart' },
];

interface NavbarProps {
  currentTab: AdminTab;
  onSelectTab: (tab: AdminTab) => void;
}

const Brand: React.FC = () => (
  <div className="flex items-center gap-3">
    <span className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-700 text-lg font-extrabold text-white shadow-sm">
      G
    </span>
    <div className="leading-tight">
      <div className="text-base font-bold text-slate-900">Guzar</div>
      <div className="text-xs font-medium text-slate-500">{t('admin.brand')}</div>
    </div>
  </div>
);

/**
 * C14: the cabinet's menu is a left side bar (same idea as the kassa), with icons; on a phone it
 * is a top bar with a menu button.
 */
export const Navbar: React.FC<NavbarProps> = ({ currentTab, onSelectTab }) => {
  const { user, logout } = useAuthStore();
  const [open, setOpen] = useState(false);

  const nav = (
    <nav className="flex flex-col gap-1" aria-label={t('admin.brand')}>
      {TABS.map((tab) => {
        const active = currentTab === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            aria-current={active ? 'page' : undefined}
            onClick={() => {
              onSelectTab(tab.id);
              setOpen(false);
            }}
            className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition-colors ${
              active
                ? 'bg-indigo-50 text-indigo-700'
                : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
            }`}
          >
            <Icon
              name={tab.icon}
              className={`h-5 w-5 ${active ? 'text-indigo-600' : 'text-slate-400'}`}
            />
            {t(tab.label)}
          </button>
        );
      })}
    </nav>
  );

  const footer = (
    <div className="space-y-3 border-t border-slate-200 pt-4">
      <LocaleSelect />
      {user && (
        <div className="flex items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-indigo-100 text-sm font-bold text-indigo-700">
            {user.name.trim().charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-slate-800">{user.name}</div>
            <div className="text-xs text-slate-500">
              {t(user.role === 'owner' ? 'admin.role.owner' : 'admin.role.manager')}
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              void logout();
            }}
            title={t('admin.logout')}
            aria-label={t('admin.logout')}
            className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600"
          >
            <Icon name="logout" />
          </button>
        </div>
      )}
    </div>
  );

  return (
    <>
      {/* Desktop: side bar */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col justify-between border-r border-slate-200 bg-white px-4 py-5 lg:flex">
        <div className="space-y-8">
          <Brand />
          {nav}
        </div>
        {footer}
      </aside>

      {/* Phone / tablet: top bar + slide-in menu */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 lg:hidden">
        <Brand />
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={t('admin.menu.open')}
          className="rounded-lg p-2 text-slate-600 hover:bg-slate-100"
        >
          <Icon name="menu" className="h-6 w-6" />
        </button>
      </header>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label={t('admin.menu.close')}
            className="absolute inset-0 bg-slate-900/40"
            onClick={() => setOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 flex w-72 flex-col justify-between bg-white px-4 py-5 shadow-xl">
            <div className="space-y-8">
              <div className="flex items-center justify-between">
                <Brand />
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label={t('admin.menu.close')}
                  className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"
                >
                  <Icon name="close" />
                </button>
              </div>
              {nav}
            </div>
            {footer}
          </div>
        </div>
      )}
    </>
  );
};
