import { t } from '@mezon/i18n';
import { formatMilliToQtyString, formatTiyinToSom } from '@mezon/ui';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePosStore } from '../store/pos-store.js';
import { createScanGate, type ScanResult } from '../utils/live-scan.js';
import { Icon } from './Icon.js';

type Flash =
  | { readonly kind: 'ok'; readonly text: string }
  | { readonly kind: 'missing'; readonly code: string; readonly text: string }
  | { readonly kind: 'error'; readonly text: string };

/** A short beep so the cashier hears each accepted scan without looking at the screen. */
function beep(ok: boolean): void {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = ok ? 1500 : 400;
    gain.gain.value = 0.08;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + (ok ? 0.08 : 0.25));
    osc.onended = () => void ctx.close();
  } catch {
    // no audio: the on-screen line is enough
  }
}

/**
 * C19 (phone): the camera stays open in the top part of the screen and adds every scanned item to
 * the cart; the cart list is visible below. "Finish" closes the camera and opens the payment.
 * The camera is drawn behind the WebView, so while this is open the rest of the app is hidden
 * (`html.pos-camera-live`) and only this overlay is painted.
 */
export function LiveScanOverlay({
  startLiveScan,
  onScan,
  onClose,
  onFinish,
  onLink,
  onError,
}: {
  readonly startLiveScan: (onCode: (code: string) => void) => Promise<() => Promise<void>>;
  readonly onScan: (code: string) => Promise<ScanResult>;
  readonly onClose: () => void;
  readonly onFinish: () => void;
  readonly onLink: ((code: string) => void) | null;
  readonly onError: (err: unknown) => void;
}) {
  const activeCart = usePosStore((s) => s.activeCart);
  const lines = activeCart?.lines ?? [];
  const [flash, setFlash] = useState<Flash | null>(null);
  // The camera is started once; the latest callbacks are read through a ref.
  const handlersRef = useRef({ onScan, onError, onClose });
  useEffect(() => {
    handlersRef.current = { onScan, onError, onClose };
  });

  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('pos-camera-live');
    const gate = createScanGate();
    // Scans are handled one after another: two codes in a row must not race on the cart.
    let queue: Promise<void> = Promise.resolve();
    let alive = true;
    let stop: (() => Promise<void>) | null = null;

    const onCode = (code: string) => {
      if (!gate(code, performance.now())) return;
      queue = queue.then(async () => {
        const res = await handlersRef.current.onScan(code);
        if (!alive) return;
        beep(res.ok);
        setFlash(
          res.ok
            ? { kind: 'ok', text: t('pos.live.added', { name: res.name }) }
            : res.notFound
              ? { kind: 'missing', code: res.code, text: res.message }
              : { kind: 'error', text: res.message },
        );
      });
    };

    startLiveScan(onCode).then(
      (stopFn) => {
        if (alive) stop = stopFn;
        else void stopFn();
      },
      (err: unknown) => {
        if (!alive) return;
        const message = err instanceof Error ? err.message : '';
        handlersRef.current.onError(
          message === 'CAMERA_PERMISSION_DENIED'
            ? new Error(t('pos.camera.permissionDenied'))
            : err,
        );
        handlersRef.current.onClose();
      },
    );

    return () => {
      alive = false;
      root.classList.remove('pos-camera-live');
      if (stop !== null) void stop();
    };
  }, [startLiveScan]);

  return createPortal(
    <div className="pos-live" data-testid="live-scan">
      <div className="pos-live-window">
        <div className="pos-live-top">
          <span className="pos-live-hint">{t('pos.live.hint')}</span>
          <button
            type="button"
            className="pos-btn pos-live-close"
            data-testid="live-scan-close"
            aria-label={t('common.close')}
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="pos-live-frame" aria-hidden="true" />
      </div>

      <div className="pos-live-panel">
        {flash !== null && (
          <div
            className={`pos-live-flash pos-live-flash-${flash.kind}`}
            data-testid="live-scan-flash"
          >
            <Icon name={flash.kind === 'ok' ? 'check' : 'info'} />
            <span>{flash.text}</span>
            {flash.kind === 'missing' && onLink !== null && (
              <button
                type="button"
                className="pos-btn pos-btn-primary"
                onClick={() => onLink(flash.code)}
              >
                <Icon name="link" />
                {t('pos.unknown.link')}
              </button>
            )}
          </div>
        )}

        <ul className="pos-live-lines" data-testid="live-scan-lines">
          {lines.length === 0 ? (
            <li className="pos-live-empty">{t('pos.live.empty')}</li>
          ) : (
            [...lines].reverse().map((line) => (
              <li key={line.id} className="pos-live-line">
                <span className="pos-live-line-name">{line.name}</span>
                <span className="pos-live-line-qty">
                  {formatMilliToQtyString(line.qty)} {t(`unit.${line.unit}`)}
                </span>
                <strong className="pos-live-line-sum">{formatTiyinToSom(line.finalTotal)}</strong>
              </li>
            ))
          )}
        </ul>

        <div className="pos-live-footer">
          <div className="pos-live-total">
            <span>{t('pos.totalPayable')}</span>
            <strong data-testid="live-scan-total">
              {formatTiyinToSom(activeCart?.totalFinal ?? '0')} {t('common.currency')}
            </strong>
          </div>
          <button
            type="button"
            className="pos-btn pos-btn-success pos-btn-xl"
            data-testid="live-scan-finish"
            disabled={lines.length === 0}
            onClick={onFinish}
          >
            <Icon name="wallet" />
            {t('pos.live.finish')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
