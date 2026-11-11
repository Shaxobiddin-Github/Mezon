import { useEffect, useCallback, useRef } from 'react';
import type { UuidV7 } from '@mezon/domain';
import { t } from '@mezon/i18n';
import { stepMilliQuantity } from '@mezon/ui';
import { normalizeLoopbackHubBaseUrl } from './bridge.js';
import { HubApiClient, HubApiError } from './api/hub-client.js';
import { usePosStore } from './store/pos-store.js';
import {
  INITIAL_SCANNER_DETECTOR_STATE,
  computeRestoredInputValue,
  extractScannerCharacter,
  stepScannerDetector,
  type ScannerDetectorState,
} from './scanner/scanner-detector.js';
import { SetupScreen, LoginScreen, OpenShiftScreen } from './components/AuthAndShiftScreens.js';
import { PosWorkspaceScreen } from './components/PosWorkspaceScreen.js';
import {
  ShortcutsModal,
  QuickSaleModal,
  EditQtyModal,
  DiscountModal,
  ParkCartModal,
  ParkedCartsListModal,
  CustomerModal,
} from './components/PosModals.js';
import {
  PaymentModal,
  ReceiptModal,
  ShiftManagementModal,
} from './components/PaymentAndShiftModals.js';
import './App.css';

function resolveBrowserFallbackBaseUrl(): string | null {
  if (typeof window.__MEZON_HUB_URL__ === 'string' && window.__MEZON_HUB_URL__.trim().length > 0) {
    try {
      return normalizeLoopbackHubBaseUrl(window.__MEZON_HUB_URL__);
    } catch {
      return null;
    }
  }
  const envUrl = import.meta.env.VITE_HUB_BASE_URL as string | undefined;
  if (typeof envUrl === 'string' && envUrl.trim().length > 0) {
    try {
      return normalizeLoopbackHubBaseUrl(envUrl);
    } catch {
      return null;
    }
  }
  return null;
}

