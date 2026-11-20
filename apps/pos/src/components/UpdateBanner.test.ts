import { setLocale } from '@mezon/i18n';
import { afterEach, describe, expect, it } from 'vitest';
import type { UpdateBridgeState } from '../bridge.js';
import { nextEveningMs, updateBannerView } from './UpdateBanner.js';

const base: UpdateBridgeState = {
  phase: 'ready',
  currentVersion: '1.2.0',
  version: '1.3.0',
  notes: null,
  schedule: null,
  waitReason: null,
  error: null,
};

describe('@mezon/pos - update banner (T4.8)', () => {
  afterEach(() => setLocale('uz-Latn'));

  it('silent when there is no update; offers the three choices when one is ready', () => {
    expect(updateBannerView(null)).toBeNull();
    expect(updateBannerView({ ...base, phase: 'idle', version: null })).toBeNull();
    expect(updateBannerView({ ...base, phase: 'disabled', version: null })).toBeNull();
    const ready = updateBannerView(base);
    expect(ready?.text).toContain('1.3.0');
    expect(ready?.choices).toEqual(['now', 'shift_close', 'tonight']);
    expect(ready?.canCancel).toBe(false);
  });

  it('explains why it is waiting; a scheduled update can be cancelled', () => {
    const waiting = updateBannerView({
      ...base,
      phase: 'waiting',
      schedule: { kind: 'now' },
      waitReason: 'open_receipt',
    });
    expect(waiting?.text).toContain('Chek buzilmaydi');
    expect(waiting?.choices).toEqual([]);
    expect(waiting?.canCancel).toBe(true);
    const at = new Date(2026, 10, 18, 22, 0, 0, 0).getTime();
    expect(
      updateBannerView({
        ...base,
        phase: 'waiting',
        schedule: { kind: 'at', atMs: String(at) },
        waitReason: 'not_yet',
      })?.text,
    ).toContain('22:00');
    const installing = updateBannerView({
      ...base,
      phase: 'installing',
      schedule: { kind: 'now' },
    });
    expect(installing?.text).toContain("o'rnatilmoqda");
    expect(installing?.choices).toEqual([]);
    expect(installing?.canCancel).toBe(false);
    setLocale('ru');
    expect(
      updateBannerView({
        ...base,
        phase: 'waiting',
        schedule: { kind: 'shift_close' },
        waitReason: 'open_shift',
      })?.text,
    ).toContain('закрытия смены');
  });

  it('"this evening" is today 22:00, or tomorrow once 22:00 has passed', () => {
    const morning = new Date(2026, 10, 18, 9, 30).getTime();
    expect(new Date(nextEveningMs(morning)).getDate()).toBe(18);
    expect(new Date(nextEveningMs(morning)).getHours()).toBe(22);
    const late = new Date(2026, 10, 18, 22, 15).getTime();
    expect(new Date(nextEveningMs(late)).getDate()).toBe(19);
  });
});
