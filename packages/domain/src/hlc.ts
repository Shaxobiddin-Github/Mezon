import { MAX_UNIX_MS, type Clock, type UnixMs, unixMsFromBigInt } from './clock.js';
import { DomainError } from './errors.js';
import { type UuidV7, parseUuidV7 } from './uuidv7.js';

export const DEFAULT_HLC_MAX_SKEW_MS = 300_000n; // 5 minutes (GEMINI.md Section 4)
export const MAX_HLC_COUNTER = 65535;
export const HLC_STRING_LENGTH = 58; // 15 (ms) + 1 (:) + 5 (logical) + 1 (:) + 36 (UUIDv7)

const HLC_STRING_REGEX = /^([0-9]{15}):([0-9]{5}):(.{36})$/;
const MAX_UNIX_MS_RAW = MAX_UNIX_MS as bigint;

export interface HlcTimestamp {
  readonly physicalMs: UnixMs;
  readonly logical: number;
  readonly nodeId: UuidV7;
}

export interface HlcState extends HlcTimestamp {
  readonly borrowedMs: bigint;
}

export interface HlcNowResult {
  readonly hlc: HlcTimestamp;
  readonly counterOverflow: boolean;
  readonly borrowedMs: bigint;
}

export interface HlcReceiveResult {
  readonly hlc: HlcTimestamp;
  readonly skewClamped: boolean;
  readonly skewMs: bigint;
  readonly counterOverflow: boolean;
  readonly borrowedMs: bigint;
}

export interface HlcClockOptions {
  readonly clock: Clock;
  readonly nodeId: UuidV7;
  readonly maxSkewMs?: bigint;
  readonly initial?: HlcTimestamp;
}

function validateLogicalCounter(logical: number): number {
  if (
    typeof logical !== 'number' ||
    logical < 0 ||
    logical > MAX_HLC_COUNTER ||
    logical % 1 !== 0 ||
    (logical === 0 && 1 / logical < 0)
  ) {
    throw new DomainError('INVALID_HLC_COUNTER');
  }
  return logical;
}

function validateHlcTimestamp(value: HlcTimestamp): HlcTimestamp {
  if (typeof value !== 'object' || value === null) {
    throw new DomainError('INVALID_HLC_FORMAT');
  }
  const physicalMs = unixMsFromBigInt(value.physicalMs);
  const logical = validateLogicalCounter(value.logical);
  const nodeId = parseUuidV7(value.nodeId);
  return { physicalMs, logical, nodeId };
}

export function createHlcTimestamp(
  physicalMs: UnixMs,
  logical: number,
  nodeId: UuidV7,
): HlcTimestamp {
  return validateHlcTimestamp({ physicalMs, logical, nodeId });
}

/**
 * Serializes an HLC timestamp to a fixed 58-character lexicographically sortable ASCII string:
 * `<15-digit decimal ms>:<5-digit decimal counter>:<36-char canonical lowercase UUIDv7>`.
 */
export function serializeHlc(hlc: HlcTimestamp): string {
  const valid = validateHlcTimestamp(hlc);
  const msStr = (valid.physicalMs as bigint).toString().padStart(15, '0');
  const logicalStr = valid.logical.toString().padStart(5, '0');
  return `${msStr}:${logicalStr}:${valid.nodeId}`;
}

export function parseHlc(raw: string): HlcTimestamp {
  if (typeof raw !== 'string' || raw.length !== HLC_STRING_LENGTH) {
    throw new DomainError('INVALID_HLC_FORMAT');
  }
  const match = HLC_STRING_REGEX.exec(raw);
  if (!match) {
    throw new DomainError('INVALID_HLC_FORMAT');
  }
  const physicalMs = unixMsFromBigInt(BigInt(match[1]));
  let logical = 0;
  for (let i = 0; i < 5; i++) {
    logical = logical * 10 + (match[2].charCodeAt(i) - 48);
  }
  validateLogicalCounter(logical);
  const nodeId = parseUuidV7(match[3]);
  return { physicalMs, logical, nodeId };
}

/**
 * Deterministic total order on HLC timestamps: `(physicalMs, logical, nodeId)`.
 * Ties on `(physicalMs, logical)` break deterministically by ASCII code-unit order of `nodeId`.
 */
export function compareHlc(a: HlcTimestamp, b: HlcTimestamp): -1 | 0 | 1 {
  const va = validateHlcTimestamp(a);
  const vb = validateHlcTimestamp(b);

  const aMs = va.physicalMs as bigint;
  const bMs = vb.physicalMs as bigint;
  if (aMs < bMs) return -1;
  if (aMs > bMs) return 1;

  if (va.logical < vb.logical) return -1;
  if (va.logical > vb.logical) return 1;

  if (va.nodeId < vb.nodeId) return -1;
  if (va.nodeId > vb.nodeId) return 1;
  return 0;
}

function max3BigInt(a: bigint, b: bigint, c: bigint): bigint {
  const ab = a > b ? a : b;
  return ab > c ? ab : c;
}

interface CounterStepResult {
  readonly physicalMs: UnixMs;
  readonly logical: number;
  readonly overflow: boolean;
}

