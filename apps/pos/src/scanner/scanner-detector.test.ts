import { describe, expect, it } from 'vitest';
import {
  INITIAL_SCANNER_DETECTOR_STATE,
  type ScannerKeyInput,
  computeRestoredInputValue,
  stepScannerDetector,
} from './scanner-detector.js';

function feedSequence(events: readonly ScannerKeyInput[]) {
  let state = INITIAL_SCANNER_DETECTOR_STATE;
  let preBurstInputSnapshot: string | null = null;
  let simulatedInputText = '';
  const completedScans: string[] = [];

  for (const ev of events) {
    const prevValueBeforeKey = simulatedInputText;
    const outcome = stepScannerDetector(state, ev);
    state = outcome.state;

    if (outcome.type === 'buffering') {
      if (outcome.startedNewSequence) {
        preBurstInputSnapshot = prevValueBeforeKey;
      }
      if (outcome.char !== '\x1d') {
        simulatedInputText += outcome.char;
      }
    } else if (outcome.type === 'scan_completed') {
      completedScans.push(outcome.barcode);
      simulatedInputText = computeRestoredInputValue({
        currentInputValue: simulatedInputText,
        preBurstSnapshotValue: preBurstInputSnapshot,
        scannedBarcode: outcome.barcode,
      });
      preBurstInputSnapshot = null;
    } else if (outcome.type === 'flushed_as_typing') {
      preBurstInputSnapshot = null;
    }
  }

  return {
    state,
    completedScans,
    simulatedInputText,
  };
}

