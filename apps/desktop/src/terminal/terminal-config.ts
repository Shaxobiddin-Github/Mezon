import fs from 'node:fs';
import path from 'node:path';
import type { PinnedLanHubTarget } from '@mezon/drivers/node';
import type { DataKeyCipher } from '../data-key.js';

/**
 * v1 LAN terminal: this computer is a second cash register of a hub on another computer.
 * Saved after a successful pairing; while it exists the app runs no local hub.
 * The terminal key is stored OS-wrapped (Electron safeStorage); the hub certificate is public.
 */
export interface TerminalConfig {
  readonly terminalId: string;
  readonly terminalKey: string;
  readonly terminalName: string;
  readonly hub: PinnedLanHubTarget;
  readonly pairedAtMs: number;
}

interface TerminalConfigFile {
  readonly v: 1;
  readonly terminalId: string;
  readonly terminalName: string;
  readonly keyWrap: 'os' | 'none';
  readonly key: string;
  readonly hub: PinnedLanHubTarget;
  readonly pairedAtMs: number;
}

/** What the UI may see: never the key or the certificate body. */
export interface TerminalInfo {
  readonly mode: 'terminal';
  readonly terminalName: string;
  readonly hubHost: string;
  readonly hubPort: number;
  readonly fingerprint256: string;
  readonly pairedAtMs: number;
}

export function terminalInfoOf(c: TerminalConfig): TerminalInfo {
  return {
    mode: 'terminal',
    terminalName: c.terminalName,
    hubHost: c.hub.host,
    hubPort: c.hub.port,
    fingerprint256: c.hub.fingerprint256,
    pairedAtMs: c.pairedAtMs,
  };
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export function loadTerminalConfig(filePath: string, cipher: DataKeyCipher): TerminalConfig | null {
  if (!fs.existsSync(filePath)) return null;
  const f = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<TerminalConfigFile>;
  const hub = f.hub as Partial<PinnedLanHubTarget> | undefined;
  if (
    f.v !== 1 ||
    !isStr(f.terminalId) ||
    !isStr(f.terminalName) ||
    !isStr(f.key) ||
    (f.keyWrap !== 'os' && f.keyWrap !== 'none') ||
    typeof f.pairedAtMs !== 'number' ||
    hub === undefined ||
    !isStr(hub.host) ||
    typeof hub.port !== 'number' ||
    !isStr(hub.certPem) ||
    !isStr(hub.fingerprint256)
  ) {
    throw new Error('Terminal config file is corrupt');
  }
  const terminalKey =
    f.keyWrap === 'os' ? cipher.decryptString(Buffer.from(f.key, 'base64')) : f.key;
  return {
    terminalId: f.terminalId,
    terminalKey,
    terminalName: f.terminalName,
    hub: {
      host: hub.host,
      port: hub.port,
      certPem: hub.certPem,
      fingerprint256: hub.fingerprint256,
    },
    pairedAtMs: f.pairedAtMs,
  };
}

export function saveTerminalConfig(
  filePath: string,
  c: TerminalConfig,
  cipher: DataKeyCipher,
): void {
  const wrapped = cipher.isEncryptionAvailable();
  const file: TerminalConfigFile = {
    v: 1,
    terminalId: c.terminalId,
    terminalName: c.terminalName,
    keyWrap: wrapped ? 'os' : 'none',
    key: wrapped ? cipher.encryptString(c.terminalKey).toString('base64') : c.terminalKey,
    hub: c.hub,
    pairedAtMs: c.pairedAtMs,
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

export function deleteTerminalConfig(filePath: string): void {
  fs.rmSync(filePath, { force: true });
}

/** `192.168.1.10`, `kassa-1` or `kassa-1.local`; no scheme, path or port. */
export function isValidLanHost(host: string): boolean {
  return (
    host.length > 0 &&
    host.length <= 253 &&
    /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host) &&
    !host.includes('..')
  );
}
