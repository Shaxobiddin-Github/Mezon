import type { PinHasher } from '@mezon/domain';
import { type Algorithm, type Options, hash, verify } from '@node-rs/argon2';

// Algorithm.Argon2id = 2 in @node-rs/argon2 (inlined literal required by TS isolatedModules)
const ARGON2ID_ALGORITHM = 2 as Algorithm;

/**
 * OWASP minimum Argon2id baseline (`m=19 MiB, t=2, p=1`).
 * Verified safe for low-power 4 GB RAM Windows POS terminals while resisting offline GPU cracking.
 */
export const HUB_ARGON2_OPTIONS: Readonly<Options> = {
  algorithm: ARGON2ID_ALGORITHM,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
};

export const ARGON2ID_PHC_PREFIX = '$argon2id$v=19$m=19456,t=2,p=1$';

export class Argon2PinHasher implements PinHasher {
  async hash(pin: string): Promise<string> {
    return hash(pin, HUB_ARGON2_OPTIONS);
  }

  async verify(storedHash: string, pin: string): Promise<boolean> {
    try {
      return await verify(storedHash, pin);
    } catch {
      return false;
    }
  }
}
