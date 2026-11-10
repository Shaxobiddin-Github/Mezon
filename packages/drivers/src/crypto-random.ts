import { type RandomSource } from '@mezon/domain';

interface WebCryptoLike {
  getRandomValues(array: Uint8Array): Uint8Array;
}

const MAX_GET_RANDOM_VALUES_CHUNK = 65536;

/**
 * Cryptographically strong random source backed by Web Crypto `globalThis.crypto.getRandomValues`,
 * compatible with Node.js 24 LTS, Electron, Capacitor WebView, and modern browsers.
 */
export class CryptoRandomSource implements RandomSource {
  private readonly cryptoImpl: WebCryptoLike;

  constructor() {
    const candidate = (globalThis as { readonly crypto?: WebCryptoLike }).crypto;
    if (candidate === undefined || typeof candidate.getRandomValues !== 'function') {
      throw new Error('Web Crypto API (globalThis.crypto.getRandomValues) is unavailable');
    }
    this.cryptoImpl = candidate;
  }

  nextBytes(length: number): Uint8Array {
    if (!Number.isInteger(length) || length < 0) {
      throw new RangeError('Random byte length must be a non-negative integer');
    }
    const output = new Uint8Array(length);
    for (let offset = 0; offset < length; offset += MAX_GET_RANDOM_VALUES_CHUNK) {
      const end = Math.min(offset + MAX_GET_RANDOM_VALUES_CHUNK, length);
      this.cryptoImpl.getRandomValues(output.subarray(offset, end));
    }
    return output;
  }
}
