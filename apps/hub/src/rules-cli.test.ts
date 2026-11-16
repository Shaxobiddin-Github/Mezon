import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ImportRulesPackageResponseSchema, LoginResponseSchema } from '@mezon/contracts';
import type { PinHasher } from '@mezon/domain';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error — plain ESM script without type declarations (scripts/ is not a TS package)
import * as cli from '../../../scripts/rules-sign-lib.mjs';
import { createHubServer } from './index.js';

interface CliLib {
  readonly REPO_ROOT: string;
  isInsideRepo(target: string, repoRoot?: string): boolean;
  keygen(
    outDir: string,
    opts?: { repoRoot?: string; name?: string },
  ): { privateKeyPath: string; publicKeyPath: string; publicKeyB64: string };
  signPayload(payload: unknown, keyId: string, pem: string): Promise<Record<string, unknown>>;
  verifyEnvelope(envelope: unknown, publicKeyB64: string): Promise<boolean>;
}
const lib = cli as unknown as CliLib;

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

const NOW = 1_763_000_000_000n;
const DAY = 86_400_000n;
const PAYLOAD = {
  packageVersion: '1',
  issuedAtMs: (NOW - DAY).toString(),
  validUntilMs: (NOW + DAY).toString(),
  sourceRefs: ['SINTETIK-TEST'],
  cashForbidden: { exact: [], prefixes: [] },
  perMxikCashLimit: null,
  expiredGoods: { enabled: true },
};

describe('T3.2a scripts/rules-sign (CLI library)', () => {
  it('keygen refuses any path inside the repository (incl. repo root and nested dirs)', () => {
    // Safety: exercise keygen against a THROWAWAY repo root so that even a broken guard can never
    // write keys into the real working tree. The real repo root is checked with the pure predicate.
    const fakeRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-fake-repo-'));
    tempDirs.push(fakeRepo);
    for (const target of [
      fakeRepo,
      path.join(fakeRepo, 'keys'),
      path.join(fakeRepo, 'packages', 'x'),
    ]) {
      expect(() => lib.keygen(target, { repoRoot: fakeRepo }), target).toThrow(
        /inside the repository/,
      );
    }
    expect(fs.readdirSync(fakeRepo)).toEqual([]);
    for (const target of [lib.REPO_ROOT, path.join(lib.REPO_ROOT, 'keys')]) {
      expect(lib.isInsideRepo(target), target).toBe(true);
    }
    expect(lib.isInsideRepo(path.join(os.tmpdir(), 'mezon-x'))).toBe(false);
  });

  it('keygen outside the repo → restricted private key; sign → verify; tamper → false; hub imports it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-rules-keys-'));
    tempDirs.push(dir);
    const keys = lib.keygen(path.join(dir, 'k'));
    expect(fs.existsSync(keys.privateKeyPath)).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(keys.privateKeyPath).mode & 0o077).toBe(0);
    }
    // refuses to overwrite an existing key
    expect(() => lib.keygen(path.join(dir, 'k'))).toThrow();

    const pem = fs.readFileSync(keys.privateKeyPath, 'utf8');
    const env = await lib.signPayload(PAYLOAD, 'cli-test', pem);
    expect(await lib.verifyEnvelope(env, keys.publicKeyB64)).toBe(true);
    const tampered = { ...env, payload: { ...PAYLOAD, sourceRefs: ['BOSHQA'] } };
    expect(await lib.verifyEnvelope(tampered, keys.publicKeyB64)).toBe(false);

    const hasher: PinHasher = {
      hash: (pin) => Promise.resolve(`h:${pin}`),
      verify: (s, pin) => Promise.resolve(s === `h:${pin}`),
    };
    const hub = await createHubServer({
      dbPath: path.join(dir, 'hub.db'),
      port: 47871,
      logLevel: 'silent',
      clock: new FixedClock(NOW),
      random: new SeededRandomSource(3301),
      pinHasher: hasher,
      trustedRuleKeys: [
        { keyId: 'cli-test', publicKeyB64: keys.publicKeyB64, validFromMs: 0n, validUntilMs: null },
      ],
    });
    try {
      const host = { host: '127.0.0.1:47871' };
      await hub.app.inject({
        method: 'POST',
        url: '/setup',
        headers: host,
        payload: { owner: { fullName: 'Egasi', username: 'owner', pin: '849201' } },
      });
      const token = LoginResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/auth/login',
            headers: host,
            payload: { username: 'owner', pin: '849201' },
          })
        ).json(),
      ).token;
      const res = await hub.app.inject({
        method: 'POST',
        url: '/rules/package',
        headers: { ...host, authorization: `Bearer ${token}` },
        payload: { envelope: env },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(ImportRulesPackageResponseSchema.parse(res.json()).keyId).toBe('cli-test');
    } finally {
      await hub.close();
    }
  });
});
