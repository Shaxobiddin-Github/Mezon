import { createPublicKey, verify } from 'node:crypto';

/**
 * T4.8 — signed update manifest. Same scheme as the rules package (T3.2) and the licence (T4.7):
 * Ed25519 over a domain-separated canonical JSON, with a `keyId` naming a key the app trusts.
 * The private key never enters the repository (`scripts/update-sign.mjs keygen` writes it outside).
 *
 * The manifest binds the installer by SHA-256 and size, so the download location itself does not
 * need to be trusted: a changed or truncated file is refused before it is ever started.
 */
export interface UpdateManifest {
  /** `major.minor.patch` of the new version. */
  readonly version: string;
  /** Build target, e.g. `win32-x64`. */
  readonly platform: string;
  /** Release channel, e.g. `stable`. */
  readonly channel: string;
  /** HTTPS location of the installer. */
  readonly url: string;
  /** Lowercase hex SHA-256 of the installer. */
  readonly sha256: string;
  /** Installer size in bytes (decimal string). */
  readonly sizeBytes: string;
  /** Unix ms (decimal string). */
  readonly releasedAtMs: string;
  /** Short change note shown to the cashier (plain text). */
  readonly notes: string;
}

export interface UpdateEnvelope {
  readonly manifest: UpdateManifest;
  readonly keyId: string;
  readonly signature: string;
}

export interface TrustedUpdateKey {
  readonly keyId: string;
  /** Raw 32-byte Ed25519 public key, base64. */
  readonly publicKeyB64: string;
}

/**
 * Keys this build trusts for updates. Empty until the owner generates the update key pair
 * (outside the repository) and gives the public part: with no key, automatic updates stay off.
 */
export const PRODUCTION_TRUSTED_UPDATE_KEYS: readonly TrustedUpdateKey[] = [];

/**
 * Where installed apps look for the signed manifest. Empty until the owner chooses the HTTPS
 * location; `MEZON_UPDATE_MANIFEST_URL` overrides it (pilot / testing).
 */
export const DEFAULT_UPDATE_MANIFEST_URL = '';

export const UPDATE_SIGNING_PREFIX = 'mezon-update/v1\n';

const MANIFEST_FIELDS = [
  'channel',
  'notes',
  'platform',
  'releasedAtMs',
  'sha256',
  'sizeBytes',
  'url',
  'version',
] as const;

export class UpdateManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpdateManifestError';
  }
}

const VERSION_RE = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;

/** -1, 0 or 1. Only plain `x.y.z` versions are accepted. */
export function compareVersions(a: string, b: string): number {
  const pa = VERSION_RE.exec(a);
  const pb = VERSION_RE.exec(b);
  if (!pa || !pb) throw new UpdateManifestError(`Invalid version: ${!pa ? a : b}`);
  for (let i = 1; i <= 3; i += 1) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

function canonicalManifest(m: UpdateManifest): string {
  const sorted: Record<string, string> = {};
  for (const k of MANIFEST_FIELDS) sorted[k] = m[k];
  return JSON.stringify(sorted);
}

export function buildUpdateSigningMessage(keyId: string, manifest: UpdateManifest): string {
  return `${UPDATE_SIGNING_PREFIX}${JSON.stringify({ keyId, manifest: canonicalManifest(manifest) })}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parseUpdateManifest(raw: unknown): UpdateManifest {
  if (!isRecord(raw)) throw new UpdateManifestError('Manifest must be an object');
  for (const k of Object.keys(raw)) {
    if (!(MANIFEST_FIELDS as readonly string[]).includes(k)) {
      throw new UpdateManifestError(`Manifest has an unknown field "${k}"`);
    }
  }
  const out: Record<string, string> = {};
  for (const k of MANIFEST_FIELDS) {
    const v = raw[k];
    if (typeof v !== 'string')
      throw new UpdateManifestError(`Manifest field "${k}" must be a string`);
    out[k] = v;
  }
  const m = out as unknown as UpdateManifest;
  compareVersions(m.version, m.version);
  if (!/^[a-z0-9]+-[a-z0-9]+$/.test(m.platform)) throw new UpdateManifestError('Invalid platform');
  if (!/^[a-z]{1,16}$/.test(m.channel)) throw new UpdateManifestError('Invalid channel');
  let url: URL;
  try {
    url = new URL(m.url);
  } catch {
    throw new UpdateManifestError('Invalid url');
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new UpdateManifestError('Update url must be plain https');
  }
  if (!/^[0-9a-f]{64}$/.test(m.sha256)) throw new UpdateManifestError('Invalid sha256');
  if (!/^[1-9]\d{0,10}$/.test(m.sizeBytes)) throw new UpdateManifestError('Invalid sizeBytes');
  if (!/^(0|[1-9]\d{0,15})$/.test(m.releasedAtMs))
    throw new UpdateManifestError('Invalid releasedAtMs');
  if (m.notes.length > 500) throw new UpdateManifestError('Notes are too long');
  return m;
}

export interface Ed25519Verifier {
  verifyEd25519(publicKeyB64: string, message: string, signatureB64: string): boolean;
}

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export const nodeEd25519UpdateVerifier: Ed25519Verifier = {
  verifyEd25519(publicKeyB64, message, signatureB64) {
    const raw = Buffer.from(publicKeyB64, 'base64');
    if (raw.length !== 32) return false;
    const key = createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
      format: 'der',
      type: 'spki',
    });
    return verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(signatureB64, 'base64'));
  },
};

/**
 * Verifies the envelope and checks that it is an update for THIS install: same platform and
 * channel, and strictly newer than the running version (a replayed old manifest is a downgrade
 * and is refused).
 */
export function verifyUpdateEnvelope(
  raw: unknown,
  expected: {
    readonly currentVersion: string;
    readonly platform: string;
    readonly channel: string;
  },
  keys: readonly TrustedUpdateKey[],
  verifier: Ed25519Verifier,
): UpdateEnvelope {
  if (!isRecord(raw)) throw new UpdateManifestError('Envelope must be an object');
  for (const k of Object.keys(raw)) {
    if (k !== 'manifest' && k !== 'keyId' && k !== 'signature') {
      throw new UpdateManifestError(`Envelope has an unknown field "${k}"`);
    }
  }
  const { keyId, signature } = raw;
  if (typeof keyId !== 'string' || typeof signature !== 'string') {
    throw new UpdateManifestError('Envelope keyId and signature must be strings');
  }
  const manifest = parseUpdateManifest(raw.manifest);
  const key = keys.find((k) => k.keyId === keyId);
  if (!key) throw new UpdateManifestError(`Unknown update key "${keyId}"`);
  let ok = false;
  try {
    ok = verifier.verifyEd25519(
      key.publicKeyB64,
      buildUpdateSigningMessage(keyId, manifest),
      signature,
    );
  } catch {
    ok = false;
  }
  if (!ok) throw new UpdateManifestError('Update signature is invalid');
  if (manifest.platform !== expected.platform) {
    throw new UpdateManifestError(`Update is for ${manifest.platform}, not ${expected.platform}`);
  }
  if (manifest.channel !== expected.channel) {
    throw new UpdateManifestError(`Update is for channel ${manifest.channel}`);
  }
  if (compareVersions(manifest.version, expected.currentVersion) <= 0) {
    throw new UpdateManifestError(
      `Update ${manifest.version} is not newer than ${expected.currentVersion}`,
    );
  }
  return { manifest, keyId, signature };
}
