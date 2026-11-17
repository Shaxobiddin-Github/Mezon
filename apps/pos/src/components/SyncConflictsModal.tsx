import type { CloudParkedEventDto, SyncConflictDto } from '@mezon/contracts';
import { type I18nKey, t } from '@mezon/i18n';
import { useCallback, useEffect, useState } from 'react';
import type { HubApiClient } from '../api/hub-client.js';

const KNOWN_REASONS = new Set([
  'CUSTOMER_OVERPAID',
  'PROJECTION_FAILED',
  'FACT_CONTENT_HASH_MISMATCH',
  'DEPENDENCY_UNRESOLVED',
]);

export function syncReasonLabel(reason: string): string {
  return KNOWN_REASONS.has(reason)
    ? t(`sync.reason.${reason}` as I18nKey)
    : `${t('sync.reason.other')} (${reason})`;
}

/**
 * T2.6 manager screen: open sync conflicts. The only actions are the ones the hub allows for each
 * conflict — retry or acknowledge — with an optional note for the audit trail. Data is never edited
 * here.
 */
export function SyncConflictsModal(props: {
  readonly api: HubApiClient;
  readonly onClose: () => void;
  readonly onError: (err: unknown) => void;
}) {
  const { api, onClose, onError } = props;
  const [items, setItems] = useState<readonly SyncConflictDto[] | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [cloud, setCloud] = useState<readonly CloudParkedEventDto[] | null>(null);

  const load = useCallback(() => {
    api.listSyncConflicts().then(setItems).catch(onError);
    // The cloud part is best-effort: offline or unpaired simply hides it.
    api
      .listCloudParked()
      .then(setCloud)
      .catch(() => setCloud(null));
  }, [api, onError]);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (id: string, action: 'retry' | 'acknowledge') => {
    if (busy !== null) return;
    setBusy(id);
    setFailed(null);
    try {
      const res = await api.resolveSyncConflict(id, action, notes[id] ?? '');
      if (action === 'retry' && !res.applied) setFailed(id);
      load();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(null);
    }
  };

  const actCloud = async (id: string, action: 'retry' | 'acknowledge') => {
    if (busy !== null) return;
    setBusy(id);
    try {
      await api.resolveCloudParked(id, action, notes[id] ?? '');
      load();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="pos-modal-backdrop" data-testid="sync-conflicts-modal">
      <div className="pos-modal-card">
        <div className="pos-modal-header">
          <h3 className="pos-modal-title">{t('sync.conflicts.title')}</h3>
          <button
            type="button"
            className="pos-btn"
            data-testid="sync-conflicts-close"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <p>{t('sync.conflicts.noEdit')}</p>
        {items !== null && items.length === 0 && (
          <p data-testid="sync-conflicts-empty">{t('sync.conflicts.empty')}</p>
        )}
        {items !== null && items.length > 0 && (
          <table className="pos-cart-table">
            <thead>
              <tr>
                <th>{t('sync.conflicts.colWhen')}</th>
                <th>{t('sync.conflicts.colReason')}</th>
                <th>{t('sync.conflicts.colEntity')}</th>
                <th>{t('sync.conflicts.colError')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id} data-testid={`sync-conflict-${c.id}`}>
                  <td>{new Date(Number(c.createdAtMs)).toLocaleString()}</td>
                  <td>{syncReasonLabel(c.reason)}</td>
                  <td>{c.entity}</td>
                  <td>
                    {c.error ?? ''}
                    {failed === c.id && <div>{t('sync.conflicts.retryFailed')}</div>}
                  </td>
                  <td>
                    <input
                      className="pos-input"
                      placeholder={t('sync.conflicts.notePlaceholder')}
                      maxLength={500}
                      value={notes[c.id] ?? ''}
                      onChange={(e) => setNotes({ ...notes, [c.id]: e.target.value })}
                    />
                    {c.allowedActions.includes('retry') && (
                      <button
                        type="button"
                        className="pos-btn"
                        data-testid={`sync-conflict-retry-${c.id}`}
                        disabled={busy !== null}
                        onClick={() => void act(c.id, 'retry')}
                      >
                        {t('sync.conflicts.retry')}
                      </button>
                    )}
                    {c.allowedActions.includes('acknowledge') && (
                      <button
                        type="button"
                        className="pos-btn"
                        data-testid={`sync-conflict-ack-${c.id}`}
                        disabled={busy !== null}
                        onClick={() => void act(c.id, 'acknowledge')}
                      >
                        {t('sync.conflicts.acknowledge')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {cloud !== null && cloud.length > 0 && (
          <>
            <h4>{t('sync.cloudParked.title')}</h4>
            <table className="pos-cart-table" data-testid="sync-cloud-parked">
              <tbody>
                {cloud.map((p) => (
                  <tr key={p.id} data-testid={`sync-cloud-parked-${p.id}`}>
                    <td>{new Date(Number(p.createdAtMs)).toLocaleString()}</td>
                    <td>{p.entity}</td>
                    <td>
                      {t('sync.cloudParked.waitingFor', { entity: p.missingRefEntity })} ·{' '}
                      {p.attempts}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="pos-btn"
                        disabled={busy !== null}
                        onClick={() => void actCloud(p.id, 'retry')}
                      >
                        {t('sync.conflicts.retry')}
                      </button>
                      <button
                        type="button"
                        className="pos-btn"
                        disabled={busy !== null}
                        onClick={() => void actCloud(p.id, 'acknowledge')}
                      >
                        {t('sync.conflicts.acknowledge')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}
