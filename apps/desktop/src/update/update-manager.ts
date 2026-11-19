import fs from 'node:fs/promises';
import path from 'node:path';
import {
  type Ed25519Verifier,
  type TrustedUpdateKey,
  type UpdateEnvelope,
  compareVersions,
  verifyUpdateEnvelope,
} from './update-manifest.js';

/** What an update would interrupt (answered by the hub worker, see `apps/hub/src/update-readiness.ts`). */
export interface UpdateReadiness {
  readonly openReceipts: number;
  readonly openShifts: number;
  readonly pendingFiscalDocs: number;
}

/** When the cashier wants the update installed. */
export type UpdateSchedule =
  | { readonly kind: 'now' }
  | { readonly kind: 'shift_close' }
  | { readonly kind: 'at'; readonly atMs: string };

export type UpdateWaitReason = 'not_yet' | 'hub_unavailable' | 'open_receipt' | 'open_shift';

export type InstallDecision =
  { readonly install: true } | { readonly install: false; readonly reason: UpdateWaitReason };

/**
 * The single rule of T4.8: an update never starts while a receipt is in progress, whatever was
 * chosen; "when the shift is closed" also waits for every shift to be closed; a chosen time waits
 * for that time. Without an answer from the hub nothing is installed.
 */
export function decideInstall(
  schedule: UpdateSchedule,
  readiness: UpdateReadiness | null,
  nowMs: bigint,
): InstallDecision {
  if (schedule.kind === 'at' && nowMs < BigInt(schedule.atMs)) {
    return { install: false, reason: 'not_yet' };
  }
  if (readiness === null) return { install: false, reason: 'hub_unavailable' };
  if (readiness.openReceipts > 0) return { install: false, reason: 'open_receipt' };
  if (schedule.kind === 'shift_close' && readiness.openShifts > 0) {
    return { install: false, reason: 'open_shift' };
  }
  return { install: true };
}

export type UpdatePhase =
  'disabled' | 'idle' | 'downloading' | 'ready' | 'waiting' | 'installing' | 'error';

export interface UpdateState {
  readonly phase: UpdatePhase;
  readonly currentVersion: string;
  readonly version: string | null;
  readonly notes: string | null;
  readonly schedule: UpdateSchedule | null;
  readonly waitReason: UpdateWaitReason | null;
  readonly error: string | null;
}

export interface UpdateManagerPorts {
  /** GET of the signed envelope (JSON). */
  fetchEnvelope(): Promise<unknown>;
  /** Streams `url` into `destPath`; must stop with an error past `maxBytes`. */
  download(url: string, destPath: string, maxBytes: number): Promise<void>;
  sha256File(filePath: string): Promise<{ readonly sha256: string; readonly sizeBytes: number }>;
  /** Asks the hub what would be interrupted; with `backup`, a backup is taken when nothing blocks. */
  prepare(
    targetVersion: string,
    backup: boolean,
  ): Promise<{ readonly readiness: UpdateReadiness | null; readonly backupId: string | null }>;
  /**
   * Shuts the hub down cleanly, checks the installer once more against `expected` (B3: the last
   * check is right before it is started) and starts it. Throws (and must not start anything) when
   * the file no longer matches.
   */
  launchInstaller(
    installerPath: string,
    expected: { readonly sha256: string; readonly sizeBytes: string },
  ): Promise<void>;
  /** The prepared update will not start now: re-open the hub's update gate (selling continues). */
  cancelPrepared(): void;
  nowMs(): bigint;
}

export interface UpdateManagerOptions {
  readonly dir: string;
  readonly currentVersion: string;
  readonly platform: string;
  readonly channel: string;
  /** No keys or no manifest URL: updates are off (`disabled`). */
  readonly enabled: boolean;
  readonly trustedKeys: readonly TrustedUpdateKey[];
  readonly verifier: Ed25519Verifier;
  readonly ports: UpdateManagerPorts;
  readonly onState?: (state: UpdateState) => void;
}

interface PersistedUpdate {
  readonly envelope: UpdateEnvelope;
  readonly installer: string;
  readonly schedule: UpdateSchedule | null;
}