export function App() {
  const hubBaseUrl = usePosStore((s) => s.hubBaseUrl);
  const hubStatus = usePosStore((s) => s.hubStatus);
  const hubRestartCount = usePosStore((s) => s.hubRestartCount);
  const healthStatus = usePosStore((s) => s.healthStatus);
  const needsSetup = usePosStore((s) => s.needsSetup);
  const healthCheckCount = usePosStore((s) => s.healthCheckCount);
  const setBridgeInfo = usePosStore((s) => s.setBridgeInfo);
  const setHealthInfo = usePosStore((s) => s.setHealthInfo);

  const screen = usePosStore((s) => s.screen);
  const setScreen = usePosStore((s) => s.setScreen);
  const theme = usePosStore((s) => s.theme);
  const toggleTheme = usePosStore((s) => s.toggleTheme);
  const user = usePosStore((s) => s.user);
  const clearSession = usePosStore((s) => s.clearSession);
  const setLoginOptions = usePosStore((s) => s.setLoginOptions);
  const currentShift = usePosStore((s) => s.currentShift);
  const setShiftState = usePosStore((s) => s.setShiftState);
  const setCategories = usePosStore((s) => s.setCategories);
  const setSearchResults = usePosStore((s) => s.setSearchResults);
  const setActiveCart = usePosStore((s) => s.setActiveCart);
  const setParkedCarts = usePosStore((s) => s.setParkedCarts);
  const moveSelectedLine = usePosStore((s) => s.moveSelectedLine);
  const setCustomerList = usePosStore((s) => s.setCustomerList);
  const activeModal = usePosStore((s) => s.activeModal);
  const setActiveModal = usePosStore((s) => s.setActiveModal);
  const errorBanner = usePosStore((s) => s.errorBanner);
  const setErrorBanner = usePosStore((s) => s.setErrorBanner);
  const setLastScannedBarcode = usePosStore((s) => s.setLastScannedBarcode);

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const scannerStateRef = useRef<ScannerDetectorState>(INITIAL_SCANNER_DETECTOR_STATE);
  const focusedInputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const preBurstValueRef = useRef<string | null>(null);

  const apiRef = useRef<HubApiClient | null>(null);
  if (apiRef.current === null) {
    apiRef.current = new HubApiClient({
      getBaseUrl: () => usePosStore.getState().hubBaseUrl,
      getToken: () => usePosStore.getState().token,
    });
  }
  const api = apiRef.current;

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const handleError = useCallback(
    (err: unknown) => {
      if (err instanceof HubApiError) {
        if (err.code === 'BARCODE_NOT_FOUND') {
          const rawCode = err.details?.['barcode'];
          const codeStr = typeof rawCode === 'string' ? rawCode : '';
          setErrorBanner(
            t('error.BARCODE_NOT_FOUND', {
              code: codeStr,
            }),
          );
          return;
        }
        setErrorBanner(`${err.code}: ${err.message}`);
        return;
      }
      setErrorBanner(err instanceof Error ? err.message : String(err));
    },
    [setErrorBanner],
  );

  const ensureActiveCartAndCatalog = useCallback(async () => {
    try {
      const [catsRes, prodsRes, cartsRes] = await Promise.all([
        api.listCategories(),
        api.listProducts({ limit: 50 }),
        api.listCarts(),
      ]);
      setCategories(catsRes.categories);
      setSearchResults(prodsRes.products);
      setParkedCarts(cartsRes.carts.filter((c) => c.status === 'parked'));

      const openCartSummary = cartsRes.carts.find((c) => c.status === 'open');
      if (openCartSummary) {
        const detail = await api.getCart(openCartSummary.id);
        setActiveCart(detail.cart);
      } else {
        const created = await api.createCart();
        setActiveCart(created.cart);
      }
    } catch (err) {
      handleError(err);
    }
  }, [api, setCategories, setSearchResults, setParkedCarts, setActiveCart, handleError]);

  const checkHubHealth = useCallback(
    async (rawUrl?: string | null) => {
      const targetUrl = rawUrl ?? usePosStore.getState().hubBaseUrl;
      if (!targetUrl) {
        setHealthInfo({ status: 'error', needsSetup: false });
        return null;
      }
      try {
        const safeUrl = normalizeLoopbackHubBaseUrl(targetUrl);
        const res = await fetch(`${safeUrl}/health`, {
          method: 'GET',
          headers: { accept: 'application/json' },
        });
        if (!res.ok) {
          throw new Error(`HTTP ${String(res.status)}`);
        }
        const body = (await res.json()) as { status?: string; needsSetup?: boolean };
        const statusStr = typeof body.status === 'string' ? body.status : 'unknown';
        const needsSetupBool = Boolean(body.needsSetup);
        setHealthInfo({ status: statusStr, needsSetup: needsSetupBool });
        return { safeUrl, needsSetupBool };
      } catch {
        setHealthInfo({ status: 'error', needsSetup: false });
        return null;
      }
    },
    [setHealthInfo],
  );

  const bootstrapFlow = useCallback(
    async (needsSetupBool: boolean) => {
      if (needsSetupBool) {
        setScreen('setup');
        return;
      }
      try {
        const opts = await api.getLoginOptions();
        setLoginOptions(opts.options);
        setScreen('login');
      } catch (err) {
        handleError(err);
      }
    },
    [api, setScreen, setLoginOptions, handleError],
  );

  useEffect(() => {
    const bridge = window.mezonBridge;
    if (bridge === undefined) {
      const fallbackUrl = resolveBrowserFallbackBaseUrl();
      if (fallbackUrl !== null) {
        setBridgeInfo({
          baseUrl: fallbackUrl,
          status: 'ready',
          restartCount: 0,
        });
        void checkHubHealth(fallbackUrl).then((res) => {
          if (res !== null) {
            void bootstrapFlow(res.needsSetupBool);
          }
        });
      } else {
        setBridgeInfo({
          baseUrl: null,
          status: 'error',
          restartCount: 0,
        });
      }
      return;
    }

    let cancelled = false;
    void bridge.getHubState().then((initial) => {
      if (cancelled) return;
      let safeUrl: string | null = null;
      if (initial.baseUrl) {
        try {
          safeUrl = normalizeLoopbackHubBaseUrl(initial.baseUrl);
        } catch {
          safeUrl = null;
        }
      }
      setBridgeInfo({
        baseUrl: safeUrl,
        status: initial.status,
        restartCount: initial.restartCount,
      });
      if (initial.status === 'ready' && safeUrl !== null) {
        void checkHubHealth(safeUrl).then((res) => {
          if (!cancelled && res !== null && usePosStore.getState().screen === 'loading') {
            void bootstrapFlow(res.needsSetupBool);
          }
        });
      }
    });

    const unsubscribe = bridge.onHubState((next) => {
      if (cancelled) return;
      let safeUrl: string | null = null;
      if (next.baseUrl) {
        try {
          safeUrl = normalizeLoopbackHubBaseUrl(next.baseUrl);
        } catch {
          safeUrl = null;
        }
      }
      setBridgeInfo({
        baseUrl: safeUrl,
        status: next.status,
        restartCount: next.restartCount,
      });
      if (next.status === 'ready' && safeUrl !== null) {
        void checkHubHealth(safeUrl).then((res) => {
          if (!cancelled && res !== null && usePosStore.getState().screen === 'loading') {
            void bootstrapFlow(res.needsSetupBool);
          }
        });
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [setBridgeInfo, checkHubHealth, bootstrapFlow]);

  const handleScanBarcode = useCallback(
    async (barcode: string) => {
      setLastScannedBarcode(barcode);
      setErrorBanner(null);
      try {
        let cartId = usePosStore.getState().activeCart?.id;
        if (!cartId) {
          const created = await api.createCart();
          setActiveCart(created.cart);
          cartId = created.cart.id;
        }
        const updated = await api.addCartLine(cartId, {
          kind: 'scan',
          barcode,
          qty: '1000',
        });
        setActiveCart(updated.cart);
      } catch (err) {
        handleError(err);
      }
    },
    [api, setActiveCart, setErrorBanner, setLastScannedBarcode, handleError],
  );

  // Global USB Scanner Detector + Keyboard Shortcuts
  useEffect(() => {
    if (screen !== 'pos') return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const nowMs = performance.now();
      const activeEl = document.activeElement;
      const isInputFocused =
        activeEl instanceof HTMLInputElement ||
        activeEl instanceof HTMLTextAreaElement ||
        activeEl instanceof HTMLSelectElement;

      const scannerChar = extractScannerCharacter({
        key: event.key,
        code: event.code,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        timestampMs: nowMs,
      });

      const currentScanState = scannerStateRef.current;

      if (scannerChar !== null || event.key === 'Enter' || event.key === 'Tab') {
        const outcome = stepScannerDetector(currentScanState, {
          key: scannerChar ?? event.key,
          code: event.code,
          ctrlKey: false,
          altKey: event.altKey,
          metaKey: event.metaKey,
          timestampMs: nowMs,
        });

        scannerStateRef.current = outcome.state;

        if (outcome.type === 'buffering' && outcome.startedNewSequence) {
          if (activeEl instanceof HTMLInputElement || activeEl instanceof HTMLTextAreaElement) {
            focusedInputRef.current = activeEl;
            preBurstValueRef.current = activeEl.value;
          } else {
            focusedInputRef.current = null;
            preBurstValueRef.current = null;
          }
        }

        if (outcome.type === 'scan_completed') {
          event.preventDefault();
          event.stopPropagation();

          const targetInput = focusedInputRef.current;
          if (targetInput !== null) {
            const restored = computeRestoredInputValue({
              currentInputValue: targetInput.value,
              preBurstSnapshotValue: preBurstValueRef.current,
              scannedBarcode: outcome.barcode,
            });
            targetInput.value = restored;
            if (targetInput === searchInputRef.current) {
              usePosStore.getState().setSearchQuery(restored);
            }
          }
          focusedInputRef.current = null;
          preBurstValueRef.current = null;

          void handleScanBarcode(outcome.barcode);
          return;
        }
      }

      if (event.key === 'Escape') {
        if (usePosStore.getState().activeModal !== 'none') {
          event.preventDefault();
          setActiveModal('none');
          return;
        }
      }

      if (event.key === 'F1') {
        event.preventDefault();
        setActiveModal('shortcuts');
        return;
      }
      if (event.key === 'F2') {
        event.preventDefault();
        setActiveModal('none');
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }
      if (event.key === 'F3') {
        event.preventDefault();
        setActiveModal('quick_sale');
        return;
      }
      if (event.key === 'F4') {
        event.preventDefault();
        setActiveModal('discount');
        return;
      }
      if (event.key === 'F5') {
        event.preventDefault();
        const cart = usePosStore.getState().activeCart;
        if (cart && cart.lines.length > 0) {
          setActiveModal('park_cart');
        }
        return;
      }
      if (event.key === 'F6') {
        event.preventDefault();
        void api.listCarts().then((res) => {
          setParkedCarts(res.carts.filter((c) => c.status === 'parked'));
          setActiveModal('parked_list');
        });
        return;
      }
      if (event.key === 'F7') {
        event.preventDefault();
        void api.listCustomers({ limit: 30 }).then((res) => {
          setCustomerList(res.items);
          setActiveModal('customer');
        });
        return;
      }
      if (event.key === 'F8') {
        event.preventDefault();
        setActiveModal('shift_manage');
        return;
      }
      if (event.key === 'F9') {
        event.preventDefault();
        const cart = usePosStore.getState().activeCart;
        if (cart && cart.lines.length > 0) {
          setActiveModal('payment');
        }
        return;
      }
      if (event.key === 'F12') {
        event.preventDefault();
        toggleTheme();
        return;
      }

      // Cart line navigation & adjustment when no modal is open and no input is focused
      if (usePosStore.getState().activeModal === 'none' && !isInputFocused) {
        const state = usePosStore.getState();
        const cart = state.activeCart;
        const line = cart?.lines.find((l) => l.id === state.selectedLineId);

        if (event.key === 'ArrowDown') {
          event.preventDefault();
          moveSelectedLine(1);
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          moveSelectedLine(-1);
          return;
        }
        if ((event.key === '+' || event.key === '=') && cart && line) {
          event.preventDefault();
          const nextQty = stepMilliQuantity(line.qty, 1);
          void api
            .updateCartLine(cart.id, line.id, { qty: nextQty })
            .then((res) => setActiveCart(res.cart))
            .catch(handleError);
          return;
        }
        if (event.key === '-' && cart && line) {
          event.preventDefault();
          const nextQty = stepMilliQuantity(line.qty, -1);
          if (nextQty !== line.qty) {
            void api
              .updateCartLine(cart.id, line.id, { qty: nextQty })
              .then((res) => setActiveCart(res.cart))
              .catch(handleError);
          }
          return;
        }
        if (event.key === 'Delete' && cart && line) {
          event.preventDefault();
          void api
            .removeCartLine(cart.id, line.id)
            .then((res) => setActiveCart(res.cart))
            .catch(handleError);
          return;
        }
        if (event.key === 'Enter' && cart && line) {
          event.preventDefault();
          setActiveModal('edit_qty');
          return;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [
    screen,
    api,
    handleScanBarcode,
    setActiveModal,
    setParkedCarts,
    setCustomerList,
    toggleTheme,
    moveSelectedLine,
    setActiveCart,
    handleError,
  ]);

  const handleLogout = async () => {
    try {
      await api.logout();
    } catch {
      // ignore logout error
    }
    clearSession();
    try {
      const opts = await api.getLoginOptions();
      setLoginOptions(opts.options);
    } catch (err) {
      handleError(err);
    }
  };

  const handleSearchProducts = useCallback(
    async (q: string, categoryId: UuidV7 | null) => {
      try {
        const res = await api.listProducts({
          q: q.trim().length > 0 ? q.trim() : undefined,
          categoryId: categoryId ?? undefined,
          limit: 50,
        });
        setSearchResults(res.products);
      } catch (err) {
        handleError(err);
      }
    },
    [api, setSearchResults, handleError],
  );

  const handleOpenParkedModal = useCallback(async () => {
    try {
      const res = await api.listCarts();
      setParkedCarts(res.carts.filter((c) => c.status === 'parked'));
      setActiveModal('parked_list');
    } catch (err) {
      handleError(err);
    }
  }, [api, setParkedCarts, setActiveModal, handleError]);

  const handleOpenCustomerModal = useCallback(async () => {
    try {
      const res = await api.listCustomers({ limit: 30 });
      setCustomerList(res.items);
      setActiveModal('customer');
    } catch (err) {
      handleError(err);
    }
  }, [api, setCustomerList, setActiveModal, handleError]);

  return (
    <div className="pos-shell" data-testid="pos-shell">
      <header className="pos-header">
        <div className="pos-header-brand">
          <h1 className="pos-header-title">{t('app.title')}</h1>
          <span className="pos-non-fiscal-badge" data-testid="non-fiscal-badge">
            {t('receipt.nonFiscalBanner')}
          </span>
          {user && (
            <span className="pos-telemetry-item" data-testid="active-user-badge">
              {user.fullName} ({user.role})
            </span>
          )}
          {currentShift && (
            <span className="pos-telemetry-item" data-testid="active-shift-badge">
              Smena #{currentShift.shiftNo}
            </span>
          )}
        </div>

        <div className="pos-telemetry">
          <span className="pos-telemetry-item">
            {t('app.hub.status')}: <strong data-testid="hub-status">{hubStatus}</strong>
          </span>
          <span className="pos-telemetry-item">
            <strong data-testid="hub-url">{hubBaseUrl ?? 'kutilyapti...'}</strong>
          </span>
          <span className="pos-telemetry-item">
            <strong data-testid="hub-origin">{window.location.origin}</strong>
          </span>
          <span className="pos-telemetry-item">
            {t('app.hub.restarts')}:{' '}
            <strong data-testid="hub-restart-count">{hubRestartCount}</strong>
          </span>
          <span className="pos-telemetry-item">
            {t('app.hub.health')}: <strong data-testid="health-status">{healthStatus}</strong>
          </span>
          <span className="pos-telemetry-item">
            {t('app.hub.needsSetup')}:{' '}
            <strong data-testid="health-needs-setup">
              {needsSetup === null ? 'unknown' : String(needsSetup)}
            </strong>
          </span>
          <span className="pos-telemetry-item">
            <strong data-testid="health-check-count">{healthCheckCount}</strong>
          </span>
        </div>

        <div className="pos-top-actions">
          <button
            type="button"
            className="pos-btn"
            data-testid="refresh-health-btn"
            onClick={() => {
              void checkHubHealth(hubBaseUrl);
            }}
          >
            {t('app.hub.refresh')}
          </button>
          <button
            type="button"
            className="pos-btn"
            data-testid="theme-toggle-btn"
            onClick={toggleTheme}
          >
            {theme === 'light' ? t('app.theme.dark') : t('app.theme.light')}
          </button>
          {screen === 'pos' && (
            <>
              <button
                type="button"
                className="pos-btn"
                data-testid="topbar-shortcuts-btn"
                onClick={() => setActiveModal('shortcuts')}
              >
                {t('pos.shortcutsBtn')}
              </button>
              <button
                type="button"
                className="pos-btn"
                data-testid="topbar-shift-btn"
                onClick={() => setActiveModal('shift_manage')}
              >
                {t('shift.manageButton')}
              </button>
              <button
                type="button"
                className="pos-btn pos-btn-danger"
                data-testid="topbar-logout-btn"
                onClick={() => void handleLogout()}
              >
                {t('auth.logoutButton')}
              </button>
            </>
          )}
        </div>
      </header>

      {errorBanner && (
        <div className="pos-error-banner" role="alert" data-testid="pos-error-banner">
          <span>{errorBanner}</span>
          <button
            type="button"
            className="pos-btn"
            data-testid="dismiss-error-btn"
            onClick={() => setErrorBanner(null)}
          >
            ✕
          </button>
        </div>
      )}

      {screen === 'loading' && (
        <div className="pos-auth-container" data-testid="screen-loading">
          <h2>{t('app.title')}</h2>
          <p>{t('common.loading')}</p>
        </div>
      )}

      {screen === 'setup' && (
        <SetupScreen
          api={api}
          onSetupCompleted={async () => {
            await checkHubHealth(hubBaseUrl);
            const opts = await api.getLoginOptions();
            setLoginOptions(opts.options);
            setScreen('login');
          }}
          onError={handleError}
        />
      )}

      {screen === 'login' && (
        <LoginScreen
          api={api}
          onLoginSuccess={async () => {
            const shiftRes = await api.getCurrentShift();
            setShiftState({
              shift: shiftRes.shift,
              drawerCashBalance: shiftRes.drawerCashBalance,
              maxCashDiscrepancyWithoutOverride: shiftRes.maxCashDiscrepancyWithoutOverride,
            });
            if (shiftRes.shift !== null && shiftRes.shift.status === 'open') {
              setScreen('pos');
              await ensureActiveCartAndCatalog();
            } else {
              setScreen('open_shift');
            }
          }}
          onError={handleError}
        />
      )}

      {screen === 'open_shift' && (
        <OpenShiftScreen
          api={api}
          onShiftOpened={async () => {
            setScreen('pos');
            await ensureActiveCartAndCatalog();
          }}
          onError={handleError}
        />
      )}

      {screen === 'pos' && (
        <PosWorkspaceScreen
          api={api}
          searchInputRef={searchInputRef}
          onSearchProducts={handleSearchProducts}
          onOpenParkedModal={handleOpenParkedModal}
          onOpenCustomerModal={handleOpenCustomerModal}
          onError={handleError}
        />
      )}

      {activeModal === 'shortcuts' && <ShortcutsModal />}
      {activeModal === 'quick_sale' && <QuickSaleModal api={api} onError={handleError} />}
      {activeModal === 'edit_qty' && <EditQtyModal api={api} onError={handleError} />}
      {activeModal === 'discount' && <DiscountModal api={api} onError={handleError} />}
      {activeModal === 'park_cart' && (
        <ParkCartModal
          api={api}
          onParked={async () => {
            const [created, cartsRes] = await Promise.all([api.createCart(), api.listCarts()]);
            setActiveCart(created.cart);
            setParkedCarts(cartsRes.carts.filter((c) => c.status === 'parked'));
          }}
          onError={handleError}
        />
      )}
      {activeModal === 'parked_list' && (
        <ParkedCartsListModal
          api={api}
          onResumed={async (cartId) => {
            const [detail, cartsRes] = await Promise.all([api.getCart(cartId), api.listCarts()]);
            setActiveCart(detail.cart);
            setParkedCarts(cartsRes.carts.filter((c) => c.status === 'parked'));
          }}
          onError={handleError}
        />
      )}
      {activeModal === 'customer' && <CustomerModal api={api} onError={handleError} />}
      {activeModal === 'payment' && (
        <PaymentModal
          api={api}
          onSaleCompleted={async () => {
            const [created, shiftRes] = await Promise.all([
              api.createCart(),
              api.getCurrentShift(),
            ]);
            setActiveCart(created.cart);
            setShiftState({
              shift: shiftRes.shift,
              drawerCashBalance: shiftRes.drawerCashBalance,
              maxCashDiscrepancyWithoutOverride: shiftRes.maxCashDiscrepancyWithoutOverride,
            });
          }}
          onError={handleError}
        />
      )}
      {activeModal === 'receipt' && <ReceiptModal />}
      {activeModal === 'shift_manage' && (
        <ShiftManagementModal
          api={api}
          onShiftClosed={() => {
            setScreen('open_shift');
            return Promise.resolve();
          }}
          onError={handleError}
        />
      )}
    </div>
  );
}
export default App;
