import { useEffect, useState } from 'react';
import { t } from '@mezon/i18n';
import type { UpdateBridgeState, UpdateChoice } from '../bridge.js';

export interface UpdateBannerView {
  readonly text: string;
  /** Choices the cashier can make now (only when nothing is scheduled yet). */
  readonly choices: readonly ('now' | 'shift_close' | 'tonight')[];
  readonly canCancel: boolean;
}

function formatClock(ms: string): string {
  const d = new Date(Number(ms));
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** The next 22:00 local time after `nowMs` (today, or tomorrow when 22:00 has passed). */
export function nextEveningMs(nowMs: number, hour = 22): number {
  const d = new Date(nowMs);
  d.setHours(hour, 0, 0, 0);
  if (d.getTime() <= nowMs) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/**
 * T4.8: what the cashier sees about an application update. The update is never installed during
 * a receipt; the cashier picks when (now, when the shift is closed, or this evening).
 */
export function updateBannerView(s: UpdateBridgeState | null): UpdateBannerView | null {
  if (!s || s.version === null) {
    return s?.phase === 'error'
      ? { text: t('pos.update.error'), choices: [], canCancel: false }
      : null;
  }
  const version = s.version;
  if (s.phase === 'installing') {
    return { text: t('pos.update.installing'), choices: [], canCancel: false };
  }
  if (s.schedule === null) {
    return {
      text: t('pos.update.ready', { version }),
      choices: ['now', 'shift_close', 'tonight'],
      canCancel: false,
    };
  }
  let text: string;
  switch (s.waitReason) {
    case 'open_receipt':
      text = t('pos.update.waiting.open_receipt', { version });
      break;
    case 'open_shift':
      text = t('pos.update.waiting.open_shift', { version });
      break;
    case 'hub_unavailable':
      text = t('pos.update.waiting.hub_unavailable', { version });
      break;
    case 'not_yet':
      text = t('pos.update.waiting.not_yet', {
        version,
        time: s.schedule.kind === 'at' ? formatClock(s.schedule.atMs) : '',
      });
      break;
    default:
      text = t('pos.update.waiting.pending', { version });
  }
  return { text, choices: [], canCancel: true };
}

export function UpdateBanner() {
  const bridge = typeof window === 'undefined' ? undefined : window.mezonBridge;
  const [state, setState] = useState<UpdateBridgeState | null>(null);

  useEffect(() => {
    if (!bridge?.getUpdateState || !bridge.onUpdateState) return undefined;
    let cancelled = false;
    bridge
      .getUpdateState()
      .then((s) => {
        if (!cancelled) setState(s);
      })
      .catch(() => undefined);
    const off = bridge.onUpdateState((s) => setState(s));
    return () => {
      cancelled = true;
      off();
    };
  }, [bridge]);

  const view = updateBannerView(state);
  if (!view || !bridge) return null;
  const choose = (c: 'now' | 'shift_close' | 'tonight') => {
    const choice: UpdateChoice =
      c === 'tonight' ? { kind: 'at', atMs: String(nextEveningMs(Date.now())) } : { kind: c };
    void bridge.scheduleUpdate?.(choice);
  };
  const label = {
    now: 'pos.update.now',
    shift_close: 'pos.update.shiftClose',
    tonight: 'pos.update.tonight',
  } as const;
  return (
    <div className="pos-error-banner" role="status" data-testid="update-banner">
      <span>{view.text}</span>
      {view.choices.map((c) => (
        <button key={c} type="button" className="pos-btn-secondary" onClick={() => choose(c)}>
          {t(label[c])}
        </button>
      ))}
      {view.canCancel && (
        <button
          type="button"
          className="pos-btn-secondary"
          onClick={() => void bridge.cancelUpdate?.()}
        >
          {t('pos.update.cancel')}
        </button>
      )}
    </div>
  );
}
