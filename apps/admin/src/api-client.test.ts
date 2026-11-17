import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminApiClient } from './api-client.js';

function getUrlString(url: RequestInfo | URL): string {
  if (typeof url === 'string') return url;
  if (url instanceof URL) return url.pathname;
  return url.url;
}

describe('AdminApiClient (apps/admin)', () => {
  let client: AdminApiClient;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    client = new AdminApiClient();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('performs login and stores access token', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          accessToken: 'access-token-123',
          user: {
            id: '01950000-0000-7000-8000-000000000001',
            organizationId: '01950000-0000-7000-8000-000000000002',
            role: 'owner',
            name: 'Owner',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const res = await client.login({ login: 'owner@guzar.uz', password: 'Password123!' });
    expect(res.accessToken).toBe('access-token-123');
    expect(res.user.role).toBe('owner');
  });

  it('sends X-Mezon-Admin security header on refresh (A3 CSRF guard)', async () => {
    let capturedHeaders: Headers | undefined;
    globalThis.fetch = vi.fn().mockImplementation((url: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = getUrlString(url);
      if (urlStr === '/api/v1/admin/auth/refresh') {
        capturedHeaders = new Headers(init?.headers);
        return Promise.resolve(
          new Response(JSON.stringify({ accessToken: 'new-refreshed-token' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return Promise.reject(new Error('Unknown url'));
    });

    const res = await client.refresh();
    expect(res.accessToken).toBe('new-refreshed-token');
    expect(capturedHeaders?.get('X-Mezon-Admin')).toBe('1');
  });

  it('automatically refreshes token on 401 and retries original request', async () => {
    client.setAccessToken('expired-token');
    let callCount = 0;

    globalThis.fetch = vi.fn().mockImplementation((url: RequestInfo | URL, init?: RequestInit) => {
      callCount++;
      const urlStr = getUrlString(url);
      if (urlStr === '/api/v1/admin/dashboard') {
        const headers = new Headers(init?.headers);
        if (headers.get('Authorization') === 'Bearer expired-token') {
          return Promise.resolve(
            new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
          );
        }
        if (headers.get('Authorization') === 'Bearer fresh-token') {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                todayDate: '2026-11-10',
                grossSales: '1000000',
                returnsTotal: '0',
                netSales: '1000000',
                receiptsCount: 1,
                avgReceipt: '1000000',
                stores: [],
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
          );
        }
      }
      if (urlStr === '/api/v1/admin/auth/refresh') {
        return Promise.resolve(
          new Response(JSON.stringify({ accessToken: 'fresh-token' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return Promise.reject(new Error(`Unexpected url ${urlStr}`));
    });

    const data = await client.getDashboard();
    expect(data.todayDate).toBe('2026-11-10');
    expect(data.grossSales).toBe('1000000');
    expect(callCount).toBe(3); // 1. initial -> 401, 2. refresh -> 200, 3. retry -> 200
  });

  it('notifies onUnauthorized when refresh fails', async () => {
    client.setAccessToken('expired-token');
    const onUnauthorized = vi.fn();
    client.setOnUnauthorized(onUnauthorized);

    globalThis.fetch = vi.fn().mockImplementation((url: RequestInfo | URL) => {
      const urlStr = getUrlString(url);
      if (urlStr === '/api/v1/admin/dashboard') {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
        );
      }
      if (urlStr === '/api/v1/admin/auth/refresh') {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'Refresh failed' }), { status: 401 }),
        );
      }
      return Promise.reject(new Error('Unexpected url'));
    });

    await expect(client.getDashboard()).rejects.toThrow('Sessiya muddati tugadi');
    expect(onUnauthorized).toHaveBeenCalled();
  });
});
