import { describe, expect, it } from 'vitest';
import { buildHubHealthUrl, parseHealthPayload } from './bridge.js';

describe('@mezon/pos bridge helpers', () => {
  it('builds /health URL strictly for loopback HTTP hub URLs', () => {
    expect(buildHubHealthUrl('http://127.0.0.1:45123')).toBe('http://127.0.0.1:45123/health');
    expect(() => buildHubHealthUrl('https://127.0.0.1:45123')).toThrow();
    expect(() => buildHubHealthUrl('http://example.com:45123')).toThrow();
  });

  it('validates /health payload shape strictly', () => {
    expect(parseHealthPayload({ status: 'ok', needsSetup: true })).toEqual({
      status: 'ok',
      needsSetup: true,
    });
    expect(() => parseHealthPayload(null)).toThrow();
    expect(() => parseHealthPayload({ status: 'ok' })).toThrow();
  });
});
