import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

interface HubBridgeStatePayload {
  readonly baseUrl: string | null;
  readonly restartCount: number;
  readonly status: 'starting' | 'ready' | 'restarting' | 'error';
  readonly lastError?: string;
}

contextBridge.exposeInMainWorld('mezonBridge', {
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