const STATE_FILE = 'update-state.json';
/** A chosen time must be within this window (a typo must not postpone an update for months). */
const MAX_SCHEDULE_AHEAD_MS = 7n * 86_400_000n;

/**
 * T4.8 desktop update flow: check → download → verify (signature, size, SHA-256) → the cashier
 * picks when → install only when `decideInstall` allows, after a fresh hub backup.
 * The persisted state is re-verified on every start, so a hand-edited file gains nothing.
 */
export class UpdateManager {
  private current: PersistedUpdate | null = null;
  private phase: UpdatePhase;
  private waitReason: UpdateWaitReason | null = null;
  private error: string | null = null;
  private busy = false;

  constructor(private readonly o: UpdateManagerOptions) {
    this.phase = o.enabled ? 'idle' : 'disabled';
  }

  getState(): UpdateState {
    return {
      phase: this.phase,
      currentVersion: this.o.currentVersion,
      version: this.current?.envelope.manifest.version ?? null,
      notes: this.current?.envelope.manifest.notes ?? null,
      schedule: this.current?.schedule ?? null,
      waitReason: this.waitReason,
      error: this.error,
    };
  }

  private emit(): void {
    this.o.onState?.(this.getState());
  }

  private statePath(): string {
    return path.join(this.o.dir, STATE_FILE);
  }

  private verify(raw: unknown): UpdateEnvelope {
    return verifyUpdateEnvelope(
      raw,
      {
        currentVersion: this.o.currentVersion,
        platform: this.o.platform,
        channel: this.o.channel,
      },
      this.o.trustedKeys,
      this.o.verifier,
    );
  }

