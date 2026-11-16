import { unixMsFromBigInt, parseUuidV7, serializeHlc } from '@mezon/domain';
import { describe, expect, it } from 'vitest';
import { checkAndClampHlc, sliceOutboxBatch } from './index.js';

describe('packages/sync', () => {
  const dummyNodeId = parseUuidV7('01880000-0000-7000-8000-000000000001');
  const baseHlc = serializeHlc({
    physicalMs: unixMsFromBigInt(1700000000000n),
    logical: 0,
    nodeId: dummyNodeId,
  });

  describe('checkAndClampHlc', () => {
    it('does not clamp when HLC is within normal wall-time bounds', () => {
      const nowMs = unixMsFromBigInt(1700000000000n);
      const result = checkAndClampHlc(baseHlc, nowMs);
      expect(result.adjusted).toBe(false);
      expect(result.hlc).toBe(baseHlc);
    });

    it('clamps HLC down to server timestamp when future skew exceeds 5 minutes', () => {
      // Incoming event says it occurred 1 hour in the future
      const futureTimeMs = 1700000000000n + 3600000n;
      const futureHlc = serializeHlc({
        physicalMs: unixMsFromBigInt(futureTimeMs),
        logical: 0,
        nodeId: dummyNodeId,
      });

      const serverNowMs = unixMsFromBigInt(1700000000000n);
      const result = checkAndClampHlc(futureHlc, serverNowMs, 5 * 60 * 1000);

      expect(result.adjusted).toBe(true);
      // Clamped HLC should now match serverNowMs
      expect(result.hlc).toBe(baseHlc);
    });
  });

  describe('sliceOutboxBatch', () => {
    it('slices batch by item count limit', () => {
      const items = Array.from({ length: 150 }, (_, i) => ({
        id: i,
        payload: { test: i },
      }));
      const sliced = sliceOutboxBatch(items, 100);
      expect(sliced).toHaveLength(100);
      expect(sliced[0].id).toBe(0);
      expect(sliced[99].id).toBe(99);
    });

    it('slices batch by byte size limit', () => {
      // 50KB payload each
      const bigPayload = { data: 'x'.repeat(50 * 1024) };
      const items = Array.from({ length: 30 }, (_, i) => ({
        id: i,
        payload: bigPayload,
      }));
      // 200KB max -> should slice to 3-4 items max
      const sliced = sliceOutboxBatch(items, 100, 200 * 1024);
      expect(sliced.length).toBeLessThanOrEqual(4);
      expect(sliced.length).toBeGreaterThan(0);
    });
  });
});
