import { useCallback, useEffect, useState } from 'react';
import './App.css';
import {
  buildHubHealthUrl,
  type HealthPayload,
  type HubBridgeState,
  parseHealthPayload,
} from './bridge.js';

interface UiHealthState {
  readonly status: 'loading' | 'ok' | 'error';
  readonly health: HealthPayload | null;
  readonly errorMessage: string | null;
  readonly checkCount: number;
}

const INITIAL_HUB_STATE: HubBridgeState = {
  baseUrl: null,
  restartCount: 0,
  status: 'starting',
};

export function App() {
  const [hubState, setHubState] = useState<HubBridgeState>(INITIAL_HUB_STATE);
  const [healthState, setHealthState] = useState<UiHealthState>({
    status: 'loading',
    health: null,
    errorMessage: null,
    checkCount: 0,
  });

  const checkHealth = useCallback(async (baseUrl: string | null) => {
    if (baseUrl === null) {
      setHealthState((prev) => ({
        ...prev,
        status: 'loading',
        errorMessage: null,
      }));
      return;
    }

    try {
      const response = await fetch(buildHubHealthUrl(baseUrl), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${String(response.status)}`);
      }
      const parsed = parseHealthPayload((await response.json()) as unknown);
      setHealthState((prev) => ({
        status: 'ok',
        health: parsed,
        errorMessage: null,
        checkCount: prev.checkCount + 1,
      }));
    } catch (error) {
      setHealthState((prev) => ({
        status: 'error',
        health: null,
        errorMessage: error instanceof Error ? error.message : String(error),
        checkCount: prev.checkCount,
      }));
    }
  }, []);

  useEffect(() => {
    const bridge = window.mezonBridge;
    if (bridge === undefined) {
      setHubState({
        baseUrl: null,
        restartCount: 0,
        status: 'error',
        lastError: 'Electron mezonBridge topilmadi',
      });
      return;
    }

    let cancelled = false;
    void bridge.getHubState().then((initialState) => {
      if (!cancelled) {
        setHubState(initialState);
      }
    });

    const unsubscribe = bridge.onHubState((nextState) => {
      if (!cancelled) {
        setHubState(nextState);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (hubState.status === 'ready' && hubState.baseUrl !== null) {
      void checkHealth(hubState.baseUrl);
    } else if (hubState.status === 'restarting' || hubState.status === 'starting') {
      setHealthState((prev) => ({
        ...prev,
        status: 'loading',
        errorMessage: null,
      }));
    } else if (hubState.status === 'error') {
      setHealthState((prev) => ({
        status: 'error',
        health: null,
        errorMessage: hubState.lastError ?? 'Hub ishga tushmadi',
        checkCount: prev.checkCount,
      }));
    }
  }, [hubState, checkHealth]);

  const currentOrigin = typeof window !== 'undefined' ? window.location.origin : '';

  return (
    <main className="mezon-shell">
      <h1 className="mezon-title">Mezon Kassa</h1>
      <p className="mezon-subtitle">Lokal hub holati (T0.7 qobiq)</p>

      <dl className="mezon-grid">
        <dt>UI Origin:</dt>
        <dd data-testid="hub-origin">{currentOrigin}</dd>

        <dt>Hub holati:</dt>
        <dd data-testid="hub-lifecycle">{hubState.status}</dd>

        <dt>Hub manzili:</dt>
        <dd data-testid="hub-url">{hubState.baseUrl ?? '-'}</dd>

        <dt>Qayta ko&apos;tarilish:</dt>
        <dd data-testid="hub-restart-count">{String(hubState.restartCount)}</dd>

        <dt>/health natijasi:</dt>
        <dd data-testid="health-status">{healthState.health?.status ?? healthState.status}</dd>

        <dt>needsSetup:</dt>
        <dd data-testid="health-needs-setup">
          {healthState.health === null ? '-' : String(healthState.health.needsSetup)}
        </dd>

        <dt>Tekshiruv soni:</dt>
        <dd data-testid="health-check-count">{String(healthState.checkCount)}</dd>
      </dl>

      {healthState.errorMessage !== null && (
        <p data-testid="health-error" className="mezon-error">
          Xato: {healthState.errorMessage}
        </p>
      )}

      <button
        type="button"
        data-testid="refresh-health-btn"
        className="mezon-refresh-btn"
        onClick={() => {
          void checkHealth(hubState.baseUrl);
        }}
      >
        Qayta tekshirish
      </button>
    </main>
  );
}
