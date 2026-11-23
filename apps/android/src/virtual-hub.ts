/**
 * The POS only accepts `http://127.0.0.1:<port>` hub URLs. On the phone nothing listens there:
 * requests to this exact origin are answered by the native plugin instead of the network.
 */
export const VIRTUAL_HUB_BASE_URL = 'http://127.0.0.1:47999';

export function isVirtualHubUrl(url: string): boolean {
  try {
    return new URL(url).origin === VIRTUAL_HUB_BASE_URL;
  } catch {
    return false;
  }
}

/** Statuses whose Response must not carry a body (the constructor throws otherwise). */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

export function decodeNativeResponse(res: {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}): Response {
  if (!Number.isInteger(res.status) || res.status < 200 || res.status > 599) {
    throw new TypeError(`Invalid hub response status ${String(res.status)}`);
  }
  return new Response(NULL_BODY.has(res.status) ? null : res.body, {
    status: res.status,
    headers: res.headers,
  });
}
