import { afterEach, describe, expect, it, vi } from 'vitest';
import { isUiSize, nextUiSize, readUiSize, writeUiSize } from './ui-size.js';

describe('kassa screen size', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('cycles normal → large → xlarge → normal', () => {
    expect(nextUiSize('normal')).toBe('large');
    expect(nextUiSize('large')).toBe('xlarge');
    expect(nextUiSize('xlarge')).toBe('normal');
  });

  it('accepts only the three known sizes', () => {
    expect(isUiSize('large')).toBe(true);
    expect(isUiSize('huge')).toBe(false);
    expect(isUiSize(null)).toBe(false);
  });

  it('remembers the size and falls back to normal on junk or blocked storage', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    });
    expect(readUiSize()).toBe('normal');
    writeUiSize('xlarge');
    expect(readUiSize()).toBe('xlarge');
    store.set('mezon.pos.uiSize', 'giant');
    expect(readUiSize()).toBe('normal');

    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(readUiSize()).toBe('normal');
    expect(() => writeUiSize('large')).not.toThrow();
  });
});
