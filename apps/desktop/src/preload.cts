import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

interface HubBridgeStatePayload {
  readonly baseUrl: string | null;
  readonly restartCount: number;
  readonly status: 'starting' | 'ready' | 'restarting' | 'error';
  readonly lastError?: string;
}

interface UpdateStatePayload {
  readonly phase: string;
  readonly currentVersion: string;
  readonly version: string | null;
  readonly notes: string | null;
  readonly schedule: unknown;
  readonly waitReason: string | null;
  readonly error: string | null;
}

contextBridge.exposeInMainWorld('mezonBridge', {
  // T4.8: application update (the cashier chooses when; see apps/desktop/src/update).
  getUpdateState: (): Promise<UpdateStatePayload> => {
    return ipcRenderer.invoke('mezon:update-get-state') as Promise<UpdateStatePayload>;
  },
  scheduleUpdate: (
    choice: { kind: 'now' } | { kind: 'shift_close' } | { kind: 'at'; atMs: string },
  ): Promise<boolean> => {
    return ipcRenderer.invoke('mezon:update-schedule', choice) as Promise<boolean>;
  },
  cancelUpdate: (): Promise<void> => {
    return ipcRenderer.invoke('mezon:update-cancel') as Promise<void>;
  },
  onUpdateState: (listener: (state: UpdateStatePayload) => void): (() => void) => {
    const wrapped = (_event: IpcRendererEvent, state: UpdateStatePayload) => {
      listener(state);
    };
    ipcRenderer.on('mezon:update-state', wrapped);
    return () => {
      ipcRenderer.removeListener('mezon:update-state', wrapped);
    };
  },
  getHubState: (): Promise<HubBridgeStatePayload> => {
    return ipcRenderer.invoke('mezon:get-hub-state') as Promise<HubBridgeStatePayload>;
  },
  onHubState: (listener: (state: HubBridgeStatePayload) => void): (() => void) => {
    const wrapped = (_event: IpcRendererEvent, state: HubBridgeStatePayload) => {
      listener(state);
    };
    ipcRenderer.on('mezon:hub-state', wrapped);
    return () => {
      ipcRenderer.removeListener('mezon:hub-state', wrapped);
    };
  },
});
