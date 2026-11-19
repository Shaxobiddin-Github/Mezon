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
  getTerminalInfo: (): Promise<unknown> => ipcRenderer.invoke('mezon:terminal-info'),
  pairAsTerminal: (input: {
    host: string;
    port: number;
    code: string;
    terminalName: string;
  }): Promise<unknown> => ipcRenderer.invoke('mezon:terminal-pair', input),
  leaveTerminal: (): Promise<unknown> => ipcRenderer.invoke('mezon:terminal-leave'),
  relaunchApp: (): Promise<unknown> => ipcRenderer.invoke('mezon:relaunch'),
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
