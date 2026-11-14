import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface SafeStoragePort {
  isAvailable(): boolean;
  encryptString(plainText: string): Promise<Buffer>;
  decryptString(cipherText: Buffer): Promise<string>;
}

/**
 * Standard software AES-256-GCM adapter for test, CLI, and standalone execution.
 * Production Electron desktop app bridges utilityProcess to Electron's native safeStorage in main process (D4).
 */
export class AesGcmSafeStorageAdapter implements SafeStoragePort {
  private readonly key: Buffer;

  constructor(secretKey?: Buffer | string) {
    if (secretKey) {
      this.key =
        typeof secretKey === 'string'
          ? Buffer.from(secretKey.padEnd(32, '0').slice(0, 32), 'utf8')
          : secretKey;
    } else {
      this.key = randomBytes(32);
    }
  }

  isAvailable(): boolean {
    return true;
  }

  encryptString(plainText: string): Promise<Buffer> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Promise.resolve(Buffer.concat([iv, tag, encrypted]));
  }

  decryptString(cipherText: Buffer): Promise<string> {
    if (cipherText.length < 28) {
      return Promise.reject(new Error('Ciphertext is too short to be valid'));
    }
    const iv = cipherText.subarray(0, 12);
    const tag = cipherText.subarray(12, 28);
    const encrypted = cipherText.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Promise.resolve(decipher.update(encrypted, undefined, 'utf8') + decipher.final('utf8'));
  }
}
