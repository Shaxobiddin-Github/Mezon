import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type UpdateManifest,
  buildUpdateSigningMessage,
  compareVersions,
  nodeEd25519UpdateVerifier,
  verifyUpdateEnvelope,
} from './update-manifest.js';
import {
  type UpdateReadiness,
  type UpdateSchedule,
  UpdateManager,
  decideInstall,
} from './update-manager.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const PUB = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer)
  .subarray(-32)
  .toString('base64');
const KEYS = [{ keyId: 'u1', publicKeyB64: PUB }];
const INSTALLER = Buffer.from('MZ fake installer bytes');
const SHA = createHash('sha256').update(INSTALLER).digest('hex');
const EXPECT = { currentVersion: '1.2.0', platform: 'win32-x64', channel: 'stable' };

function manifest(over: Partial<UpdateManifest> = {}): UpdateManifest {
  return {
    version: '1.3.0',
    platform: 'win32-x64',
    channel: 'stable',
    url: 'https://updates.example.test/mezon-setup-1.3.0.exe',
    sha256: SHA,
    sizeBytes: String(INSTALLER.length),
    releasedAtMs: '1795000000000',
    notes: 'Tuzatishlar',
    ...over,
  };
}

function envelope(m: UpdateManifest, keyId = 'u1') {
  const signature = sign(
    null,
    Buffer.from(buildUpdateSigningMessage(keyId, m), 'utf8'),
    privateKey,
  ).toString('base64');
  return { manifest: m, keyId, signature };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const FREE: UpdateReadiness = { openReceipts: 0, openShifts: 0, pendingFiscalDocs: 0 };

function setup(
  opts: {
    env?: unknown;
    body?: Buffer;
    readiness?: () => UpdateReadiness | null;
    now?: bigint;
    dir?: string;
  } = {},
) {
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-update-'));
  if (!opts.dir) dirs.push(dir);
  const log: string[] = [];
  let now = opts.now ?? 1_795_000_000_000n;
  let env: unknown = opts.env ?? envelope(manifest());
  let body = opts.body ?? INSTALLER;
  const readiness = { fn: opts.readiness ?? (() => FREE) };
  const launchFails = { v: false };
  const mgr = new UpdateManager({
    dir,
    ...EXPECT,
    enabled: true,
    trustedKeys: KEYS,
    verifier: nodeEd25519UpdateVerifier,
    ports: {
      fetchEnvelope: () => Promise.resolve(env),
      download: (url, dest) => {
        log.push(`download ${url}`);
        fs.writeFileSync(dest, body);
        return Promise.resolve();
      },
      sha256File: (file) => {
        const b = fs.readFileSync(file);
        return Promise.resolve({
          sha256: createHash('sha256').update(b).digest('hex'),
          sizeBytes: b.length,
        });
      },
      prepare: (v, backup) => {
        const r = readiness.fn();
        log.push(`prepare ${v} backup=${String(backup)}`);
        return Promise.resolve({
          readiness: r,
          backupId: backup && r !== null && r.openReceipts === 0 ? 'backup-1' : null,
        });
      },
      launchInstaller: (p, expected) => {
        if (launchFails.v) return Promise.reject(new Error('installer did not start'));
        log.push(`install ${path.basename(p)} ${expected.sha256 === SHA ? 'sha-ok' : 'sha-bad'}`);
        return Promise.resolve();
      },
      cancelPrepared: () => {
        log.push('cancel');
      },
      nowMs: () => now,
    },
  });
  return {
    mgr,
    dir,
    log,
    readiness,
    launchFails,
    setNow: (n: bigint) => (now = n),
    setEnv: (e: unknown) => (env = e),
    setBody: (b: Buffer) => (body = b),
  };
}

describe('@mezon/desktop - signed update manifest (T4.8)', () => {
  it('accepts only a correctly signed, newer manifest for this platform and channel', () => {
    const good = envelope(manifest());
    expect(
      verifyUpdateEnvelope(good, EXPECT, KEYS, nodeEd25519UpdateVerifier).manifest.version,
    ).toBe('1.3.0');
    const swapped = { ...good, manifest: { ...good.manifest, url: 'https://evil.test/x.exe' } };
    expect(() => verifyUpdateEnvelope(swapped, EXPECT, KEYS, nodeEd25519UpdateVerifier)).toThrow(
      /signature/,
    );
    const otherHash = { ...good, manifest: { ...good.manifest, sha256: 'a'.repeat(64) } };
    expect(() => verifyUpdateEnvelope(otherHash, EXPECT, KEYS, nodeEd25519UpdateVerifier)).toThrow(
      /signature/,
    );
    expect(() =>
      verifyUpdateEnvelope(envelope(manifest(), 'x'), EXPECT, KEYS, nodeEd25519UpdateVerifier),
    ).toThrow(/Unknown update key/);
    expect(() =>
      verifyUpdateEnvelope(
        envelope(manifest({ version: '1.2.0' })),
        EXPECT,
        KEYS,
        nodeEd25519UpdateVerifier,
      ),
    ).toThrow(/not newer/);
    expect(() =>
      verifyUpdateEnvelope(
        envelope(manifest({ version: '1.1.9' })),
        EXPECT,
        KEYS,
        nodeEd25519UpdateVerifier,
      ),
    ).toThrow(/not newer/);
    expect(() =>
      verifyUpdateEnvelope(
        envelope(manifest({ platform: 'linux-x64' })),
        EXPECT,
        KEYS,
        nodeEd25519UpdateVerifier,
      ),
    ).toThrow(/linux-x64/);
    expect(() =>
      verifyUpdateEnvelope(
        envelope(manifest({ channel: 'beta' })),
        EXPECT,
        KEYS,
        nodeEd25519UpdateVerifier,
      ),
    ).toThrow(/channel/);
    expect(() =>
      verifyUpdateEnvelope(
        envelope(manifest({ url: 'http://updates.example.test/a.exe' })),
        EXPECT,
        KEYS,
        nodeEd25519UpdateVerifier,
      ),
    ).toThrow(/https/);
    expect(() =>
      verifyUpdateEnvelope({ ...good, extra: 1 }, EXPECT, KEYS, nodeEd25519UpdateVerifier),
    ).toThrow(/unknown field/);
    expect(() => verifyUpdateEnvelope(good, EXPECT, [], nodeEd25519UpdateVerifier)).toThrow(
      /Unknown update key/,
    );
  });

  it('compares versions numerically', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
    expect(compareVersions('0.9.0', '1.0.0')).toBe(-1);
    expect(() => compareVersions('1.0', '1.0.0')).toThrow();
  });
});

