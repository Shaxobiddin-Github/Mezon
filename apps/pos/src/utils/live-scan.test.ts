import { describe, expect, it } from 'vitest';
import { createScanGate, findTouchedLine } from './live-scan.js';

describe('createScanGate', () => {
  it('accepts a code once while it stays in view', () => {
    const gate = createScanGate(1000);
    expect(gate('A', 0)).toBe(true);
    // the camera keeps reporting it every ~100 ms
    for (let t = 100; t <= 5000; t += 100) expect(gate('A', t)).toBe(false);
  });

  it('accepts the same code again after it was out of view', () => {
    const gate = createScanGate(1000);
    expect(gate('A', 0)).toBe(true);
    expect(gate('A', 500)).toBe(false);
    expect(gate('A', 2000)).toBe(true);
  });

  it('tracks different codes separately', () => {
    const gate = createScanGate(1000);
    expect(gate('A', 0)).toBe(true);
    expect(gate('B', 100)).toBe(true);
    expect(gate('A', 200)).toBe(false);
    expect(gate('B', 300)).toBe(false);
  });
});

describe('findTouchedLine', () => {
  const a = { id: 'a', qty: '1000', name: 'A' };
  const b = { id: 'b', qty: '1000', name: 'B' };

  it('finds a new line', () => {
    expect(findTouchedLine([a], [a, b])?.name).toBe('B');
  });

  it('finds a line whose quantity grew', () => {
    expect(findTouchedLine([a, b], [a, { ...b, qty: '2000' }])?.name).toBe('B');
  });

  it('returns null when nothing changed', () => {
    expect(findTouchedLine([a, b], [a, b])).toBeNull();
  });
});
