import { describe, expect, it } from 'vitest';
import { base64ByteLength, fitWithin } from './product-images.js';

describe('C21 photo sizing', () => {
  it('scales the longest side to 480 and never upscales', () => {
    expect(fitWithin(1200, 900, 480)).toEqual({ width: 480, height: 360 });
    expect(fitWithin(900, 1600, 480)).toEqual({ width: 270, height: 480 });
    expect(fitWithin(300, 200, 480)).toEqual({ width: 300, height: 200 });
    expect(fitWithin(0, 10, 480)).toEqual({ width: 0, height: 0 });
  });

  it('counts decoded base64 bytes', () => {
    expect(base64ByteLength(btoa('abc'))).toBe(3);
    expect(base64ByteLength(btoa('abcd'))).toBe(4);
    expect(base64ByteLength(btoa('abcde'))).toBe(5);
  });
});
