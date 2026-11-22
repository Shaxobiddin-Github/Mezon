import { describe, expect, it } from 'vitest';
import { decodeNativeResponse, isVirtualHubUrl, VIRTUAL_HUB_BASE_URL } from './virtual-hub.js';

describe('Android virtual hub URL', () => {
  it('routes only the exact virtual origin to the native plugin', () => {
    expect(isVirtualHubUrl(`${VIRTUAL_HUB_BASE_URL}/health`)).toBe(true);
    expect(isVirtualHubUrl(`${VIRTUAL_HUB_BASE_URL}/carts/1?x=1`)).toBe(true);
    // Another port, host or scheme goes to the normal network stack.
    expect(isVirtualHubUrl('http://127.0.0.1:47998/health')).toBe(false);
    expect(isVirtualHubUrl('http://localhost:47999/health')).toBe(false);
    expect(isVirtualHubUrl('https://127.0.0.1:47999/health')).toBe(false);
    expect(isVirtualHubUrl('http://127.0.0.1:47999.evil.example/health')).toBe(false);
    expect(isVirtualHubUrl('not a url')).toBe(false);
  });

  it('is accepted by the POS loopback check', async () => {
    const { normalizeLoopbackHubBaseUrl } = await import('../../pos/src/bridge.js');
    expect(normalizeLoopbackHubBaseUrl(VIRTUAL_HUB_BASE_URL)).toBe(VIRTUAL_HUB_BASE_URL);
  });
});

describe('decodeNativeResponse', () => {
  it('keeps status, JSON body and headers the hub client reads', async () => {
    const res = decodeNativeResponse({
      status: 409,
      headers: { 'content-type': 'application/json', 'retry-after': '3' },
      body: '{"error":{"code":"X","message":"m"}}',
    });
    expect(res.status).toBe(409);
    expect(res.ok).toBe(false);
    expect(res.headers.get('retry-after')).toBe('3');
    expect(await res.json()).toEqual({ error: { code: 'X', message: 'm' } });
  });

  it('returns an empty body for 204 instead of throwing', async () => {
    const res = decodeNativeResponse({ status: 204, headers: {}, body: '' });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('rejects impossible statuses as a network failure', () => {
    expect(() => decodeNativeResponse({ status: 0, headers: {}, body: '' })).toThrow(TypeError);
    expect(() => decodeNativeResponse({ status: 700, headers: {}, body: '' })).toThrow(TypeError);
  });
});
