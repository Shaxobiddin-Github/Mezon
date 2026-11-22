import React, { useEffect, useState } from 'react';
import { t } from '@mezon/i18n';
import { useAuthStore } from './state/auth.js';
import { useLocaleStore } from './state/locale.js';
import { type AdminTab, Navbar } from './components/Navbar.js';
import { LoginView } from './components/LoginView.js';
import { DashboardView } from './components/DashboardView.js';
import { ReceiptsView } from './components/ReceiptsView.js';
import { CustomersView } from './components/CustomersView.js';
import { DailyReportView } from './components/DailyReportView.js';
import { ProductsView } from './components/ProductsView.js';
import { DevicesView } from './components/DevicesView.js';
import { OnlineShopView } from './components/OnlineShopView.js';

export const App: React.FC = () => {
  const { isAuthenticated, isLoading, checkSession } = useAuthStore();
  const locale = useLocaleStore((s) => s.locale);
  const [currentTab, setCurrentTab] = useState<AdminTab>('dashboard');

  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 text-slate-400">
        <div className="text-center space-y-2">
          <div className="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-xs font-semibold">{t('admin.checkingSession')}</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginView key={locale} />;
  }

  // `key={locale}` re-renders every view with the newly selected language.
  return (
    <div key={locale} className="min-h-screen bg-slate-50 font-sans lg:flex">
      <Navbar currentTab={currentTab} onSelectTab={setCurrentTab} />

      <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
        <div className="mx-auto w-full max-w-6xl">
          {currentTab === 'dashboard' && <DashboardView />}
          {currentTab === 'receipts' && <ReceiptsView />}
          {currentTab === 'customers' && <CustomersView />}
          {currentTab === 'products' && <ProductsView />}
          {currentTab === 'shop' && <OnlineShopView />}
          {currentTab === 'devices' && <DevicesView />}
          {currentTab === 'reports' && <DailyReportView />}
        </div>
      </main>
    </div>
  );
};
