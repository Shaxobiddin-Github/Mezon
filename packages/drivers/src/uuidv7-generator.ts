import { MonotonicUuidV7Generator, type UnixMs } from '@mezon/domain';
import { CryptoRandomSource } from './crypto-random.js';
import { SystemClock } from './system-clock.js';

export function createSystemUuidV7Generator(initialLastMs?: UnixMs): MonotonicUuidV7Generator {
  return new MonotonicUuidV7Generator({
    clock: new SystemClock(),
    random: new CryptoRandomSource(),
    ...(initialLastMs !== undefined ? { initialLastMs } : {}),
  });
}
