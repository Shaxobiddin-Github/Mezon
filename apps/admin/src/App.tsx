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
    <div key={locale} className="min-h-screen bg-slate-50 flex flex-col font-sans">
      <Navbar currentTab={currentTab} onSelectTab={setCurrentTab} />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {currentTab === 'dashboard' && <DashboardView />}
        {currentTab === 'receipts' && <ReceiptsView />}
        {currentTab === 'customers' && <CustomersView />}
        {currentTab === 'reports' && <DailyReportView />}
      </main>
    </div>
  );
};
