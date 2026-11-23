import type { IntegrationsStatusResponse, LoadDemoCatalogResponse } from '@mezon/contracts';
import { t } from '@mezon/i18n';
import { useCallback, useEffect, useState } from 'react';
import { type HubApiClient, HubApiError } from '../api/hub-client.js';

function StateChip({ kind }: { readonly kind: 'real' | 'test' | 'none' }) {
  return (
    <span className={`pos-int-chip pos-int-chip-${kind}`}>
      {kind === 'real'
        ? t('integrations.state.real')
        : kind === 'test'
          ? t('integrations.state.test')
          : t('integrations.state.none')}
    </span>
  );
}

function fiscalProblemText(code: string): string {
  switch (code) {
    case 'RULES_PACKAGE_NOT_OK':
      return t('integrations.fiscal.problem.rules');
    case 'DRIVER_UNREACHABLE':
      return t('integrations.fiscal.problem.driver');
    case 'PRODUCTS_WITHOUT_MXIK':
      return t('integrations.fiscal.problem.mxik');
    case 'RECEIPT_FIELDS_NOT_CONFIGURED':
      return t('integrations.fiscal.problem.fields');
    default:
      return code;
  }
}

const chip = (isTest: boolean): 'real' | 'test' => (isTest ? 'test' : 'real');

/**
 * V2 settings tab "Ulanishlar holati": the owner sees at a glance what is real and what is a demo,
 * switches demo mode, and sets the marking MXIK prefixes until the official list arrives.
 */
