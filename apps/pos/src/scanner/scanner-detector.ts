export interface ScannerKeyInput {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly timestampMs: number;
}

export interface ScannerDetectorConfig {
  /** Maximum allowed gap in milliseconds between consecutive characters in a scanner burst. Default: 30 ms. */
  readonly maxInterKeyMs: number;
  /** Minimum number of characters required before Enter/Tab to qualify as a barcode scan. Default: 4. */
  readonly minLength: number;
  /** Terminator keys that complete a scan burst. Default: ['Enter', 'Tab']. */
  readonly terminators: readonly ('Enter' | 'Tab')[];
}

export const DEFAULT_SCANNER_DETECTOR_CONFIG: ScannerDetectorConfig = {
  maxInterKeyMs: 30,
  minLength: 4,
  terminators: ['Enter', 'Tab'],
};

export interface ScannerDetectorState {
  readonly buffer: string;
  readonly startedAtMs: number | null;
  readonly lastKeyAtMs: number | null;
  readonly keyCount: number;
  readonly isBurstValid: boolean;
}

export const INITIAL_SCANNER_DETECTOR_STATE: ScannerDetectorState = {
  buffer: '',
  startedAtMs: null,
  lastKeyAtMs: null,
  keyCount: 0,
  isBurstValid: false,
};

export type ScannerStepOutcome =
  | {
      readonly type: 'ignored';
      readonly state: ScannerDetectorState;
    }
  | {
      readonly type: 'buffering';
      readonly char: string;
      readonly startedNewSequence: boolean;
      readonly state: ScannerDetectorState;
    }
  | {
      readonly type: 'flushed_as_typing';
      readonly state: ScannerDetectorState;
    }
  | {
      readonly type: 'scan_completed';
      readonly barcode: string;
      readonly durationMs: number;
      readonly state: ScannerDetectorState;
    };

const MODIFIER_ONLY_KEYS: ReadonlySet<string> = new Set([
  'Shift',
  'Control',
  'Alt',
  'AltGraph',
  'Meta',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'Dead',
  'Process',
  'Unidentified',
]);

/**
 * Normalizes a keyboard event into a single barcode character or GS (`\x1d`, ASCII 29) separator:
 * - Preserves raw `\x1d` / `\u001d` / `GroupSeparator` / `GS`
 * - Translates USB HID `Ctrl+]` (`ctrlKey: true` with `key: ']'`, `code: 'BracketRight'`, or `key: '\x1d'`) into `\x1d`
 * - Rejects other `ctrlKey`/`altKey`/`metaKey` shortcuts (`Ctrl+C`, `Alt+F4`, etc.)
 * - Accepts printable single-character keys (`length === 1`, code >= 32) without stripping or trimming.
 */
export function extractScannerCharacter(input: ScannerKeyInput): string | null {
  if (MODIFIER_ONLY_KEYS.has(input.key)) {
    return null;
  }

  // Direct GS character or named GroupSeparator key
  if (
    input.key === '\x1d' ||
    input.key === 'GroupSeparator' ||
    input.key === 'GS' ||
    input.code === 'GroupSeparator'
  ) {
    return '\x1d';
  }

  // USB HID scanners frequently emit ASCII 29 (GS) as Ctrl+] (BracketRight) or Ctrl+Shift+]
  if (
    input.ctrlKey &&
    !input.altKey &&
    !input.metaKey &&
    (input.key === ']' ||
      input.key === '\x1d' ||
      input.code === 'BracketRight' ||
      input.key === '\u001d')
  ) {
    return '\x1d';
  }

  if (input.ctrlKey || input.altKey || input.metaKey) {
    return null;
  }

  if (input.key.length === 1) {
    const code = input.key.charCodeAt(0);
    if (code === 0x1d) {
      return '\x1d';
    }
    if (code >= 0x20 && code !== 0x7f) {
      return input.key;
    }
  }

  return null;
}

/**
 * Pure, deterministic state-machine step for USB barcode/DataMatrix detection (`GEMINI.md` T1.11 c).
 * - Never calls `Date.now()` or touches DOM; all timestamps are passed via `input.timestampMs`.
 * - Never trims or strips `\x1d` (GS) or DataMatrix payload characters.
 * - Distinguishes fast human typing (`80–120 ms` inter-key gap) from hardware scanner bursts (`<= 30 ms`).
 */
