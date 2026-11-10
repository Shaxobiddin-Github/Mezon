import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rebuild } from '@electron/rebuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopDir, '..', '..');
const distAppDir = path.join(desktopDir, 'dist-app');
const desktopPkgJson = JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));

const electronVersion = desktopPkgJson.devDependencies?.electron;
if (typeof electronVersion !== 'string' || electronVersion.length === 0) {
  throw new Error('Expected exact electron version in apps/desktop/package.json devDependencies');
}

const WORKSPACE_RUNTIME_PACKAGES = [
  { name: '@mezon/domain', dir: path.join(repoRoot, 'packages', 'domain'), copyDrizzle: false },
  {
    name: '@mezon/contracts',
    dir: path.join(repoRoot, 'packages', 'contracts'),
    copyDrizzle: false,
  },
  { name: '@mezon/drivers', dir: path.join(repoRoot, 'packages', 'drivers'), copyDrizzle: false },
  { name: '@mezon/db-local', dir: path.join(repoRoot, 'packages', 'db-local'), copyDrizzle: true },
  { name: '@mezon/hub', dir: path.join(repoRoot, 'apps', 'hub'), copyDrizzle: false },
];

const WORKSPACE_SEEDS = [desktopDir, ...WORKSPACE_RUNTIME_PACKAGES.map((pkg) => pkg.dir)];

