import type { HubCloudStatusDto } from '@mezon/contracts';
import { type I18nKey, t } from '@mezon/i18n';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import type { HubApiClient, LanPairingCode, LanStatus, LanTerminal } from '../api/hub-client.js';
import { type TerminalInfo, formatFingerprint } from '../bridge.js';

/** Port the desktop hub opens for LAN terminals (apps/hub electron-worker DEFAULT_LAN_PORT). */
export const DEFAULT_LAN_PORT = 47821;

const fmtTime = (ms: string | number | null | undefined) =>
  ms === null || ms === undefined ? '—' : new Date(Number(ms)).toLocaleString();

function Fingerprint({ value, testId }: { readonly value: string; readonly testId: string }) {
  return (
    <code className="pos-fingerprint" data-testid={testId}>
      {formatFingerprint(value)}
    </code>
  );
}

/**
 * v1: a fresh install joins an existing shop as a second cash register (LAN terminal).
 * Shown on the first-setup screen; the desktop main process does the pinned TLS pairing.
 */
export function TerminalPairForm({ onCancel }: { readonly onCancel?: () => void }) {
  const bridge = window.mezonBridge;
  const [host, setHost] = useState('');
  const [port, setPort] = useState(String(DEFAULT_LAN_PORT));
  const [code, setCode] = useState('');
  const [name, setName] = useState(bridge?.thinClient === true ? 'Telefon' : 'Kassa 2');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paired, setPaired] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (bridge?.pairAsTerminal === undefined || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await bridge.pairAsTerminal({
        host: host.trim(),
        port: Number(port),
        code: code.trim(),
        terminalName: name.trim(),
      });
      if (res.ok) setPaired(res.fingerprint256);
      else setError(t(`terminal.pair.error.${res.code}` as I18nKey));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (paired !== null) {
    return (
      <div className="pos-auth-container" data-testid="terminal-paired">
        <h2>{t('terminal.pair.doneTitle')}</h2>
        <p>{t('terminal.pair.compareFingerprint')}</p>
        <Fingerprint value={paired} testId="terminal-paired-fingerprint" />
        <p>{t('terminal.pair.restartHint')}</p>
        <button
          type="button"
          className="pos-btn pos-btn-primary"
          data-testid="terminal-restart-btn"
          onClick={() => void bridge?.relaunchApp?.()}
        >
          {t('terminal.restart')}
        </button>
      </div>
    );
  }

  return (
    <div className="pos-auth-container" data-testid="terminal-pair-form">
      <h2>{t('terminal.pair.title')}</h2>
      <p>{t('terminal.pair.hint')}</p>
      <form onSubmit={(e) => void submit(e)}>
        <div className="pos-form-group">
          <label className="pos-form-label" htmlFor="terminal-host">
            {t('terminal.pair.host')}
          </label>
          <input
            id="terminal-host"
            className="pos-input"
            data-testid="terminal-host-input"
            placeholder="192.168.1.10"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            required
            autoFocus
          />
        </div>
        <div className="pos-form-group">
          <label className="pos-form-label" htmlFor="terminal-port">
            {t('terminal.pair.port')}
          </label>
          <input
            id="terminal-port"
            className="pos-input"
            data-testid="terminal-port-input"
            inputMode="numeric"
            value={port}
            onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))}
            required
          />
        </div>
        <div className="pos-form-group">
          <label className="pos-form-label" htmlFor="terminal-code">
            {t('terminal.pair.code')}
          </label>
          <input
            id="terminal-code"
            className="pos-input"
            data-testid="terminal-code-input"
            placeholder="XXXXX-XXXXX"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            required
          />
        </div>
        <div className="pos-form-group">
          <label className="pos-form-label" htmlFor="terminal-name">
            {t('terminal.pair.name')}
          </label>
          <input
            id="terminal-name"
            className="pos-input"
            data-testid="terminal-name-input"
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        {error !== null && (
          <p className="pos-form-error" role="alert" data-testid="terminal-pair-error">
            {error}
          </p>
        )}
        <button
          type="submit"
          className="pos-btn pos-btn-primary"
          data-testid="terminal-pair-submit"
          disabled={busy}
        >
          {busy ? t('common.loading') : t('terminal.pair.submit')}
        </button>
        {onCancel !== undefined && (
          <button type="button" className="pos-btn" onClick={onCancel} disabled={busy}>
            {t('terminal.pair.back')}
          </button>
        )}
      </form>
    </div>
  );
}