function resolveLogicalStep(targetMs: bigint, nextLogical: number): CounterStepResult {
  if (nextLogical <= MAX_HLC_COUNTER) {
    return {
      physicalMs: unixMsFromBigInt(targetMs),
      logical: nextLogical,
      overflow: false,
    };
  }
  const advancedMs = targetMs + 1n;
  if (advancedMs > MAX_UNIX_MS_RAW) {
    throw new DomainError('INVALID_TIMESTAMP');
  }
  return {
    physicalMs: advancedMs as UnixMs,
    logical: 0,
    overflow: true,
  };
}

/**
 * Hybrid Logical Clock (Kulkarni et al.) with:
 * - Non-blocking counter rollover (`logical > 65535` advances `physicalMs += 1n`, `logical = 0`,
 *   tracked in `borrowedMs` for operational observability — GEMINI.md 3.2 continuity).
 * - Clamping of future remote timestamps exceeding `maxSkewMs` down to physical clock time
 *   (`GEMINI.md` Section 4: default 5 minutes).
 * - Persistent restart recovery via optional `initial` state.
 */
export class HlcClock {
  private readonly clock: Clock;
  private readonly nodeId: UuidV7;
  private readonly maxSkewMs: bigint;
  private hasState: boolean;
  private lastPhysicalMs: bigint;
  private lastLogical: number;
  private borrowedMs = 0n;

  constructor(options: HlcClockOptions) {
    this.clock = options.clock;
    this.nodeId = parseUuidV7(options.nodeId);

    const skew = options.maxSkewMs ?? DEFAULT_HLC_MAX_SKEW_MS;
    if (typeof skew !== 'bigint' || skew < 0n) {
      throw new DomainError('INVALID_MAX_SKEW');
    }
    this.maxSkewMs = skew;

    if (options.initial !== undefined) {
      const init = validateHlcTimestamp(options.initial);
      this.hasState = true;
      this.lastPhysicalMs = init.physicalMs;
      this.lastLogical = init.logical;
    } else {
      this.hasState = false;
      this.lastPhysicalMs = 0n;
      this.lastLogical = 0;
    }
  }

  now(): HlcNowResult {
    const pt = unixMsFromBigInt(this.clock.now()) as bigint;

    const step =
      !this.hasState || pt > this.lastPhysicalMs
        ? resolveLogicalStep(pt, 0)
        : resolveLogicalStep(this.lastPhysicalMs, this.lastLogical + 1);

    this.commitStep(step);
    return {
      hlc: {
        physicalMs: step.physicalMs,
        logical: step.logical,
        nodeId: this.nodeId,
      },
      counterOverflow: step.overflow,
      borrowedMs: this.borrowedMs,
    };
  }

  receive(remote: HlcTimestamp): HlcReceiveResult {
    const validRemote = validateHlcTimestamp(remote);
    const pt = unixMsFromBigInt(this.clock.now()) as bigint;

    const rMs = validRemote.physicalMs as bigint;
    const rC = validRemote.logical;
    const rawSkewMs = rMs - pt;

    let step: CounterStepResult;
    let skewClamped: boolean;
    let skewMs: bigint;

    if (rawSkewMs > this.maxSkewMs) {
      // Remote timestamp exceeds MAX_SKEW: clamp down to physical time and discard remote counter.
      skewClamped = true;
      skewMs = rawSkewMs;
      step =
        !this.hasState || pt > this.lastPhysicalMs
          ? resolveLogicalStep(pt, 0)
          : resolveLogicalStep(this.lastPhysicalMs, this.lastLogical + 1);
    } else {
      skewClamped = false;
      skewMs = 0n;
      const lPrev = this.hasState ? this.lastPhysicalMs : -1n;
      const lMax = max3BigInt(lPrev, pt, rMs);

      if (lMax === lPrev && lMax === rMs) {
        const maxC = this.lastLogical > rC ? this.lastLogical : rC;
        step = resolveLogicalStep(lMax, maxC + 1);
      } else if (lMax === lPrev) {
        step = resolveLogicalStep(lMax, this.lastLogical + 1);
      } else if (lMax === rMs) {
        step = resolveLogicalStep(lMax, rC + 1);
      } else {
        step = resolveLogicalStep(pt, 0);
      }
    }

    this.commitStep(step);
    return {
      hlc: {
        physicalMs: step.physicalMs,
        logical: step.logical,
        nodeId: this.nodeId,
      },
      skewClamped,
      skewMs,
      counterOverflow: step.overflow,
      borrowedMs: this.borrowedMs,
    };
  }

  currentState(): HlcState {
    return {
      physicalMs: this.lastPhysicalMs as UnixMs,
      logical: this.lastLogical,
      nodeId: this.nodeId,
      borrowedMs: this.borrowedMs,
    };
  }

  private commitStep(step: CounterStepResult): void {
    this.hasState = true;
    this.lastPhysicalMs = step.physicalMs;
    this.lastLogical = step.logical;
    if (step.overflow) {
      this.borrowedMs += 1n;
    }
  }
}
