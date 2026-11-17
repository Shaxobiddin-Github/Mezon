// T3.2 rules package signing helpers (used by scripts/rules-sign.mjs and tests).
// Private keys are NEVER written inside the repository; the production key holder is decided by the
// owner (question S2). Requires `pnpm --filter @mezon/rules build` (imports the built package).
import {
  createPrivateKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  createPublicKey,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

async function loadRules() {
  const url = pathToFileURL(path.join(REPO_ROOT, 'packages', 'rules', 'dist', 'index.js')).href;
  return import(url);
}

/** True when `target` resolves inside the repository working tree. */
export function isInsideRepo(target, repoRoot = REPO_ROOT) {
  const rel = path.relative(path.resolve(repoRoot), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Generates an Ed25519 key pair OUTSIDE the repository. The private key file is created with the
 * most restrictive mode the OS supports (0600; Windows ignores POSIX modes).
 * Returns { privateKeyPath, publicKeyPath, publicKeyB64 }.
 */
export function keygen(outDir, { repoRoot = REPO_ROOT, name = 'rules-signing' } = {}) {
  if (isInsideRepo(outDir, repoRoot)) {
    throw new Error(
      `Refusing to write signing keys inside the repository: ${path.resolve(outDir)}`,
    );
  }
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const publicKeyB64 = Buffer.from(spki.subarray(ED25519_SPKI_PREFIX.length)).toString('base64');
  const privateKeyPath = path.join(outDir, `${name}.key`);
  const publicKeyPath = path.join(outDir, `${name}.pub.b64`);
  fs.writeFileSync(privateKeyPath, privPem, { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(publicKeyPath, `${publicKeyB64}\n`, { mode: 0o644, flag: 'wx' });
  return { privateKeyPath, publicKeyPath, publicKeyB64 };
}

/** Signs a wire payload object with a PEM private key; returns the wire envelope object. */
export async function signPayload(payloadWire, keyId, privateKeyPem) {
  const rules = await loadRules();
  const payload = rules.parseRulesPayload(payloadWire);
  const message = rules.buildRulesSigningMessage(keyId, payload);
  const key = createPrivateKey(privateKeyPem);
  const signature = cryptoSign(null, Buffer.from(message, 'utf8'), key).toString('base64');
  return {
    format: 'mezon-rules',
    formatVersion: 1,
    keyId,
    payload: rules.rulesPayloadToWire(payload),
    signature,
  };
}

/** Verifies a wire envelope against a raw base64 public key; returns true/false. */
export async function verifyEnvelope(envelope, publicKeyB64) {
  const rules = await loadRules();
  const env = rules.parseRulesEnvelope(envelope);
  const message = rules.buildRulesSigningMessage(env.keyId, env.payload);
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyB64, 'base64')]),
    format: 'der',
    type: 'spki',
  });
  return cryptoVerify(
    null,
    Buffer.from(message, 'utf8'),
    key,
    Buffer.from(env.signature, 'base64'),
  );
}
