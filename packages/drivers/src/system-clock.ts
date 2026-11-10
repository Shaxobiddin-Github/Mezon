import { type Clock, type UnixMs, unixMsFromBigInt } from '@mezon/domain';

/**
 * Wall-clock adapter using runtime `Date.now()` for both Node.js and browser environments.
 */
export class SystemClock implements Clock {
  now(): UnixMs {
    return unixMsFromBigInt(BigInt(Date.now()));
  }
}
