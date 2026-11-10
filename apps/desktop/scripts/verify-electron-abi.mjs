import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');
const distAppNodeModules = path.join(desktopDir, 'dist-app', 'node_modules');
const electronExe = require('electron');

const probeScript = `
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function run() {
  const nm = process.env.MEZON_STAGED_NODE_MODULES;
  const Database = require(path.join(nm, 'better-sqlite3'));
  const db = new Database(':memory:');
  const row = db.prepare('SELECT 1 + 1 AS sum').get();
  db.close();

  const argon2 = require(path.join(nm, '@node-rs', 'argon2'));
  const hash = await argon2.hash('1234', { algorithm: 2 });
  const verified = await argon2.verify(hash, '1234');

  const koffi = require(path.join(nm, 'koffi'));
  const koffiVersion = koffi.version;

  console.log(JSON.stringify({
    electron: process.versions.electron,
    node: process.versions.node,
    modules: process.versions.modules,
    chrome: process.versions.chrome,
    arch: process.arch,
    platform: process.platform,
    sqliteCheck: row.sum === 2,
    argon2Check: verified === true && hash.startsWith('$argon2id$'),
    koffiLoaded: typeof koffi.load === 'function',
    koffiVersion,
  }));
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
`;

const result = spawnSync(electronExe, ['-e', probeScript], {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    MEZON_STAGED_NODE_MODULES: distAppNodeModules,
  },
  encoding: 'utf8',
});

if (result.status !== 0) {
  console.error('Electron ABI probe failed:', result.stderr || result.stdout);
  process.exit(result.status ?? 1);
}

const parsed = JSON.parse(result.stdout.trim());
if (!parsed.sqliteCheck || !parsed.argon2Check || !parsed.koffiLoaded) {
  throw new Error(`Native addon check failed inside Electron: ${result.stdout}`);
}

console.log('Electron ABI probe succeeded:', JSON.stringify(parsed, null, 2));