export function IntegrationsPanel(props: {
  readonly api: HubApiClient;
  readonly role: 'owner' | 'manager';
  readonly onError: (err: unknown) => void;
  readonly onChanged?: (st: IntegrationsStatusResponse) => void;
  readonly onCatalogLoaded?: () => void;
}) {
  const { api, role, onError, onChanged, onCatalogLoaded } = props;
  const [catalogLoaded, setCatalogLoaded] = useState<LoadDemoCatalogResponse | null>(null);
  const [st, setSt] = useState<IntegrationsStatusResponse | null>(null);
  const [prefixes, setPrefixes] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [fiscalProblems, setFiscalProblems] = useState<readonly string[]>([]);
  const [shiftNotOnDriver, setShiftNotOnDriver] = useState(false);

  const apply = useCallback(
    (next: IntegrationsStatusResponse) => {
      setSt(next);
      setPrefixes(next.marking.mxikPrefixes.join(', '));
      onChanged?.(next);
    },
    [onChanged],
  );

  const loadFiscalShift = useCallback(() => {
    api.getFiscalStatus().then(
      (f) => setShiftNotOnDriver(f.modeEnabled && f.shiftNotOpenOnDriver),
      () => undefined,
    );
  }, [api]);

  useEffect(() => {
    api.getIntegrations().then(apply, onError);
    loadFiscalShift();
  }, [api, apply, onError, loadFiscalShift]);

  if (st === null) return null;

  const toggleDemo = async () => {
    setBusy(true);
    try {
      apply(await api.setDemoMode(!st.demoMode));
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const loadCatalog = async () => {
    setBusy(true);
    try {
      setCatalogLoaded(await api.loadDemoCatalog());
      onCatalogLoaded?.();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const toggleFiscal = async () => {
    setBusy(true);
    setFiscalProblems([]);
    try {
      await api.setFiscalMode(!st.fiscal.modeEnabled);
      apply(await api.getIntegrations());
      loadFiscalShift();
    } catch (err) {
      const failures = err instanceof HubApiError ? err.details?.['failures'] : undefined;
      if (Array.isArray(failures)) {
        setFiscalProblems(failures.filter((f): f is string => typeof f === 'string'));
      } else {
        onError(err);
      }
    } finally {
      setBusy(false);
    }
  };

  const savePrefixes = async () => {
    setBusy(true);
    setSaved(false);
    try {
      const list = prefixes
        .split(/[\s,;]+/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      apply(await api.setMarkingPrefixes(list));
      setSaved(true);
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const rulesText =
    st.rules.state === 'ok'
      ? st.rules.isDemoPackage
        ? t('integrations.rules.demo')
        : t('integrations.rules.ok', { version: st.rules.packageVersion ?? '—' })
      : t(`integrations.rules.${st.rules.state}`);

  return (
    <div className="pos-int" data-testid="integrations-panel">
      <div className="pos-int-head">
        <h3>{t('integrations.title')}</h3>
        <p>{t('integrations.subtitle')}</p>
      </div>

      <div className={`pos-int-card ${st.demoMode ? 'pos-int-card-demo' : ''}`}>
        <div className="pos-int-row">
          <strong>{t('integrations.demo.title')}</strong>
          <span
            className={`pos-int-chip ${st.demoMode ? 'pos-int-chip-test' : ''}`}
            data-testid="integrations-demo-state"
          >
            {st.demoMode ? t('integrations.demo.on') : t('integrations.demo.off')}
          </span>
        </div>
        <p className="pos-int-text">{t('integrations.demo.text')}</p>
        {role === 'owner' ? (
          <button
            type="button"
            className={`pos-btn ${st.demoMode ? '' : 'pos-btn-primary'}`}
            data-testid="integrations-demo-toggle"
            disabled={busy}
            onClick={() => void toggleDemo()}
          >
            {st.demoMode ? t('integrations.demo.disable') : t('integrations.demo.enable')}
          </button>
        ) : (
          <p className="pos-int-need">{t('integrations.demo.ownerOnly')}</p>
        )}
      </div>

      {role === 'owner' && (
        <div className="pos-int-card" data-testid="demo-catalog-card">
          <div className="pos-int-row">
            <strong>{t('integrations.catalog.title')}</strong>
          </div>
          <p className="pos-int-text">{t('integrations.catalog.text')}</p>
          {catalogLoaded ? (
            <p className="pos-int-ok" data-testid="demo-catalog-done">
              {t('integrations.catalog.done', {
                products: String(catalogLoaded.products),
                categories: String(catalogLoaded.categories),
                customers: String(catalogLoaded.customers),
              })}
            </p>
          ) : (
            <button
              type="button"
              className="pos-btn pos-btn-primary"
              data-testid="demo-catalog-load"
              disabled={busy}
              onClick={() => void loadCatalog()}
            >
              {t('integrations.catalog.load')}
            </button>
          )}
        </div>
      )}

      <div className="pos-int-card">
        <div className="pos-int-row">
          <strong>{t('integrations.fiscal.title')}</strong>
          <StateChip kind={chip(st.fiscal.isTestDriver)} />
        </div>
        <p className="pos-int-text">
          {st.fiscal.modeEnabled
            ? t('integrations.fiscal.modeOn')
            : t('integrations.fiscal.modeOff')}
        </p>
        {role === 'owner' && (
          <button
            type="button"
            className="pos-btn"
            data-testid="integrations-fiscal-toggle"
            disabled={busy}
            onClick={() => void toggleFiscal()}
          >
            {st.fiscal.modeEnabled
              ? t('integrations.fiscal.disable')
              : t('integrations.fiscal.enable')}
          </button>
        )}
        {shiftNotOnDriver && (
          <p className="pos-int-warn" data-testid="integrations-fiscal-reopen-shift">
            {t('integrations.fiscal.reopenShift')}
          </p>
        )}
        {fiscalProblems.length > 0 && (
          <ul className="pos-int-problems" data-testid="integrations-fiscal-problems">
            {fiscalProblems.map((f) => (
              <li key={f}>{fiscalProblemText(f)}</li>
            ))}
          </ul>
        )}
        {st.fiscal.isTestDriver && <p className="pos-int-need">{t('integrations.fiscal.need')}</p>}
      </div>

      <div className="pos-int-card">
        <div className="pos-int-row">
          <strong>{t('integrations.payment.title')}</strong>
          <StateChip kind={chip(st.payment.isTestDriver)} />
        </div>
        {st.payment.isTestDriver && (
          <p className="pos-int-need">{t('integrations.payment.need')}</p>
        )}
      </div>

      <div className="pos-int-card">
        <div className="pos-int-row">
          <strong>{t('integrations.marking.title')}</strong>
          <StateChip kind={chip(st.marking.isTestDriver)} />
        </div>
        <label className="pos-form-label" htmlFor="int-marking-prefixes">
          {t('integrations.marking.prefixes')}
        </label>
        <div className="pos-search-bar">
          <input
            id="int-marking-prefixes"
            className="pos-input"
            data-testid="integrations-marking-prefixes"
            value={prefixes}
            placeholder="0220, 0330"
            onChange={(e) => {
              setSaved(false);
              setPrefixes(e.target.value);
            }}
          />
          <button
            type="button"
            className="pos-btn"
            data-testid="integrations-marking-save"
            disabled={busy}
            onClick={() => void savePrefixes()}
          >
            {saved ? t('integrations.marking.saved') : t('integrations.marking.save')}
          </button>
        </div>
        {st.marking.isTestDriver && (
          <p className="pos-int-need">{t('integrations.marking.need')}</p>
        )}
      </div>

      <div className="pos-int-card">
        <div className="pos-int-row">
          <strong>{t('integrations.rules.title')}</strong>
          <StateChip
            kind={st.rules.state !== 'ok' ? 'none' : st.rules.isDemoPackage ? 'test' : 'real'}
          />
        </div>
        <p className="pos-int-text" data-testid="integrations-rules-state">
          {rulesText}
        </p>
        {(st.rules.state !== 'ok' || st.rules.isDemoPackage) && (
          <p className="pos-int-need">{t('integrations.rules.need')}</p>
        )}
      </div>
    </div>
  );
}
