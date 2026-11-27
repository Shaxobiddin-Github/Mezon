/**
 * The part of the POS bridge contract (`apps/pos/src/bridge.ts`) the Android shell implements.
 * Apps may not import each other (dependency-cruiser), so the shape is restated here; the POS
 * checks every value it reads at runtime (loopback URL, terminal info) anyway.
 */
export interface HubBridgeState {
  readonly baseUrl: string | null;
  readonly restartCount: number;
  readonly status: 'starting' | 'ready' | 'restarting' | 'error';
  readonly lastError?: string;
}

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

export interface AndroidMezonBridge {
  readonly thinClient: true;
  getHubState(): Promise<HubBridgeState>;
  onHubState(listener: (state: HubBridgeState) => void): () => void;
  getTerminalInfo(): Promise<TerminalInfo>;
  pairAsTerminal(input: {
    host: string;
    port: number;
    code: string;
    terminalName: string;
  }): Promise<TerminalPairResult>;
  leaveTerminal(): Promise<{ readonly ok: boolean }>;
  relaunchApp(): Promise<void>;
  readonly scanBarcode: () => Promise<string | null>;
  readonly startLiveScan: (onCode: (code: string) => void) => Promise<() => Promise<void>>;
  /** C22: hands a PNG to the phone's share sheet (Telegram, WhatsApp, gallery…). */
  readonly shareImage: (input: {
    readonly base64: string;
    readonly fileName: string;
    readonly title: string;
  }) => Promise<void>;
}

declare global {
  interface Window {
    mezonBridge?: unknown;
  }
}