  private async persist(): Promise<void> {
    await fs.mkdir(this.o.dir, { recursive: true });
    const tmp = `${this.statePath()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.current), 'utf8');
    await fs.rename(tmp, this.statePath());
  }

  private async clear(): Promise<void> {
    if (this.current) await fs.rm(this.current.installer, { force: true });
    this.current = null;
    await fs.rm(this.statePath(), { force: true });
  }

  /** Is the installer on disk exactly the one the manifest names? */
  private async installerMatches(env: UpdateEnvelope, file: string): Promise<boolean> {
    try {
      const h = await this.o.ports.sha256File(file);
      return h.sha256 === env.manifest.sha256 && String(h.sizeBytes) === env.manifest.sizeBytes;
    } catch {
      return false;
    }
  }

  private installerPath(version: string): string {
    return path.join(this.o.dir, `mezon-setup-${version}.exe`);
  }

  /** Restores a downloaded update after a restart; drops it when installed, stale or tampered. */
  async init(): Promise<void> {
    if (!this.o.enabled) return;
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(this.statePath(), 'utf8'));
    } catch {
      return;
    }
    try {
      const rec = raw as { envelope?: unknown; schedule?: unknown };
      const envelope = this.verify(rec.envelope);
      const installer = this.installerPath(envelope.manifest.version);
      if (!(await this.installerMatches(envelope, installer))) throw new Error('installer changed');
      this.current = { envelope, installer, schedule: parseSchedule(rec.schedule) };
      this.phase = this.current.schedule ? 'waiting' : 'ready';
    } catch {
      // Installed already (not newer any more), a foreign/tampered file, or a missing installer.
      await fs.rm(this.statePath(), { force: true });
      await this.removeStaleInstallers();
    }
    this.emit();
  }

  private async removeStaleInstallers(): Promise<void> {
    let names: string[] = [];
    try {
      names = await fs.readdir(this.o.dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (/^mezon-setup-.*\.exe(\.part)?$/.test(n)) {
        await fs.rm(path.join(this.o.dir, n), { force: true });
      }
    }
  }

  /** Looks for a newer signed version and downloads it. Never throws. */
  async check(): Promise<void> {
    if (!this.o.enabled || this.busy || this.phase === 'installing') return;
    this.busy = true;
    try {
      const envelope = this.verify(await this.o.ports.fetchEnvelope());
      const m = envelope.manifest;
      if (this.current && compareVersions(m.version, this.current.envelope.manifest.version) <= 0) {
        return; // Already have this (or a newer) one.
      }
      this.phase = 'downloading';
      this.error = null;
      this.emit();
      await fs.mkdir(this.o.dir, { recursive: true });
      const target = this.installerPath(m.version);
      const part = `${target}.part`;
      await fs.rm(part, { force: true });
      await this.o.ports.download(m.url, part, Number(m.sizeBytes));
      if (!(await this.installerMatches(envelope, part))) {
        await fs.rm(part, { force: true });
        throw new Error('Downloaded installer does not match the signed manifest');
      }
      await fs.rename(part, target);
      if (this.current) await fs.rm(this.current.installer, { force: true });
      this.current = { envelope, installer: target, schedule: null };
      await this.persist();
      this.phase = 'ready';
      this.waitReason = null;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.phase = this.current ? (this.current.schedule ? 'waiting' : 'ready') : 'error';
    } finally {
      this.busy = false;
      this.emit();
    }
  }

  /** The cashier's choice. Returns false when there is nothing to schedule or the time is invalid. */
  async schedule(choice: UpdateSchedule): Promise<boolean> {
    if (!this.current || this.phase === 'installing') return false;
    const parsed = parseSchedule(choice);
    if (parsed === null) return false;
    if (parsed.kind === 'at') {
      const at = BigInt(parsed.atMs);
      const now = this.o.ports.nowMs();
      if (at <= now || at - now > MAX_SCHEDULE_AHEAD_MS) return false;
    }
    this.current = { ...this.current, schedule: parsed };
    await this.persist();
    this.phase = 'waiting';
    this.waitReason = null;
    this.emit();
    await this.tick();
    return true;
  }

  async cancelSchedule(): Promise<void> {
    if (!this.current || this.phase === 'installing') return;
    this.current = { ...this.current, schedule: null };
    await this.persist();
    this.phase = 'ready';
    this.waitReason = null;
    this.emit();
  }

  /**
   * Called periodically (and right after a choice). Installs only when allowed; the check is made
   * twice — the second time together with the backup — and the installer hash is checked again
   * right before it is started.
   */
  async tick(): Promise<void> {
    const cur = this.current;
    if (!cur?.schedule || this.busy || this.phase === 'installing') return;
    this.busy = true;
    let prepared = false;
    try {
      const version = cur.envelope.manifest.version;
      const now = this.o.ports.nowMs();
      let decision = decideInstall(cur.schedule, null, now);
      if (!(decision.install === false && decision.reason === 'not_yet')) {
        const first = await this.o.ports.prepare(version, false);
        decision = decideInstall(cur.schedule, first.readiness, now);
      }
      if (decision.install) {
        if (!(await this.installerMatches(cur.envelope, cur.installer))) {
          await this.clear();
          this.phase = 'error';
          this.error = 'Installer file changed on disk; it was removed';
          return;
        }
        const second = await this.o.ports.prepare(version, true);
        prepared = second.backupId !== null;
        decision = decideInstall(cur.schedule, second.readiness, now);
        if (decision.install && second.backupId === null) {
          decision = { install: false, reason: 'hub_unavailable' };
        }
      }
      if (!decision.install) {
        if (prepared) this.o.ports.cancelPrepared();
        this.phase = 'waiting';
        this.waitReason = decision.reason;
        return;
      }
      this.phase = 'installing';
      this.waitReason = null;
      this.emit();
      await this.o.ports.launchInstaller(cur.installer, {
        sha256: cur.envelope.manifest.sha256,
        sizeBytes: cur.envelope.manifest.sizeBytes,
      });
    } catch (err) {
      if (prepared) this.o.ports.cancelPrepared();
      this.error = err instanceof Error ? err.message : String(err);
      if (this.phase === 'installing') this.phase = 'waiting';
    } finally {
      this.busy = false;
      this.emit();
    }
  }
}

function parseSchedule(raw: unknown): UpdateSchedule | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.kind === 'now') return { kind: 'now' };
  if (r.kind === 'shift_close') return { kind: 'shift_close' };
  if (r.kind === 'at' && typeof r.atMs === 'string' && /^[1-9]\d{0,15}$/.test(r.atMs)) {
    return { kind: 'at', atMs: r.atMs };
  }
  return null;
}
