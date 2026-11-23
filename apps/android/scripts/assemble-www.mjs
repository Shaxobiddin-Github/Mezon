// Assembles the Android web assets: the POS build plus the bridge script, loaded first.
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const posDist = join(root, '..', 'pos', 'dist');
const bridge = join(root, 'dist', 'android-bridge.js');
const www = join(root, 'www');

for (const [path, hint] of [
  [join(posDist, 'index.html'), 'pnpm --filter @mezon/pos build'],
  [bridge, 'pnpm --filter @mezon/android build'],
]) {
  if (!existsSync(path)) throw new Error(`${path} is missing; run: ${hint}`);
}

rmSync(www, { recursive: true, force: true });
cpSync(posDist, www, {
  recursive: true,
  filter: (src) => !src.endsWith('.map'),
});
cpSync(bridge, join(www, 'android-bridge.js'));

const indexPath = join(www, 'index.html');
const html = readFileSync(indexPath, 'utf8');
const tag = '<script src="./android-bridge.js"></script>';
if (!html.includes('<script type="module"')) throw new Error('POS index.html has no module script');
// A classic script before the module script runs first, so window.mezonBridge exists at startup.
writeFileSync(
  indexPath,
  html.replace('<script type="module"', `${tag}\n    <script type="module"`),
);
console.log(`www assembled at ${www}`);
