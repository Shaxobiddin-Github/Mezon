export interface HubBridgeState {
  readonly baseUrl: string | null;
  readonly restartCount: number;
  readonly status: 'starting' | 'ready' | 'restarting' | 'error';
  readonly lastError?: string;
}

export interface MezonBridge {
  getHubState(): Promise<HubBridgeState>;
  onHubState(listener: (state: HubBridgeState) => void): () => void;
}

export interface HealthPayload {
  readonly status: string;
  readonly needsSetup: boolean;
}

declare global {
  interface Window {
    mezonBridge?: MezonBridge;
  }
}

export function buildHubHealthUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') {
    throw new Error(`Invalid hub baseUrl: ${baseUrl}`);
  }
  return new URL('/health', parsed).toString();
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