describe('@mezon/pos scanner-detector pure state machine (T1.11 c)', () => {
  it('rejects fast human typist (80–120 ms inter-key interval) and never triggers scan_completed', () => {
    const code = '4780000000012';
    let t = 1_000;
    const intervals = [85, 95, 110, 80, 120, 90, 100, 88, 105, 92, 115, 84, 96];
    const events: ScannerKeyInput[] = [];

    for (let i = 0; i < code.length; i += 1) {
      const ch = code.charAt(i);
      events.push({
        key: ch,
        code: `Digit${ch}`,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        timestampMs: t,
      });
      t += intervals[i] ?? 90;
    }
    events.push({
      key: 'Enter',
      code: 'Enter',
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      timestampMs: t,
    });

    const res = feedSequence(events);
    expect(res.completedScans).toEqual([]);
    expect(res.simulatedInputText).toBe(code);
  });

  it('captures hardware USB scanner burst (5–15 ms interval) and completes on Enter or Tab', () => {
    const ean13 = '4780000000012';
    let t = 5_000;
    const events: ScannerKeyInput[] = [];

    for (const ch of ean13) {
      events.push({
        key: ch,
        code: `Digit${ch}`,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        timestampMs: t,
      });
      t += 8;
    }
    events.push({
      key: 'Enter',
      code: 'Enter',
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      timestampMs: t,
    });

    const res = feedSequence(events);
    expect(res.completedScans).toEqual([ean13]);
    expect(res.simulatedInputText).toBe('');
  });

  it('preserves GS (\\x1D) and DataMatrix marking codes intact via direct \\x1D, GroupSeparator, and Ctrl+]', () => {
    const part1 = '010478000000001221ABC12345';
    const part2 = '91EE06';
    const part3 = '92dGVzdA==';
    const expectedFullCode = `${part1}\x1d${part2}\x1d${part3}`;

    let t = 10_000;
    const events: ScannerKeyInput[] = [];

    const pushChars = (str: string) => {
      for (const ch of str) {
        if (ch >= 'A' && ch <= 'Z') {
          events.push({
            key: 'Shift',
            code: 'ShiftLeft',
            ctrlKey: false,
            altKey: false,
            metaKey: false,
            timestampMs: t,
          });
          t += 2;
        }
        events.push({
          key: ch,
          code: `Key${ch}`,
          ctrlKey: false,
          altKey: false,
          metaKey: false,
          timestampMs: t,
        });
        t += 6;
      }
    };

    pushChars(part1);
    // First GS emitted as raw \x1d
    events.push({
      key: '\x1d',
      code: 'BracketRight',
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      timestampMs: t,
    });
    t += 6;
    pushChars(part2);
    // Second GS emitted as Control + ']' (Ctrl+])
    events.push({
      key: 'Control',
      code: 'ControlLeft',
      ctrlKey: true,
      altKey: false,
      metaKey: false,
      timestampMs: t,
    });
    t += 2;
    events.push({
      key: ']',
      code: 'BracketRight',
      ctrlKey: true,
      altKey: false,
      metaKey: false,
      timestampMs: t,
    });
    t += 6;
    pushChars(part3);
    events.push({
      key: 'Enter',
      code: 'Enter',
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      timestampMs: t,
    });

    const res = feedSequence(events);
    expect(res.completedScans).toEqual([expectedFullCode]);
    expect(res.completedScans[0]?.includes('\x1d')).toBe(true);
    expect(res.simulatedInputText).toBe('');
  });

  it('mixed human typing in search box ("shakar") followed immediately by USB scan keeps "shakar" intact and routes barcode to cart', () => {
    const events: ScannerKeyInput[] = [];
    let t = 20_000;

    for (const ch of 'shakar') {
      events.push({
        key: ch,
        code: `Key${ch.toUpperCase()}`,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        timestampMs: t,
      });
      t += 95; // human typing speed (95 ms)
    }

    // 250ms later, cashier pulls trigger on USB scanner while focus is still inside search input
    t += 250;
    const barcode = '4780012345671';
    for (const ch of barcode) {
      events.push({
        key: ch,
        code: `Digit${ch}`,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        timestampMs: t,
      });
      t += 7; // scanner burst (7 ms)
    }
    events.push({
      key: 'Enter',
      code: 'Enter',
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      timestampMs: t,
    });

    const res = feedSequence(events);
    expect(res.completedScans).toEqual([barcode]);
    expect(res.simulatedInputText).toBe('shakar');
  });

  it('rejects short bursts (< minLength, e.g. 2 or 3 fast keys + Enter from keyboard rollover or quick "+1" Enter) as non-scans', () => {
    const events2Chars: ScannerKeyInput[] = [
      {
        key: '+',
        code: 'Equal',
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        timestampMs: 1_000,
      },
      {
        key: '1',
        code: 'Digit1',
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        timestampMs: 1_005,
      },
      {
        key: 'Enter',
        code: 'Enter',
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        timestampMs: 1_010,
      },
    ];
    const res2 = feedSequence(events2Chars);
    expect(res2.completedScans).toEqual([]);
    expect(res2.simulatedInputText).toBe('+1');

    const events3Chars: ScannerKeyInput[] = [
      {
        key: '1',
        code: 'Digit1',
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        timestampMs: 2_000,
      },
      {
        key: '2',
        code: 'Digit2',
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        timestampMs: 2_004,
      },
      {
        key: '3',
        code: 'Digit3',
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        timestampMs: 2_008,
      },
      {
        key: 'Enter',
        code: 'Enter',
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        timestampMs: 2_012,
      },
    ];
    const res3 = feedSequence(events3Chars);
    expect(res3.completedScans).toEqual([]);
    expect(res3.simulatedInputText).toBe('123');
  });

  it('rejects fast 13-character burst when terminator Enter is delayed (> maxInterKeyMs, e.g. 500 ms later)', () => {
    const barcode = '4780012345671';
    const events: ScannerKeyInput[] = [];
    let t = 5_000;
    for (const ch of barcode) {
      events.push({
        key: ch,
        code: `Digit${ch}`,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        timestampMs: t,
      });
      t += 7; // fast 7ms burst across all 13 digits
    }
    // Wait 500ms before pressing Enter (human paused to think before hitting Enter)
    t += 500;
    events.push({
      key: 'Enter',
      code: 'Enter',
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      timestampMs: t,
    });

    const res = feedSequence(events);
    expect(res.completedScans).toEqual([]);
    expect(res.simulatedInputText).toBe(barcode);
  });
});
