import type { PaymentIntentDto } from '@mezon/contracts';
import { t } from '@mezon/i18n';
import { formatTiyinToSom } from '@mezon/ui';
import qrcode from 'qrcode-generator';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HubApiClient } from '../api/hub-client.js';

/** QR text → an SVG picture (one path, no HTML injection). */
export function QrImage({ text, size = 220 }: { readonly text: string; readonly size?: number }) {
  const { d, n } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    let path = '';
    for (let r = 0; r < count; r += 1) {
      for (let c = 0; c < count; c += 1) {
        if (qr.isDark(r, c)) path += `M${String(c)} ${String(r)}h1v1h-1z`;
      }
    }
    return { d: path, n: count };
  }, [text]);
  return (
    <svg
      className="pos-qr-image"
      width={size}
      height={size}
      viewBox={`-2 -2 ${String(n + 4)} ${String(n + 4)}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={t('payment.qr.title')}
      data-testid="qr-image"
    >
      <rect x={-2} y={-2} width={n + 4} height={n + 4} fill="#fff" />
      <path d={d} fill="#0f172a" />
    </svg>
  );
}

type QrState =
  | { readonly kind: 'creating' }
  | { readonly kind: 'waiting'; readonly intent: PaymentIntentDto }
  | { readonly kind: 'closed'; readonly intent: PaymentIntentDto }
  | { readonly kind: 'error'; readonly message: string };

const POLL_MS = 2000;

/**
 * V2 UzQR at the till: one dynamic QR for the amount, the hub asks the provider every 2 s, and the
 * receipt row is added only when the hub says `paid` (the hub enforces it again at completeSale).
 * With the test provider (demo mode) the screen says SINOV and offers "customer paid (demo)".
 */
export function QrPayPanel(props: {
  readonly api: HubApiClient;
  readonly cartId: string;
  readonly amountTiyin: string;
  readonly onPaid: (intent: PaymentIntentDto) => void;
  readonly onClose: () => void;
  readonly onError: (err: unknown) => void;
}) {
  const { api, cartId, amountTiyin, onPaid, onClose, onError } = props;
  const [state, setState] = useState<QrState>({ kind: 'creating' });
  const [nowMs, setNowMs] = useState(() => Date.now());
  const paidSent = useRef(false);

  const create = useCallback(async () => {
    setState({ kind: 'creating' });
    try {
      const intent = await api.createPaymentIntent(cartId, amountTiyin);
      setState({ kind: 'waiting', intent });
    } catch (err) {
      setState({ kind: 'error', message: t('payment.qr.createFailed') });
      onError(err);
    }
  }, [api, cartId, amountTiyin, onError]);

  useEffect(() => {
    void create();
  }, [create]);

  const apply = useCallback(
    (intent: PaymentIntentDto) => {
      if (intent.status === 'paid' && intent.consumedBySaleId === null) {
        if (!paidSent.current) {
          paidSent.current = true;
          onPaid(intent);
        }
        return;
      }
      setState(
        intent.status === 'pending' ? { kind: 'waiting', intent } : { kind: 'closed', intent },
      );
    },
    [onPaid],
  );

  const waitingId = state.kind === 'waiting' ? state.intent.id : null;
  useEffect(() => {
    if (waitingId === null) return undefined;
    const timer = setInterval(() => {
      setNowMs(Date.now());
      void api.refreshPaymentIntent(waitingId).then(apply, () => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [api, waitingId, apply]);

  const cancel = async () => {
    if (state.kind === 'waiting') {
      try {
        const intent = await api.cancelPaymentIntent(state.intent.id);
        // A payment that landed meanwhile is never lost: the hub turns it into paid (late).
        if (intent.status === 'paid') {
          apply(intent);
          return;
        }
      } catch {
        // already paid / expired: the refresh below tells the truth
        const fresh = await api.refreshPaymentIntent(state.intent.id).catch(() => null);
        if (fresh?.status === 'paid') {
          apply(fresh);
          return;
        }
      }
    }
    onClose();
  };

  const demoPay = async () => {
    if (state.kind !== 'waiting') return;
    try {
      apply(await api.demoPayPaymentIntent(state.intent.id));
    } catch (err) {
      onError(err);
    }
  };

  const intent = state.kind === 'waiting' || state.kind === 'closed' ? state.intent : null;
  const secondsLeft =
    state.kind === 'waiting'
      ? Math.max(0, Math.ceil((Number(state.intent.expiresAtMs) - nowMs) / 1000))
      : 0;

  return (
    <div className="pos-qr-panel" data-testid="qr-pay-panel">
      <div className="pos-qr-head">
        <strong>{t('payment.qr.title')}</strong>
        <span className="pos-qr-amount">
          {formatTiyinToSom(amountTiyin)} {t('common.currency')}
        </span>
      </div>

      {intent?.isTestDriver && (
        <div className="pos-qr-test" data-testid="qr-test-banner">
          {t('payment.qr.testBanner')}
        </div>
      )}

      {state.kind === 'creating' && <p className="pos-qr-hint">{t('payment.qr.creating')}</p>}
      {state.kind === 'error' && <p className="pos-qr-hint pos-qr-bad">{state.message}</p>}

      {state.kind === 'waiting' && state.intent.qrPayload !== null && (
        <>
          <QrImage text={state.intent.qrPayload} />
          <p className="pos-qr-hint">{t('payment.qr.waiting')}</p>
          <p className="pos-qr-timer" data-testid="qr-seconds-left">
            {t('payment.qr.secondsLeft', { seconds: String(secondsLeft) })}
          </p>
        </>
      )}

      {state.kind === 'closed' && (
        <p className="pos-qr-hint pos-qr-bad" data-testid="qr-closed">
          {state.intent.status === 'expired'
            ? t('payment.qr.expired')
            : state.intent.status === 'amount_mismatch'
              ? t('payment.qr.mismatch')
              : t('payment.qr.failed')}
        </p>
      )}

      <div className="pos-qr-actions">
        {state.kind === 'waiting' && state.intent.demoPayAllowed && (
          <button
            type="button"
            className="pos-btn pos-btn-success"
            data-testid="qr-demo-pay-btn"
            onClick={() => void demoPay()}
          >
            {t('payment.qr.demoPay')}
          </button>
        )}
        {(state.kind === 'closed' || state.kind === 'error') && (
          <button
            type="button"
            className="pos-btn pos-btn-primary"
            data-testid="qr-new-btn"
            onClick={() => void create()}
          >
            {t('payment.qr.newQr')}
          </button>
        )}
        <button
          type="button"
          className="pos-btn"
          data-testid="qr-cancel-btn"
          onClick={() => void cancel()}
        >
          {t('payment.qr.cancel')}
        </button>
      </div>
    </div>
  );
}
