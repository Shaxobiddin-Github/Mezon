import { BarcodeScanner } from '@capacitor-mlkit/barcode-scanning';
import { registerPlugin } from '@capacitor/core';
import type {
  AndroidMezonBridge,
  HubBridgeState,
  TerminalInfo,
  TerminalPairResult,
} from './pos-bridge-types.js';
import { decodeNativeResponse, isVirtualHubUrl, VIRTUAL_HUB_BASE_URL } from './virtual-hub.js';

/**
 * Android shell bridge (T4.4). The phone is a v1 LAN terminal without a local hub:
 * - the POS talks to a virtual loopback URL (`VIRTUAL_HUB_BASE_URL`), so its loopback checks stay;
 * - `fetch` calls to that URL go to the native `MezonHub` plugin, which forwards them to the hub's
 *   LAN listener over pinned TLS and adds the terminal key. The key never reaches JavaScript.
 */

interface NativeTerminalInfo {
  readonly mode: 'hub' | 'terminal';
  readonly terminalName?: string;
  readonly hubHost?: string;
  readonly hubPort?: number;
  readonly fingerprint256?: string;
  readonly pairedAtMs?: number;
}

interface NativeResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

interface MezonHubPlugin {
  info(): Promise<NativeTerminalInfo>;
  pair(input: {
    host: string;
    port: number;
    code: string;
    terminalName: string;
  }): Promise<TerminalPairResult>;
  leave(): Promise<{ ok: boolean }>;
  /** Restarts the whole app process (a WebView reload alone keeps stale native state). */
  restart(): Promise<void>;
  request(input: {
    method: string;
    path: string;
    headers: Record<string, string>;
    body: string | null;
  }): Promise<NativeResponse>;
}

const MezonHub = registerPlugin<MezonHubPlugin>('MezonHub');

const toTerminalInfo = (n: NativeTerminalInfo): TerminalInfo =>
  n.mode === 'terminal' &&
  n.terminalName !== undefined &&
  n.hubHost !== undefined &&
  n.hubPort !== undefined &&
  n.fingerprint256 !== undefined &&
  n.pairedAtMs !== undefined
    ? {
        mode: 'terminal',
        terminalName: n.terminalName,
        hubHost: n.hubHost,
        hubPort: n.hubPort,
        fingerprint256: n.fingerprint256,
        pairedAtMs: n.pairedAtMs,
      }
    : { mode: 'hub' };

let infoPromise: Promise<TerminalInfo> | null = null;
const terminalInfo = (): Promise<TerminalInfo> => {
  infoPromise ??= MezonHub.info().then(toTerminalInfo);
  return infoPromise;
};

const hubState = async (): Promise<HubBridgeState> =>
  (await terminalInfo()).mode === 'terminal'
    ? { baseUrl: VIRTUAL_HUB_BASE_URL, status: 'ready', restartCount: 0 }
    : { baseUrl: null, status: 'error', restartCount: 0, lastError: 'NOT_PAIRED' };

const nativeFetch = window.fetch.bind(window);

window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const request = new Request(input, init);
  if (!isVirtualHubUrl(request.url)) return nativeFetch(input, init);
  const url = new URL(request.url);
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const body = request.method === 'GET' || request.method === 'HEAD' ? null : await request.text();
  let res: NativeResponse;
  try {
    res = await MezonHub.request({
      method: request.method,
      path: `${url.pathname}${url.search}`,
      headers,
      body: body === '' ? null : body,
    });
  } catch (err) {
    // Same shape as a browser network failure: hub-client maps it to NETWORK_ERROR.
    throw new TypeError(err instanceof Error ? err.message : 'Hub is unreachable');
  }
  return decodeNativeResponse(res);
};

const scanBarcode = async (): Promise<string | null> => {
  const { camera } = await BarcodeScanner.requestPermissions();
  if (camera !== 'granted' && camera !== 'limited') {
    throw new Error('CAMERA_PERMISSION_DENIED');
  }
  try {
    const { barcodes } = await BarcodeScanner.scan();
    const value = barcodes[0]?.rawValue?.trim();
    return value !== undefined && value !== '' ? value : null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/canceled|cancelled/i.test(message)) return null;
    if (/module is not available/i.test(message)) {
      // First use on a phone: Google Play downloads the scanner module once.
      await BarcodeScanner.installGoogleBarcodeScannerModule();
      throw new Error('SCANNER_MODULE_INSTALLING');
    }
    throw err;
  }
};

const bridge: AndroidMezonBridge = {
  thinClient: true,
  getHubState: hubState,
  onHubState: () => () => undefined,
  getTerminalInfo: terminalInfo,
  pairAsTerminal: async (input) => {
    const res = await MezonHub.pair(input);
    if (res.ok) infoPromise = null;
    return res;
  },
  leaveTerminal: async () => {
    const res = await MezonHub.leave();
    infoPromise = null;
    return { ok: res.ok };
  },
  relaunchApp: () => MezonHub.restart(),

  scanBarcode,
};

window.mezonBridge = bridge;
