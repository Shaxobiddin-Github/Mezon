#!/usr/bin/env node
// T4.8 update-manifest signing CLI (owner only; the private key never enters the repository).
//   node scripts/update-sign.mjs keygen --out <dir-outside-repo>
//   node scripts/update-sign.mjs sign --key <update-signing.key> --key-id <id>
//        --installer <Guzar-Setup-x.y.z.exe> --version <x.y.z> --url <https://.../file.exe>
//        [--platform win32-x64] [--channel stable] [--notes "..."] --out <update.json>
//   node scripts/update-sign.mjs verify --pub <base64-or-file> --current <x.y.z> --in <update.json>
// Requires `pnpm --filter @mezon/desktop build` (uses its manifest code, so both sides agree).
import { createHash, createPrivateKey, sign as cryptoSign } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, keygen } from './rules-sign-lib.mjs';

async function loadManifestCode() {
  const url = pathToFileURL(
    path.join(REPO_ROOT, 'apps', 'desktop', 'dist', 'update', 'update-manifest.js'),
  ).href;
  return import(url);
}

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

export async function signUpdate({
  privateKeyPem,
  keyId,
  installerBytes,
  version,
  url,
  platform = 'win32-x64',
  channel = 'stable',
  notes = '',
  releasedAtMs = Date.now(),
}) {
  const code = await loadManifestCode();
  const manifest = code.parseUpdateManifest({
    version,
    platform,
    channel,
    url,
    sha256: createHash('sha256').update(installerBytes).digest('hex'),
    sizeBytes: String(installerBytes.length),
    releasedAtMs: String(releasedAtMs),
    notes,
  });
  const signature = cryptoSign(
    null,
    Buffer.from(code.buildUpdateSigningMessage(keyId, manifest), 'utf8'),
    createPrivateKey(privateKeyPem),
  ).toString('base64');
  return { manifest, keyId, signature };
}

const cmd = process.argv[2];
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    if (cmd === 'keygen') {
      const res = keygen(required('out'), { name: 'update-signing' });
      console.log(`private key: ${res.privateKeyPath}`);
      console.log(`public key (raw, base64): ${res.publicKeyB64}`);
    } else if (cmd === 'sign') {
      const env = await signUpdate({
        privateKeyPem: fs.readFileSync(required('key'), 'utf8'),
        keyId: required('key-id'),
        installerBytes: fs.readFileSync(required('installer')),
        version: required('version'),
        url: required('url'),
        platform: arg('platform'),
        channel: arg('channel'),
        notes: arg('notes'),
      });
      fs.writeFileSync(required('out'), `${JSON.stringify(env, null, 2)}\n`, { flag: 'wx' });
      console.log(`signed update ${env.manifest.version} sha256=${env.manifest.sha256}`);
    } else if (cmd === 'verify') {
      const code = await loadManifestCode();
      const pubArg = required('pub');
      const pub = fs.existsSync(pubArg) ? fs.readFileSync(pubArg, 'utf8').trim() : pubArg;
      const envelope = JSON.parse(fs.readFileSync(required('in'), 'utf8'));
      code.verifyUpdateEnvelope(
        envelope,
        {
          currentVersion: required('current'),
          platform: envelope.manifest?.platform,
          channel: envelope.manifest?.channel,
        },
        [{ keyId: envelope.keyId, publicKeyB64: pub }],
        code.nodeEd25519UpdateVerifier,
      );
      console.log('OK: update signature valid');
    } else {
      console.error('Usage: update-sign.mjs keygen|sign|verify ...');
      process.exit(2);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
