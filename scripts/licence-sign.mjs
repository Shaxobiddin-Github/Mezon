#!/usr/bin/env node
// T4.7 licence signing CLI (owner only; the private key never enters the repository).
//   node scripts/licence-sign.mjs keygen --out <dir-outside-repo>
//   node scripts/licence-sign.mjs sign --key <licence-signing.key> --key-id <id>
//        --org <organization uuid> --plan start|business|pro --months <n> [--from <YYYY-MM-DD>]
//        --out <licence.json>
//   node scripts/licence-sign.mjs verify --pub <base64-or-file> --org <uuid> --in <licence.json>
// Requires `pnpm --filter @mezon/licensing build`.
import {
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, keygen } from './rules-sign-lib.mjs';

async function loadLicensing() {
  const url = pathToFileURL(path.join(REPO_ROOT, 'packages', 'licensing', 'dist', 'index.js')).href;
  return import(url);
}

export const nodeVerifier = {
  verifyEd25519(publicKeyB64, message, signatureB64) {
    const spki = Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(publicKeyB64, 'base64'),
    ]);
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    return cryptoVerify(
      null,
      Buffer.from(message, 'utf8'),
      key,
      Buffer.from(signatureB64, 'base64'),
    );
  },
};

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function required(name) {
  const v = arg(name);
  if (!v) {
    console.error(`Missing --${name}`);
    process.exit(2);
  }
  return v;
}

/** UUIDv7 from the current time and random bytes (licence id). */
function uuidV7() {
  const b = randomBytes(16);
  const ms = BigInt(Date.now());
  for (let i = 0; i < 6; i += 1) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Adds calendar months in UTC (end of licence = same day number, clamped to the month's end). */
function addMonths(ms, months) {
  const d = new Date(Number(ms));
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return BigInt(d.getTime());
}

export async function signLicence({ privateKeyPem, keyId, organizationId, plan, months, fromMs }) {
  const lic = await loadLicensing();
  if (!lic.LICENCE_PLANS.includes(plan)) throw new Error(`Unknown plan "${plan}"`);
  if (!Number.isInteger(months) || months < 1 || months > 36) throw new Error('--months: 1..36');
  const validFromMs = fromMs ?? BigInt(Date.now());
  const payload = lic.parseLicencePayload({
    licenceId: uuidV7(),
    organizationId,
    plan,
    limits: lic.PLAN_CATALOG[plan].limits,
    issuedAtMs: String(Date.now()),
    validFromMs: String(validFromMs),
    validUntilMs: String(addMonths(validFromMs, months) - 1n),
  });
  const message = lic.buildLicenceSigningMessage(keyId, payload);
  const signature = cryptoSign(
    null,
    Buffer.from(message, 'utf8'),
    createPrivateKey(privateKeyPem),
  ).toString('base64');
  return { payload: lic.licencePayloadToWire(payload), keyId, signature };
}

const cmd = process.argv[2];
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    if (cmd === 'keygen') {
      const res = keygen(required('out'), { name: 'licence-signing' });
      console.log(`private key: ${res.privateKeyPath}`);
      console.log(`public key (raw, base64): ${res.publicKeyB64}`);
    } else if (cmd === 'sign') {
      const from = arg('from');
      const env = await signLicence({
        privateKeyPem: fs.readFileSync(required('key'), 'utf8'),
        keyId: required('key-id'),
        organizationId: required('org'),
        plan: required('plan'),
        months: Number(required('months')),
        fromMs: from ? BigInt(Date.parse(`${from}T00:00:00Z`)) : undefined,
      });
      fs.writeFileSync(required('out'), `${JSON.stringify(env, null, 2)}\n`, { flag: 'wx' });
      console.log(
        `signed ${env.payload.plan} licence ${env.payload.licenceId} until ${env.payload.validUntilMs}`,
      );
    } else if (cmd === 'verify') {
      const lic = await loadLicensing();
      const pubArg = required('pub');
      const pub = fs.existsSync(pubArg) ? fs.readFileSync(pubArg, 'utf8').trim() : pubArg;
      const envelope = JSON.parse(fs.readFileSync(required('in'), 'utf8'));
      lic.verifyLicence(
        envelope,
        required('org'),
        [{ keyId: envelope.keyId, publicKeyB64: pub, validFromMs: 0n, validUntilMs: null }],
        nodeVerifier,
      );
      console.log('OK: licence signature valid');
    } else {
      console.error('Usage: licence-sign.mjs keygen|sign|verify ...');
      process.exit(2);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