export function stepScannerDetector(
  prevState: ScannerDetectorState,
  input: ScannerKeyInput,
  config: ScannerDetectorConfig = DEFAULT_SCANNER_DETECTOR_CONFIG,
): ScannerStepOutcome {
  // Ignore pure modifier keydown events (e.g. Shift before '(' or '+' in DataMatrix, or Control before ']')
  if (MODIFIER_ONLY_KEYS.has(input.key)) {
    return {
      type: 'ignored',
      state: prevState,
    };
  }

  const isTerminator = (config.terminators as readonly string[]).includes(input.key);
  if (isTerminator && !input.ctrlKey && !input.altKey && !input.metaKey) {
    if (
      prevState.lastKeyAtMs !== null &&
      prevState.startedAtMs !== null &&
      prevState.isBurstValid &&
      prevState.keyCount >= config.minLength &&
      prevState.buffer.length >= config.minLength
    ) {
      const gapToTerminator = input.timestampMs - prevState.lastKeyAtMs;
      if (gapToTerminator >= 0 && gapToTerminator <= config.maxInterKeyMs) {
        return {
          type: 'scan_completed',
          barcode: prevState.buffer,
          durationMs: input.timestampMs - prevState.startedAtMs,
          state: INITIAL_SCANNER_DETECTOR_STATE,
        };
      }
    }

    return {
      type: 'flushed_as_typing',
      state: INITIAL_SCANNER_DETECTOR_STATE,
    };
  }

  const char = extractScannerCharacter(input);
  if (char === null) {
    // Non-character navigation/function key (e.g., F2, Escape, ArrowDown, Backspace) resets buffer
    return {
      type: 'flushed_as_typing',
      state: INITIAL_SCANNER_DETECTOR_STATE,
    };
  }

  if (prevState.lastKeyAtMs === null || prevState.startedAtMs === null) {
    const nextState: ScannerDetectorState = {
      buffer: char,
      startedAtMs: input.timestampMs,
      lastKeyAtMs: input.timestampMs,
      keyCount: 1,
      isBurstValid: true,
    };
    return {
      type: 'buffering',
      char,
      startedNewSequence: true,
      state: nextState,
    };
  }

  const deltaMs = input.timestampMs - prevState.lastKeyAtMs;
  if (deltaMs >= 0 && deltaMs <= config.maxInterKeyMs && prevState.isBurstValid) {
    const nextState: ScannerDetectorState = {
      buffer: prevState.buffer + char,
      startedAtMs: prevState.startedAtMs,
      lastKeyAtMs: input.timestampMs,
      keyCount: prevState.keyCount + 1,
      isBurstValid: true,
    };
    return {
      type: 'buffering',
      char,
      startedNewSequence: false,
      state: nextState,
    };
  }

  // Gap exceeded maxInterKeyMs (human typing speed, or a new scan burst starting after prior human typing):
  // Start a fresh candidate sequence at this character!
  const restartedState: ScannerDetectorState = {
    buffer: char,
    startedAtMs: input.timestampMs,
    lastKeyAtMs: input.timestampMs,
    keyCount: 1,
    isBurstValid: true,
  };
  return {
    type: 'buffering',
    char,
    startedNewSequence: true,
    state: restartedState,
  };
}

/**
 * Restores the value of a focused text input if a scanner burst leaked characters into it,
 * preserving whatever the cashier had typed before the scanner burst started.
 */
export function computeRestoredInputValue(params: {
  readonly currentInputValue: string;
  readonly preBurstSnapshotValue: string | null;
  readonly scannedBarcode: string;
}): string {
  if (params.preBurstSnapshotValue !== null) {
    return params.preBurstSnapshotValue;
  }
  // Fallback if no snapshot: strip trailing printable portion of scannedBarcode
  const printableBarcode = params.scannedBarcode.replace(/\x1d/g, '');
  if (printableBarcode.length > 0 && params.currentInputValue.endsWith(printableBarcode)) {
    return params.currentInputValue.slice(
      0,
      params.currentInputValue.length - printableBarcode.length,
    );
  }
  return params.currentInputValue;
}
