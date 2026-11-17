#!/usr/bin/env node
// T3.2 rules package signing CLI.
//   node scripts/rules-sign.mjs keygen --out <dir-outside-repo> [--name <basename>]
//   node scripts/rules-sign.mjs sign   --key <private.key> --key-id <id> --in <payload.json> --out <package.json>
//   node scripts/rules-sign.mjs verify --pub <base64-or-file> --in <package.json>
// The production private key is never stored in this repository (owner question S2).
import fs from 'node:fs';
import { keygen, signPayload, verifyEnvelope } from './rules-sign-lib.mjs';

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

const cmd = process.argv[2];
try {
  if (cmd === 'keygen') {
    const res = keygen(required('out'), { name: arg('name') ?? 'rules-signing' });
    console.log(`private key: ${res.privateKeyPath}`);
    console.log(`public key (raw, base64): ${res.publicKeyB64}`);
  } else if (cmd === 'sign') {
    const payload = JSON.parse(fs.readFileSync(required('in'), 'utf8'));
    const env = await signPayload(
      payload,
      required('key-id'),
      fs.readFileSync(required('key'), 'utf8'),
    );
    fs.writeFileSync(required('out'), `${JSON.stringify(env, null, 2)}\n`, { flag: 'wx' });
    console.log(`signed package version ${env.payload.packageVersion} with key ${env.keyId}`);
  } else if (cmd === 'verify') {
    const pubArg = required('pub');
    const pub = fs.existsSync(pubArg) ? fs.readFileSync(pubArg, 'utf8').trim() : pubArg;
    const ok = await verifyEnvelope(JSON.parse(fs.readFileSync(required('in'), 'utf8')), pub);
    console.log(ok ? 'OK: signature valid' : 'FAIL: signature invalid');
    process.exit(ok ? 0 : 1);
  } else {
    console.error('Usage: rules-sign.mjs keygen|sign|verify ...');
    process.exit(2);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