describe('@mezon/desktop - install decision (T4.8)', () => {
  const now = 1_000n;
  const r = (o: Partial<UpdateReadiness>): UpdateReadiness => ({ ...FREE, ...o });
  const cases: [UpdateSchedule, UpdateReadiness | null, string][] = [
    [{ kind: 'now' }, r({}), 'install'],
    [{ kind: 'now' }, r({ openShifts: 2, pendingFiscalDocs: 5 }), 'install'],
    [{ kind: 'now' }, r({ openReceipts: 1 }), 'open_receipt'],
    [{ kind: 'now' }, null, 'hub_unavailable'],
    [{ kind: 'shift_close' }, r({ openShifts: 1 }), 'open_shift'],
    [{ kind: 'shift_close' }, r({ openReceipts: 1, openShifts: 1 }), 'open_receipt'],
    [{ kind: 'shift_close' }, r({}), 'install'],
    [{ kind: 'at', atMs: '1001' }, r({}), 'not_yet'],
    [{ kind: 'at', atMs: '1000' }, r({ openShifts: 1 }), 'install'],
    [{ kind: 'at', atMs: '999' }, r({ openReceipts: 3 }), 'open_receipt'],
  ];
  it.each(cases)('%j with %j → %s', (schedule, readiness, expected) => {
    const d = decideInstall(schedule, readiness, now);
    expect(d.install ? 'install' : d.reason).toBe(expected);
  });
});

