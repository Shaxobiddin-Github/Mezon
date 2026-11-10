import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(import.meta.dirname, '..');
const eslintBin = path.join(rootDir, 'node_modules', 'eslint', 'bin', 'eslint.js');

function listWorkspaceDirs(parent) {
  const full = path.join(rootDir, parent);
  if (!fs.existsSync(full)) {
    return [];
  }
  return fs
    .readdirSync(full, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => `${parent}/${d.name}`)
    .sort();
}

const rootTargets = fs
  .readdirSync(rootDir, { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isFile() && /\.(?:[cm]?ts|tsx|[cm]?js)$/.test(entry.name) && entry.name !== '.git',
  )
  .map((entry) => entry.name)
  .sort();

const workspaceDirs = [...listWorkspaceDirs('packages'), ...listWorkspaceDirs('apps')];

if (fs.existsSync(path.join(rootDir, 'scripts'))) {
  rootTargets.push('scripts');
}

// Run ESLint in bounded workspace batches so typescript-eslint never holds all ~28 TS programs
// simultaneously above Node's 2 GB default V8 heap limit on CI runners.
const BATCH_SIZE = 3;
const batches = [];

if (rootTargets.length > 0) {
  batches.push({ scope: '.', targets: rootTargets });
}

for (let i = 0; i < workspaceDirs.length; i += BATCH_SIZE) {
  const chunk = workspaceDirs.slice(i, i + BATCH_SIZE);
  batches.push({ scope: chunk.join(','), targets: chunk });
}

const extraArgs = process.argv.slice(2);

for (const batch of batches) {
  const res = spawnSync(
    process.execPath,
    [eslintBin, '--no-warn-ignored', ...extraArgs, ...batch.targets],
    {
      cwd: rootDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        MEZON_LINT_PROJECTS: batch.scope,
      },
    },
  );
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }
}
