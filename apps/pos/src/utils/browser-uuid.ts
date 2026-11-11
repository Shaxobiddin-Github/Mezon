import { type UuidV7, encodeUuidV7, unixMsFromBigInt } from '@mezon/domain';

let lastMs = 0n;
let counter = 0;

/**
 * Generates a monotonic RFC 9562 UUIDv7 in the browser renderer using `globalThis.crypto.getRandomValues`
 * and `@mezon/domain` `encodeUuidV7`.
 */
export function generateBrowserUuidV7(): UuidV7 {
  const nowBig = BigInt(Date.now());
  if (nowBig > lastMs) {
    lastMs = nowBig;
    counter = 0;
  } else {
    counter += 1;
    if (counter > 0x0fff) {
      lastMs += 1n;
      counter = 0;
    }
  }

  const randomBytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(randomBytes);
  // Embed 12-bit monotonic counter into high 12 bits of rand_a (tail[0..1] low 12 bits)
  randomBytes[0] = (counter >> 8) & 0x0f;
  randomBytes[1] = counter & 0xff;

  return encodeUuidV7(unixMsFromBigInt(lastMs), randomBytes);
}
