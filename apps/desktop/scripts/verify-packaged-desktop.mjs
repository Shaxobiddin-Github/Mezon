import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');
const unpackedDir = path.join(desktopDir, 'dist-electron', 'win-unpacked');
const exePath = path.join(unpackedDir, 'Mezon.exe');
const appAsarPath = path.join(unpackedDir, 'resources', 'app.asar');

async function verifyFuses() {
  assert.ok(fs.existsSync(exePath), `Missing packaged exe: ${exePath}`);
  assert.ok(fs.existsSync(appAsarPath), `Missing packaged app.asar: ${appAsarPath}`);

  const wire = await getCurrentFuseWire(exePath);
  const expected = {
    [FuseV1Options.RunAsNode]: FuseState.DISABLE,
    [FuseV1Options.EnableCookieEncryption]: FuseState.ENABLE,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: FuseState.DISABLE,
    [FuseV1Options.EnableNodeCliInspectArguments]: FuseState.DISABLE,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: FuseState.ENABLE,
    [FuseV1Options.OnlyLoadAppFromAsar]: FuseState.ENABLE,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: FuseState.DISABLE,
  };

  for (const [optionKey, expectedState] of Object.entries(expected)) {
    assert.equal(
      wire[optionKey],
      expectedState,
      `Fuse option ${optionKey} mismatch: expected=${expectedState}, actual=${wire[optionKey]}`,
    );
  }
  console.log('Verified all production fuse bits on packaged Mezon.exe:', wire);
}

async function runWithTimeout(exe, args, extraEnv, timeoutMs) {
  return await new Promise((resolve) => {
    const child = spawn(exe, args, {
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    const timer = setTimeout(() => {
      try {
        if (process.platform === 'win32' && child.pid !== undefined) {
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        // Ignore cleanup errors.
      }
    }, timeoutMs);

    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function terminateProcessTree(child) {
  if (child.exitCode === null) {
    if (process.platform === 'win32' && child.pid !== undefined) {
      await new Promise((resolve) => {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        killer.on('exit', () => resolve());
      });
    } else {
      child.kill('SIGKILL');
    }
    await new Promise((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      child.once('exit', () => resolve());
      setTimeout(resolve, 2000);
    });
  }
}

async function waitForCondition(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
}

function readReadyHubInfo(desktopLogPath) {
  if (!fs.existsSync(desktopLogPath)) {
    return null;
  }
  const lines = fs
    .readFileSync(desktopLogPath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed.msg === 'desktop_hub_ready' && typeof parsed.baseUrl === 'string') {
        return parsed;
      }
    } catch {
      // Ignore partial log line while flushing.
    }
  }
  return null;
}

async function verifyBlockedFusedFlags(tempRoot) {
  const isolatedLocalAppData = path.join(tempRoot, 'flag-check-localappdata');
  fs.mkdirSync(isolatedLocalAppData, { recursive: true });

  const runAsNodeAttempt = await runWithTimeout(
    exePath,
    ['-e', 'console.log("MEZON_RUN_AS_NODE_BYPASSED")'],
    {
      ELECTRON_RUN_AS_NODE: '1',
      LOCALAPPDATA: isolatedLocalAppData,
      MEZON_E2E: '1',
    },
    3000,
  );
  assert.ok(
    !runAsNodeAttempt.stdout.includes('MEZON_RUN_AS_NODE_BYPASSED'),
    `ELECTRON_RUN_AS_NODE was not blocked by fuse: stdout=${runAsNodeAttempt.stdout}`,
  );
  console.log('Verified ELECTRON_RUN_AS_NODE=1 is refused on fused Mezon.exe');

  const inspectAttempt = await runWithTimeout(
    exePath,
    ['--inspect=0', '--inspect-brk=0'],
    {
      LOCALAPPDATA: isolatedLocalAppData,
      MEZON_E2E: '1',
    },
    3000,
  );
  assert.ok(
    !/Debugger listening on ws:/i.test(inspectAttempt.stderr + inspectAttempt.stdout),
    `--inspect opened a Node debugger despite fuse: stderr=${inspectAttempt.stderr}`,
  );
  console.log('Verified --inspect argument is refused on fused Mezon.exe');
}

async function verifyPackagedFusedSmokeLaunch(tempRoot) {
  // T5 & T2: Launch final fused packaged Mezon.exe WITHOUT Playwright,
  // setting BOTH MEZON_E2E=1 and a decoy MEZON_DATA_DIR alongside isolated LOCALAPPDATA.
  // Packaged binary MUST ignore MEZON_DATA_DIR and persist DB/logs under LOCALAPPDATA\Mezon.
  const isolatedLocalAppData = path.join(tempRoot, 'smoke-localappdata');
  const decoyDataDir = path.join(tempRoot, 'decoy-must-stay-unused');
  fs.mkdirSync(isolatedLocalAppData, { recursive: true });

  const expectedDataDir = path.join(isolatedLocalAppData, 'Mezon');
  const expectedDbPath = path.join(expectedDataDir, 'data', 'mezon.db');
  const desktopLogPath = path.join(expectedDataDir, 'logs', 'mezon-desktop.log');
  const hubLogPath = path.join(expectedDataDir, 'logs', 'mezon-hub.log');

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.LOCALAPPDATA = isolatedLocalAppData;
  env.MEZON_E2E = '1';
  env.MEZON_DATA_DIR = decoyDataDir;

  const child = spawn(exePath, [], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  try {
    const readyInfo = await waitForCondition(
      () => readReadyHubInfo(desktopLogPath),
      15000,
      `fused packaged Hub ready in ${desktopLogPath} (stderr=${stderr})`,
    );

    assert.equal(
      fs.existsSync(decoyDataDir),
      false,
      'Packaged build MUST ignore MEZON_DATA_DIR (T5)',
    );
    assert.ok(fs.existsSync(expectedDbPath), `Expected SQLite DB at ${expectedDbPath}`);
    assert.ok(fs.existsSync(hubLogPath), `Expected Hub log at ${hubLogPath}`);

    const healthResponse = await fetch(`${readyInfo.baseUrl}/health`, {
      headers: { Origin: 'app://mezon' },
    });
    assert.equal(healthResponse.status, 200);
    const body = await healthResponse.json();
    assert.deepEqual(body, { status: 'ok', service: '@mezon/hub', needsSetup: true });

    // Second launch must exit due to single-instance lock without opening another DB/Hub.
    const secondLaunch = await runWithTimeout(exePath, [], env, 6000);
    assert.equal(secondLaunch.code, 0, 'Second packaged instance should exit cleanly on lock');
    const logAfterSecond = fs.readFileSync(desktopLogPath, 'utf8');
    assert.ok(
      logAfterSecond.includes('desktop_second_instance_focused'),
      'Primary fused instance should log second-instance focus',
    );

    console.log(
      `Verified Playwright-free fused smoke launch: DB=${expectedDbPath}, Hub=${readyInfo.baseUrl}, T5 decoy ignored.`,
    );
  } finally {
    await terminateProcessTree(child);
  }
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-fused-verify-'));
  try {
    await verifyFuses();
    await verifyBlockedFusedFlags(tempRoot);
    await verifyPackagedFusedSmokeLaunch(tempRoot);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

await main();