/** Terminal mode: which main register this computer works with, and leaving it. */
export function TerminalModeSection({
  info,
}: {
  readonly info: TerminalInfo & { mode: 'terminal' };
}) {
  const bridge = window.mezonBridge;
  const [busy, setBusy] = useState(false);
  const leave = async () => {
    if (busy || !window.confirm(t('terminal.leaveConfirm'))) return;
    setBusy(true);
    try {
      const res = await bridge?.leaveTerminal?.();
      if (res?.ok === true) await bridge?.relaunchApp?.();
    } finally {
      setBusy(false);
    }
  };
  return (
    <section data-testid="terminal-mode-section">
      <h4>{t('terminal.modeTitle')}</h4>
      <p>
        {t('terminal.connectedTo', {
          name: info.terminalName,
          host: `${info.hubHost}:${String(info.hubPort)}`,
        })}
      </p>
      <Fingerprint value={info.fingerprint256} testId="terminal-mode-fingerprint" />
      <div>
        <button
          type="button"
          className="pos-btn pos-btn-danger"
          data-testid="terminal-leave-btn"
          disabled={busy}
          onClick={() => void leave()}
        >
          {t('terminal.leave')}
        </button>
      </div>
    </section>
  );
}

/** Owner: connect this shop's main register to the cloud cabinet with a one-time code. */
export function CloudSection(props: {
  readonly api: HubApiClient;
  readonly onError: (err: unknown) => void;
}) {
  const { api, onError } = props;
  const [status, setStatus] = useState<HubCloudStatusDto | null>(null);
  const [cloudUrl, setCloudUrl] = useState('https://');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(() => {
    api.getCloudStatus().then(setStatus, onError);
  }, [api, onError]);
  useEffect(load, [load]);

  const pair = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const res = await api.pairCloud({ cloudUrl: cloudUrl.trim(), code: code.trim() });
      setDone(t('cloud.paired', { org: res.organizationName, store: res.storeName }));
      setCode('');
      load();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const unpair = async () => {
    if (busy || !window.confirm(t('cloud.unpairConfirm'))) return;
    setBusy(true);
    try {
      await api.unpairCloud();
      setDone(null);
      load();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section data-testid="cloud-section">
      <h4>{t('cloud.title')}</h4>
      {status === null && <p>{t('common.loading')}</p>}
      {status !== null && (
        <p data-testid="cloud-status">
          {t(`cloud.status.${status.status}` as I18nKey)}
          {status.cloudUrl ? ` · ${status.cloudUrl}` : ''}
          {status.status === 'paired' &&
            ` · ${t('cloud.lastSync', { time: fmtTime(status.lastSyncAtMs) })}`}
        </p>
      )}
      {done !== null && <p data-testid="cloud-paired-msg">{done}</p>}
      {status !== null && status.status !== 'paired' && (
        <form onSubmit={(e) => void pair(e)}>
          <p>{t('cloud.hint')}</p>
          <div className="pos-form-group">
            <label className="pos-form-label" htmlFor="cloud-url">
              {t('cloud.url')}
            </label>
            <input
              id="cloud-url"
              className="pos-input"
              data-testid="cloud-url-input"
              value={cloudUrl}
              onChange={(e) => setCloudUrl(e.target.value)}
              required
            />
          </div>
          <div className="pos-form-group">
            <label className="pos-form-label" htmlFor="cloud-code">
              {t('cloud.code')}
            </label>
            <input
              id="cloud-code"
              className="pos-input"
              data-testid="cloud-code-input"
              maxLength={8}
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              required
            />
          </div>
          <button
            type="submit"
            className="pos-btn pos-btn-primary"
            data-testid="cloud-pair-submit"
            disabled={busy}
          >
            {t('cloud.pair')}
          </button>
        </form>
      )}
      {status !== null && status.status === 'paired' && (
        <button
          type="button"
          className="pos-btn pos-btn-danger"
          data-testid="cloud-unpair-btn"
          disabled={busy}
          onClick={() => void unpair()}
        >
          {t('cloud.unpair')}
        </button>
      )}
    </section>
  );
}

/** Owner/manager on the main register: add a second register (code), list and revoke them. */
export function LanSection(props: {
  readonly api: HubApiClient;
  readonly onError: (err: unknown) => void;
}) {
  const { api, onError } = props;
  const [status, setStatus] = useState<LanStatus | null>(null);
  const [terminals, setTerminals] = useState<readonly LanTerminal[]>([]);
  const [code, setCode] = useState<LanPairingCode | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    Promise.all([api.getLanStatus(), api.listLanTerminals()]).then(([s, list]) => {
      setStatus(s);
      setTerminals(list);
    }, onError);
  }, [api, onError]);
  useEffect(load, [load]);

  const newCode = async () => {
    if (busy) return;
    setBusy(true);
    try {
      setCode(await api.createLanPairingCode());
      load();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (term: LanTerminal) => {
    if (busy || !window.confirm(t('lan.revokeConfirm', { name: term.name }))) return;
    setBusy(true);
    try {
      await api.revokeLanTerminal(term.id);
      load();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const port = code?.port ?? status?.port ?? DEFAULT_LAN_PORT;
  const addresses = code?.addresses ?? status?.addresses ?? [];

  return (
    <section data-testid="lan-section">
      <h4>{t('lan.title')}</h4>
      <p>{t('lan.hint')}</p>
      <button
        type="button"
        className="pos-btn pos-btn-primary"
        data-testid="lan-new-code-btn"
        disabled={busy}
        onClick={() => void newCode()}
      >
        {t('lan.addRegister')}
      </button>
      {code !== null && (
        <div className="pos-lan-code" data-testid="lan-code-box">
          <p>
            {t('lan.codeLabel')}{' '}
            <strong className="pos-lan-code-value" data-testid="lan-code-value">
              {code.code}
            </strong>{' '}
            · {t('lan.codeExpires', { time: fmtTime(code.expiresAtMs) })}
          </p>
          <p data-testid="lan-code-address">
            {t('lan.addressLabel')}{' '}
            {addresses.length > 0
              ? addresses.map((a) => `${a}:${String(port)}`).join(', ')
              : t('lan.noAddress')}
          </p>
          <p>{t('lan.fingerprintLabel')}</p>
          <Fingerprint value={code.fingerprint256} testId="lan-code-fingerprint" />
          <p>{t('lan.firewallHint')}</p>
        </div>
      )}
      <table className="pos-cart-table" data-testid="lan-terminals">
        <thead>
          <tr>
            <th>{t('lan.colName')}</th>
            <th>{t('lan.colStatus')}</th>
            <th>{t('lan.colLastSeen')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {terminals.length === 0 && (
            <tr>
              <td colSpan={4}>{t('lan.empty')}</td>
            </tr>
          )}
          {terminals.map((term) => (
            <tr key={term.id} data-testid={`lan-terminal-${term.id}`}>
              <td>{term.name}</td>
              <td>{t(term.status === 'active' ? 'lan.status.active' : 'lan.status.revoked')}</td>
              <td>{fmtTime(term.lastSeenAtMs)}</td>
              <td>
                {term.status === 'active' && (
                  <button
                    type="button"
                    className="pos-btn pos-btn-danger"
                    data-testid={`lan-revoke-${term.id}`}
                    disabled={busy}
                    onClick={() => void revoke(term)}
                  >
                    {t('lan.revoke')}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** Topbar "Ulanishlar": cloud (owner), LAN registers (owner/manager), or terminal-mode info. */
export function ConnectionsModal(props: {
  readonly api: HubApiClient;
  readonly role: string;
  readonly terminalInfo: TerminalInfo;
  readonly onClose: () => void;
  readonly onError: (err: unknown) => void;
}) {
  const { api, role, terminalInfo, onClose, onError } = props;
  return (
    <div className="pos-modal-backdrop" data-testid="connections-modal">
      <div className="pos-modal-card">
        <div className="pos-modal-header">
          <h3 className="pos-modal-title">{t('connections.title')}</h3>
          <button
            type="button"
            className="pos-btn"
            data-testid="connections-close"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        {terminalInfo.mode === 'terminal' ? (
          <TerminalModeSection info={terminalInfo} />
        ) : (
          <>
            {role === 'owner' && <CloudSection api={api} onError={onError} />}
            <LanSection api={api} onError={onError} />
          </>
        )}
      </div>
    </div>
  );
}
