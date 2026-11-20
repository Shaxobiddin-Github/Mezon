import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The hub encrypts secrets at rest (cloud device token, LAN TLS key, LAN pairing codes) with a
 * 32-byte data key. The key must survive restarts, otherwise those secrets become unreadable after
 * the first restart (cloud sync and LAN terminals stop). It is created once and kept in userData,
 * wrapped by the OS (Electron safeStorage: DPAPI on Windows).
 */

export interface DataKeyCipher {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(cipher: Buffer): string;
}

interface DataKeyFile {
  readonly v: 1;
  readonly wrap: 'os' | 'none';
  readonly key: string;
}

const KEY_BYTES = 32;

function assertKey(b64: string): string {
  if (Buffer.from(b64, 'base64').length !== KEY_BYTES) {
    throw new Error('Hub data key file is corrupt (wrong key length)');
  }
  return b64;
}

/** Returns the base64 data key, creating and saving it on first use. */
export function loadOrCreateDataKey(o: {
  readonly filePath: string;
  readonly cipher: DataKeyCipher;
  readonly onUnwrapped?: () => void;
}): string {
  if (fs.existsSync(o.filePath)) {
    const file = JSON.parse(fs.readFileSync(o.filePath, 'utf8')) as Partial<DataKeyFile>;
    if (file.v !== 1 || typeof file.key !== 'string') {
      throw new Error('Hub data key file has an unknown format');
    }
    if (file.wrap === 'os') {
      return assertKey(o.cipher.decryptString(Buffer.from(file.key, 'base64')));
    }
    if (file.wrap === 'none') return assertKey(file.key);
    throw new Error('Hub data key file has an unknown wrap');
  }

  const key = randomBytes(KEY_BYTES).toString('base64');
  const wrapped = o.cipher.isEncryptionAvailable();
  if (!wrapped) o.onUnwrapped?.();
  const file: DataKeyFile = wrapped
    ? { v: 1, wrap: 'os', key: o.cipher.encryptString(key).toString('base64') }
    : { v: 1, wrap: 'none', key };
  fs.mkdirSync(path.dirname(o.filePath), { recursive: true });
  // Write to a temp file first: a crash must never leave a half-written key behind.
  const tmp = `${o.filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
  fs.renameSync(tmp, o.filePath);
  return key;
}
