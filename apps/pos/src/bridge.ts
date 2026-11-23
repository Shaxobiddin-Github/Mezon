export interface HubBridgeState {
  readonly baseUrl: string | null;
  readonly restartCount: number;
  readonly status: 'starting' | 'ready' | 'restarting' | 'error';
  readonly lastError?: string;
}

/** T4.8: application update state from the desktop shell (`apps/desktop/src/update`). */
export interface UpdateBridgeState {
  readonly phase:
    'disabled' | 'idle' | 'downloading' | 'ready' | 'waiting' | 'installing' | 'error';
  readonly currentVersion: string;
  readonly version: string | null;
  readonly notes: string | null;
  readonly schedule:
    | { readonly kind: 'now' }
    | { readonly kind: 'shift_close' }
    | { readonly kind: 'at'; readonly atMs: string }
    | null;
  readonly waitReason: 'not_yet' | 'hub_unavailable' | 'open_receipt' | 'open_shift' | null;
  readonly error: string | null;
}

export type UpdateChoice = NonNullable<UpdateBridgeState['schedule']>;
/** v1 LAN terminal mode, as the desktop main process reports it (never the terminal key). */
export type TerminalInfo =
  | { readonly mode: 'hub' }
  | {
      readonly mode: 'terminal';
      readonly terminalName: string;
      readonly hubHost: string;
      readonly hubPort: number;
      readonly fingerprint256: string;
      readonly pairedAtMs: number;
    };

export type TerminalPairResult =
  | { readonly ok: true; readonly fingerprint256: string }
  | {
      readonly ok: false;
      readonly code:
        | 'INVALID_INPUT'
        | 'ALREADY_TERMINAL'
        | 'LOCAL_DATA_EXISTS'
        | 'LOCAL_HUB_NOT_READY'
        | 'PAIRING_REJECTED'
        | 'HUB_UNREACHABLE';
    };

export interface MezonBridge {
  getHubState(): Promise<HubBridgeState>;
  onHubState(listener: (state: HubBridgeState) => void): () => void;
  /** Present only in the desktop shell (not in the browser / web kassa). */
  getUpdateState?(): Promise<UpdateBridgeState>;
  scheduleUpdate?(choice: UpdateChoice): Promise<boolean>;
  cancelUpdate?(): Promise<void>;
  onUpdateState?(listener: (state: UpdateBridgeState) => void): () => void;
  /** Desktop only (absent in the browser dev build). */
  getTerminalInfo?(): Promise<TerminalInfo>;
  pairAsTerminal?(input: {
    host: string;
    port: number;
    code: string;
    terminalName: string;
  }): Promise<TerminalPairResult>;
  leaveTerminal?(): Promise<{ readonly ok: boolean }>;
  relaunchApp?(): Promise<void>;
  /**
   * Thin client (Android phone/tablet shell): there is no local hub, so until the device is paired
   * as a LAN terminal the POS shows only the pairing form.
   */
  readonly thinClient?: boolean;
  /** Camera barcode scan (Android shell). Resolves `null` when the cashier cancels. */
  readonly scanBarcode?: () => Promise<string | null>;
}

/** Fingerprint shown in groups of 4 so two screens can be compared by eye. */
export function formatFingerprint(fp: string): string {
  const hex = fp.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  return (hex.match(/.{1,4}/g) ?? []).join(' ');
}

export interface HealthPayload {
  readonly status: string;
  readonly needsSetup: boolean;
}

declare global {
  interface Window {
    mezonBridge?: MezonBridge;
    __MEZON_HUB_URL__?: string;
  }
}

export function normalizeLoopbackHubBaseUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.port === '') {
    throw new Error(`Invalid hub baseUrl: ${baseUrl}`);
  }
  return `http://127.0.0.1:${parsed.port}`;
}

export function buildHubHealthUrl(baseUrl: string): string {
  const canonical = normalizeLoopbackHubBaseUrl(baseUrl);
  return new URL('/health', canonical).toString();
}

export function parseHealthPayload(raw: unknown): HealthPayload {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Health response must be a JSON object');
  }
  const record = raw as Record<string, unknown>;
  if (typeof record['status'] !== 'string' || typeof record['needsSetup'] !== 'boolean') {
    throw new Error('Health response is missing status or needsSetup');
  }
  return {
    status: record['status'],
    needsSetup: record['needsSetup'],
  };
}
