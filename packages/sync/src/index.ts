import { MAX_HLC_SKEW_MS, MAX_SYNC_BATCH_BYTES, MAX_SYNC_BATCH_EVENTS } from '@mezon/contracts';
import {
  type UnixMs,
  type HlcTimestamp,
  parseHlc,
  serializeHlc,
  unixMsFromBigInt,
} from '@mezon/domain';

export * from '@mezon/contracts';

export interface ClampHlcResult {
  readonly hlc: string;
  readonly adjusted: boolean;
}

/**
 * Validates and clamps an incoming event's HLC against server wall clock time.
 * If incoming HLC's wall time exceeds `nowMs + maxSkewMs` (5 min default),
 * the HLC is clamped down to the current server timestamp so a misconfigured client clock
 * cannot overwrite future valid ATTR updates or violate causality.
 */
export function checkAndClampHlc(
  rawHlc: string,
  nowMs: UnixMs,
  maxSkewMs: number = MAX_HLC_SKEW_MS,
): ClampHlcResult {
  const parsed = parseHlc(rawHlc);
  const nowBig = BigInt(nowMs);
  const maxSkewBig = BigInt(maxSkewMs);
  const physicalBig = BigInt(parsed.physicalMs);

  if (physicalBig > nowBig + maxSkewBig) {
    // Excessive future skew -> clamp to server time
    const clamped: HlcTimestamp = {
      physicalMs: unixMsFromBigInt(nowBig),
      logical: 0,
      nodeId: parsed.nodeId,
    };
    return {
      hlc: serializeHlc(clamped),
      adjusted: true,
    };
  }

  return {
    hlc: serializeHlc(parsed),
    adjusted: false,
  };
}

export interface OutboxItemWithPayload {
  readonly payload: Record<string, unknown> | string;
}

const encoder = new TextEncoder();

/**
 * Slices pending outbox items respecting both:
 * 1. Maximum batch item count (maxCount = 100)
 * 2. Maximum total byte size (maxBytes = 1 MB)
 *
 * Ensures network envelopes never exceed memory or Fastify body limits.
 */
export function sliceOutboxBatch<T extends OutboxItemWithPayload>(
  items: readonly T[],
  maxCount: number = MAX_SYNC_BATCH_EVENTS,
  maxBytes: number = MAX_SYNC_BATCH_BYTES,
): readonly T[] {
  if (items.length === 0) {
    return [];
  }

  const result: T[] = [];
  let totalBytes = 0;

  for (const item of items) {
    if (result.length >= maxCount) {
      break;
    }

    const payloadStr =
      typeof item.payload === 'string' ? item.payload : JSON.stringify(item.payload);
    const itemBytes = encoder.encode(payloadStr).length;

    // Always include at least 1 item even if single item is large, but stop if exceeded
    if (result.length > 0 && totalBytes + itemBytes > maxBytes) {
      break;
    }

    totalBytes += itemBytes;
    result.push(item);
  }

  return result;
}