describe('@mezon/desktop - update manager (T4.8)', () => {
  it('downloads a verified update; installs only after the receipt is closed, with a backup first', async () => {
    const t = setup();
    await t.mgr.check();
    expect(t.mgr.getState()).toMatchObject({ phase: 'ready', version: '1.3.0' });
    expect(t.log).toEqual(['download https://updates.example.test/mezon-setup-1.3.0.exe']);

    t.readiness.fn = () => ({ ...FREE, openReceipts: 1 });
    expect(await t.mgr.schedule({ kind: 'now' })).toBe(true);
    expect(t.mgr.getState()).toMatchObject({ phase: 'waiting', waitReason: 'open_receipt' });
    expect(t.log.some((l) => l.startsWith('install'))).toBe(false);

    t.readiness.fn = () => FREE;
    await t.mgr.tick();
    expect(t.mgr.getState().phase).toBe('installing');
    expect(t.log.slice(-3)).toEqual([
      'prepare 1.3.0 backup=false',
      'prepare 1.3.0 backup=true',
      'install mezon-setup-1.3.0.exe sha-ok',
    ]);
  });

  it('B1/B3: when the prepared install does not start, the hub gate is re-opened', async () => {
    const t = setup();
    await t.mgr.check();
    t.launchFails.v = true;
    await t.mgr.schedule({ kind: 'now' });
    expect(t.mgr.getState().phase).toBe('waiting');
    expect(t.log.slice(-2)).toEqual(['prepare 1.3.0 backup=true', 'cancel']);

    // A shift opened during the backup: "when the shift is closed" waits and re-opens the gate.
    const u = setup();
    await u.mgr.check();
    let calls = 0;
    u.readiness.fn = () => (++calls === 1 ? FREE : { ...FREE, openShifts: 1 });
    await u.mgr.schedule({ kind: 'shift_close' });
    expect(u.mgr.getState().waitReason).toBe('open_shift');
    expect(u.log.at(-1)).toBe('cancel');
    expect(u.log.some((l) => l.startsWith('install'))).toBe(false);
  });

  it('a receipt opened between the two checks still stops the install', async () => {
    const t = setup();
    await t.mgr.check();
    let calls = 0;
    t.readiness.fn = () => (++calls === 1 ? FREE : { ...FREE, openReceipts: 1 });
    await t.mgr.schedule({ kind: 'now' });
    expect(t.mgr.getState()).toMatchObject({ phase: 'waiting', waitReason: 'open_receipt' });
    expect(t.log.some((l) => l.startsWith('install'))).toBe(false);
  });

  it('no backup, no install: a failed pre-update backup keeps the update waiting', async () => {
    const t = setup();
    await t.mgr.check();
    // The hub says nothing blocks, but the backup could not be taken (e.g. disk full).
    const mgr = t.mgr as unknown as { o: { ports: { prepare: unknown } } };
    mgr.o.ports.prepare = () => Promise.resolve({ readiness: FREE, backupId: null });
    await t.mgr.schedule({ kind: 'now' });
    expect(t.mgr.getState()).toMatchObject({ phase: 'waiting', waitReason: 'hub_unavailable' });
    expect(t.log.some((l) => l.startsWith('install'))).toBe(false);
  });

  it('"when the shift is closed" and a chosen time wait as the cashier asked', async () => {
    const t = setup();
    await t.mgr.check();
    t.readiness.fn = () => ({ ...FREE, openShifts: 1 });
    await t.mgr.schedule({ kind: 'shift_close' });
    expect(t.mgr.getState().waitReason).toBe('open_shift');
    t.readiness.fn = () => FREE;
    await t.mgr.tick();
    expect(t.mgr.getState().phase).toBe('installing');

    const u = setup();
    await u.mgr.check();
    const at = 1_795_000_000_000n + 3_600_000n;
    await u.mgr.schedule({ kind: 'at', atMs: String(at) });
    expect(u.mgr.getState().waitReason).toBe('not_yet');
    expect(u.log.filter((l) => l.startsWith('prepare'))).toHaveLength(0);
    u.setNow(at);
    await u.mgr.tick();
    expect(u.mgr.getState().phase).toBe('installing');
  });

  it('refuses a time in the past or more than a week ahead', async () => {
    const t = setup();
    await t.mgr.check();
    expect(await t.mgr.schedule({ kind: 'at', atMs: '1794999999999' })).toBe(false);
    expect(
      await t.mgr.schedule({ kind: 'at', atMs: String(1_795_000_000_000n + 8n * 86_400_000n) }),
    ).toBe(false);
    expect(t.mgr.getState().phase).toBe('ready');
  });

  it('a download that does not match the signed hash is deleted and never offered', async () => {
    const t = setup({ body: Buffer.from('tampered installer') });
    await t.mgr.check();
    expect(t.mgr.getState()).toMatchObject({ phase: 'error', version: null });
    expect(fs.readdirSync(t.dir).filter((n) => n.includes('mezon-setup'))).toEqual([]);
    expect(await t.mgr.schedule({ kind: 'now' })).toBe(false);
  });

  it('an installer swapped on disk after the download is removed instead of started', async () => {
    const t = setup();
    await t.mgr.check();
    fs.writeFileSync(path.join(t.dir, 'mezon-setup-1.3.0.exe'), 'swapped');
    await t.mgr.schedule({ kind: 'now' });
    expect(t.mgr.getState().phase).toBe('error');
    expect(t.log.some((l) => l.startsWith('install'))).toBe(false);
    expect(fs.existsSync(path.join(t.dir, 'mezon-setup-1.3.0.exe'))).toBe(false);
  });

  it('a forged or old manifest from the server changes nothing', async () => {
    const t = setup();
    await t.mgr.check();
    const forged = envelope(manifest({ version: '9.0.0' }));
    t.setEnv({ ...forged, manifest: { ...forged.manifest, version: '9.9.9' } });
    await t.mgr.check();
    expect(t.mgr.getState()).toMatchObject({ phase: 'ready', version: '1.3.0' });
    expect(t.mgr.getState().error).toMatch(/signature/);
    t.setEnv(envelope(manifest({ version: '1.1.0' })));
    await t.mgr.check();
    expect(t.mgr.getState().version).toBe('1.3.0');
    expect(t.log.filter((l) => l.startsWith('download'))).toHaveLength(1);
  });

  it('the choice survives a restart; a hand-edited state file is dropped', async () => {
    const t = setup();
    await t.mgr.check();
    t.readiness.fn = () => ({ ...FREE, openShifts: 1 });
    await t.mgr.schedule({ kind: 'shift_close' });

    const again = setup({ dir: t.dir });
    await again.mgr.init();
    expect(again.mgr.getState()).toMatchObject({
      phase: 'waiting',
      version: '1.3.0',
      schedule: { kind: 'shift_close' },
    });

    const file = path.join(t.dir, 'update-state.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      envelope: { manifest: Record<string, string> };
    };
    saved.envelope.manifest.url = 'https://evil.test/x.exe';
    fs.writeFileSync(file, JSON.stringify(saved));
    const third = setup({ dir: t.dir });
    await third.mgr.init();
    expect(third.mgr.getState()).toMatchObject({ phase: 'idle', version: null });
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readdirSync(t.dir).filter((n) => n.includes('mezon-setup'))).toEqual([]);
  });

  it('after the update is installed (running version caught up) the leftovers are removed', async () => {
    const t = setup();
    await t.mgr.check();
    const after = new UpdateManager({
      dir: t.dir,
      ...EXPECT,
      currentVersion: '1.3.0',
      enabled: true,
      trustedKeys: KEYS,
      verifier: nodeEd25519UpdateVerifier,
      ports: {
        fetchEnvelope: () => Promise.reject(new Error('offline')),
        download: () => Promise.reject(new Error('no')),
        sha256File: () => Promise.reject(new Error('no')),
        prepare: () => Promise.resolve({ readiness: null, backupId: null }),
        launchInstaller: () => Promise.reject(new Error('no')),
        cancelPrepared: () => undefined,
        nowMs: () => 0n,
      },
    });
    await after.init();
    expect(after.getState()).toMatchObject({ phase: 'idle', version: null });
    expect(fs.readdirSync(t.dir)).toEqual([]);
  });

  it('disabled without trusted keys: nothing is fetched', async () => {
    let fetched = 0;
    const mgr = new UpdateManager({
      dir: os.tmpdir(),
      ...EXPECT,
      enabled: false,
      trustedKeys: [],
      verifier: nodeEd25519UpdateVerifier,
      ports: {
        fetchEnvelope: () => {
          fetched += 1;
          return Promise.resolve({});
        },
        download: () => Promise.resolve(),
        sha256File: () => Promise.resolve({ sha256: '', sizeBytes: 0 }),
        prepare: () => Promise.resolve({ readiness: null, backupId: null }),
        launchInstaller: () => Promise.resolve(),
        cancelPrepared: () => undefined,
        nowMs: () => 0n,
      },
    });
    await mgr.check();
    expect(mgr.getState().phase).toBe('disabled');
    expect(fetched).toBe(0);
  });
});