function assertExists(targetPath, label) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(
      `Missing required build output (${label}): ${targetPath}. Run pnpm run build first.`,
    );
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolveDependencyDirUpwards(fromDir, depName) {
  let current = path.resolve(fromDir);
  while (true) {
    const candidate = path.join(current, 'node_modules', ...depName.split('/'));
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      return fs.realpathSync(candidate);
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function copyDirectoryDereferenced(srcDir, destDir) {
  fs.cpSync(srcDir, destDir, {
    recursive: true,
    dereference: true,
    filter: (sourcePath) => {
      const base = path.basename(sourcePath);
      if (sourcePath !== srcDir && base === 'node_modules') {
        return false;
      }
      if (base === '.git' || base === '.turbo') {
        return false;
      }
      return true;
    },
  });
}

function collectRuntimeGraph() {
  const rootNodeModules = path.join(distAppDir, 'node_modules');
  const topLevelAssigned = new Map(); // packageName -> { realDir, targetDir }
  const placedTargetByPair = new Set(); // `${realDir}::${targetDir}`
  const visitedTargets = new Set();
  const queue = [];

  for (const seedDir of WORKSPACE_SEEDS) {
    queue.push({ sourceDir: seedDir, parentTargetNodeModules: rootNodeModules });
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      continue;
    }

    const pkgJsonPath = path.join(current.sourceDir, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) {
      continue;
    }
    const pkgJson = readJson(pkgJsonPath);

    const depEntries = [
      ...Object.keys(pkgJson.dependencies ?? {}).map((name) => ({ name, optional: false })),
      ...Object.keys(pkgJson.optionalDependencies ?? {}).map((name) => ({ name, optional: true })),
    ];

    for (const dep of depEntries) {
      if (dep.name.startsWith('@mezon/') || dep.name === 'electron') {
        continue;
      }

      const realDepDir = resolveDependencyDirUpwards(current.sourceDir, dep.name);
      if (realDepDir === null) {
        if (dep.optional) {
          continue;
        }
        throw new Error(`Unable to locate dependency ${dep.name} from ${current.sourceDir}`);
      }
      const existingTop = topLevelAssigned.get(dep.name);
      let targetDir;

      if (existingTop === undefined) {
        targetDir = path.join(rootNodeModules, ...dep.name.split('/'));
        topLevelAssigned.set(dep.name, { realDir: realDepDir, targetDir });
      } else if (existingTop.realDir === realDepDir) {
        targetDir = existingTop.targetDir;
      } else {
        targetDir = path.join(current.parentTargetNodeModules, ...dep.name.split('/'));
      }

      const pairKey = `${realDepDir}::${targetDir}`;
      if (!placedTargetByPair.has(pairKey)) {
        placedTargetByPair.add(pairKey);
        fs.mkdirSync(path.dirname(targetDir), { recursive: true });
        copyDirectoryDereferenced(realDepDir, targetDir);
      }

      const visitKey = `${realDepDir}::${targetDir}`;
      if (!visitedTargets.has(visitKey)) {
        visitedTargets.add(visitKey);
        queue.push({
          sourceDir: realDepDir,
          parentTargetNodeModules: path.join(targetDir, 'node_modules'),
        });
      }
    }
  }

  return topLevelAssigned;
}

async function main() {
  const desktopDistDir = path.join(desktopDir, 'dist');
  const posDistDir = path.join(repoRoot, 'apps', 'pos', 'dist');
  assertExists(path.join(desktopDistDir, 'main.js'), '@mezon/desktop dist/main.js');
  assertExists(path.join(desktopDistDir, 'preload.cjs'), '@mezon/desktop dist/preload.cjs');
  assertExists(path.join(posDistDir, 'index.html'), '@mezon/pos dist/index.html');

  for (const pkg of WORKSPACE_RUNTIME_PACKAGES) {
    assertExists(path.join(pkg.dir, 'dist', 'index.js'), `${pkg.name} dist/index.js`);
    if (pkg.copyDrizzle) {
      assertExists(path.join(pkg.dir, 'drizzle'), `${pkg.name} drizzle`);
    }
  }

  fs.rmSync(distAppDir, { recursive: true, force: true });
  fs.mkdirSync(distAppDir, { recursive: true });

  fs.cpSync(desktopDistDir, path.join(distAppDir, 'desktop'), {
    recursive: true,
    filter: (sourcePath) => !sourcePath.endsWith('.test.js') && !sourcePath.endsWith('.test.d.ts'),
  });
  fs.cpSync(posDistDir, path.join(distAppDir, 'pos'), { recursive: true });

  const stagedDependencies = {};
  for (const pkg of WORKSPACE_RUNTIME_PACKAGES) {
    const srcPkgJson = readJson(path.join(pkg.dir, 'package.json'));
    const rewrittenPkgJson = {
      ...srcPkgJson,
      dependencies: Object.fromEntries(
        Object.entries(srcPkgJson.dependencies ?? {}).map(([depName, depVersion]) => [
          depName,
          depVersion === 'workspace:*' ? '0.1.0' : depVersion,
        ]),
      ),
    };
    const destPkgDir = path.join(distAppDir, 'node_modules', ...pkg.name.split('/'));
    fs.mkdirSync(destPkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(destPkgDir, 'package.json'),
      `${JSON.stringify(rewrittenPkgJson, null, 2)}\n`,
      'utf8',
    );
    fs.cpSync(path.join(pkg.dir, 'dist'), path.join(destPkgDir, 'dist'), { recursive: true });
    if (pkg.copyDrizzle) {
      fs.cpSync(path.join(pkg.dir, 'drizzle'), path.join(destPkgDir, 'drizzle'), {
        recursive: true,
      });
    }
    stagedDependencies[pkg.name] = srcPkgJson.version ?? '0.1.0';
  }

  const resolvedTopDeps = collectRuntimeGraph();
  for (const [depName, depInfo] of resolvedTopDeps.entries()) {
    const depPkg = readJson(path.join(depInfo.realDir, 'package.json'));
    stagedDependencies[depName] = depPkg.version;
  }

  const betterSqliteInfo = resolvedTopDeps.get('better-sqlite3');
  if (betterSqliteInfo === undefined) {
    throw new Error('better-sqlite3 was not collected in dist-app runtime dependency graph');
  }

  const stagedPackageJson = {
    name: 'mezon',
    productName: 'Mezon',
    version: desktopPkgJson.version,
    private: true,
    type: 'module',
    main: './desktop/main.js',
    dependencies: stagedDependencies,
  };
  fs.writeFileSync(
    path.join(distAppDir, 'package.json'),
    `${JSON.stringify(stagedPackageJson, null, 2)}\n`,
    'utf8',
  );

  const nativeCheckNames = ['better-sqlite3'];
  const modulesNeedingRebuild = [];
  for (const modName of nativeCheckNames) {
    const modDir = path.join(distAppDir, 'node_modules', ...modName.split('/'));
    if (!fs.existsSync(path.join(modDir, 'binding.gyp'))) {
      continue;
    }
    const modPkg = readJson(path.join(modDir, 'package.json'));
    const prebuildPath = path.join(modDir, 'prebuilds', `${process.platform}-${process.arch}.node`);
    const usesNapiPrebuild = modPkg.gypfile === false && fs.existsSync(prebuildPath);
    if (!usesNapiPrebuild) {
      modulesNeedingRebuild.push(modName);
    }
  }

  if (modulesNeedingRebuild.length > 0) {
    console.log(
      `Rebuilding legacy native addons (${modulesNeedingRebuild.join(', ')}) for Electron ${electronVersion} (${process.arch}) in ${distAppDir}...`,
    );
    await rebuild({
      buildPath: distAppDir,
      electronVersion,
      arch: process.arch,
      onlyModules: modulesNeedingRebuild,
    });
  } else {
    console.log(
      `All staged native addons (better-sqlite3@13 N-API, @node-rs/argon2, koffi) use N-API prebuilts; skipping node-gyp.`,
    );
  }

  console.log(`Prepared Electron staging app in ${distAppDir}`);
}

await main();
