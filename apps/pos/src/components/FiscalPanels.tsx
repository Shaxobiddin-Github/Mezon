import type { FiscalDocDto, FiscalOfflineWarning } from '@mezon/contracts';
import { type I18nKey, t } from '@mezon/i18n';
import { useCallback, useEffect, useState } from 'react';
import type { HubApiClient } from '../api/hub-client.js';

function statusText(status: FiscalDocDto['status'] | null): string {
  return t(`fiscal.status.${status ?? 'none'}` as I18nKey);
}

const SETTLED = new Set(['confirmed', 'rejected', 'cancelled']);

/**
 * T3.3 receipt screen badge. The sale never waited for the driver (Variant A), so the badge polls
 * `GET /sales/:id/fiscal` briefly until the document settles.
 */
export function ReceiptFiscalBadge(props: { readonly api: HubApiClient; readonly saleId: string }) {
  const { api, saleId } = props;
  const [state, setState] = useState<{
    status: FiscalDocDto['status'] | null;
    test: boolean;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let polls = 0;
    let timer = 0;
    const load = () => {
      api
        .getSaleFiscal(saleId)
        .then((res) => {
          if (cancelled) return;
          const status = res.doc?.status ?? null;
          setState({ status, test: res.isTestDriver });
          polls += 1;
          if (status !== null && !SETTLED.has(status) && polls < 40) {
            timer = window.setTimeout(load, 3000);
          }
        })
        .catch(() => {
          // The badge is informational; the receipt itself is already valid.
        });
    };
    load();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [api, saleId]);

  if (state === null) return null;
  return (
    <div
      className="pos-totals-row"
      data-testid="receipt-fiscal-status"
      data-status={state.status ?? 'none'}
    >
      <span>{statusText(state.status)}</span>
      {state.test && state.status !== null && (
        <span className="pos-non-fiscal-badge" data-testid="receipt-fiscal-test-driver">
          {t('fiscal.testDriver')}
        </span>
      )}
    </div>
  );
}

/** T3.3 header warnings: offline deadline (oldest unsettled doc, S1) and shift not open on the driver (S4). */
export function FiscalOfflineBanner(props: { readonly api: HubApiClient }) {
  const { api } = props;
  const [warning, setWarning] = useState<FiscalOfflineWarning>('none');
  const [shiftNotOpen, setShiftNotOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      api
        .getFiscalStatus()
        .then((s) => {
          if (cancelled) return;
          setWarning(s.modeEnabled ? s.offlineWarning : 'none');
          setShiftNotOpen(s.modeEnabled && s.shiftNotOpenOnDriver);
        })
        .catch(() => undefined);
    };
    load();
    const id = window.setInterval(load, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [api]);

  return (
    <>
      {warning !== 'none' && (
        <div
          className="pos-error-banner"
          role="alert"
          data-testid="fiscal-offline-warning"
          data-level={warning}
        >
          {t(warning === 'expired' ? 'fiscal.offline.expired' : 'fiscal.offline.approaching')}
        </div>
      )}
      {shiftNotOpen && (
        <div className="pos-error-banner" role="status" data-testid="fiscal-shift-not-open-warning">
          {t('fiscal.shiftNotOpen')}
        </div>
      )}
    </>
  );
}

function remaining(deadlineMs: string, nowMs: number): string {
  const left = Number(deadlineMs) - nowMs;
  if (left <= 0) return t('fiscal.unsettled.overdue');
  const h = Math.floor(left / 3_600_000);
  const m = Math.floor((left % 3_600_000) / 60_000);
  return t('fiscal.unsettled.hours', { h, m });
}

/** T3.3 manager/owner screen: unsettled documents, time to the offline deadline, retry. */
export function FiscalUnsettledModal(props: {
  readonly api: HubApiClient;
  readonly onClose: () => void;
  readonly onError: (err: unknown) => void;
}) {
  const { api, onClose, onError } = props;
  const [docs, setDocs] = useState<readonly FiscalDocDto[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api.listUnsettledFiscalDocs().then(setDocs).catch(onError);
  }, [api, onError]);

  useEffect(() => {
    load();
  }, [load]);

  const retry = async (id: string) => {
    if (busy !== null) return; // one request at a time; the hub only re-queues anyway
    setBusy(id);
    try {
      await api.retryFiscalDoc(id);
      load();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(null);
    }
  };

  const now = Date.now();
  return (
    <div className="pos-modal-backdrop" data-testid="fiscal-unsettled-modal">
      <div className="pos-modal-card">
        <div className="pos-modal-header">
          <h3 className="pos-modal-title">{t('fiscal.unsettled.title')}</h3>
          <button
            type="button"
            className="pos-btn"
            data-testid="fiscal-unsettled-close"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        {docs !== null && docs.length === 0 && (
          <p data-testid="fiscal-unsettled-empty">{t('fiscal.unsettled.empty')}</p>
        )}
        {docs !== null && docs.length > 0 && (
          <table className="pos-cart-table">
            <thead>
              <tr>
                <th>{t('fiscal.unsettled.colReceipt')}</th>
                <th>{t('fiscal.unsettled.colKind')}</th>
                <th>{t('fiscal.unsettled.colStatus')}</th>
                <th>{t('fiscal.unsettled.colDeadline')}</th>
                <th>{t('fiscal.unsettled.colError')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id} data-testid={`fiscal-doc-${d.id}`} data-status={d.status}>
                  <td>{d.receiptCode ?? '—'}</td>
                  <td>{t(`fiscal.kind.${d.docKind}` as I18nKey)}</td>
                  <td>{statusText(d.status)}</td>
                  <td>{remaining(d.offlineDeadlineMs, now)}</td>
                  <td>{d.lastErrorMessage ?? ''}</td>
                  <td>
                    {d.status === 'failed' && (
                      <button
                        type="button"
                        className="pos-btn"
                        data-testid={`fiscal-retry-${d.id}`}
                        disabled={busy !== null}
                        onClick={() => void retry(d.id)}
                      >
                        {t('fiscal.unsettled.retry')}
                      </button>
                    )}
                    {d.status === 'rejected' && <small>{t('fiscal.unsettled.rejectedHint')}</small>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
