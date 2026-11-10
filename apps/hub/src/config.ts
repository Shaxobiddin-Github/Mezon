export const DEFAULT_HUB_HOST = '127.0.0.1' as const;
export const DEFAULT_HUB_PORT = 47832;

export interface ResolvedHubSecurityConfig {
  readonly host: typeof DEFAULT_HUB_HOST;
  readonly port: number;
  readonly allowedOrigins: ReadonlySet<string>;
}

export function resolveHubSecurityConfig(options?: {
  readonly host?: string;
  readonly port?: number;
  readonly allowedOrigins?: readonly string[];
}): ResolvedHubSecurityConfig {
  const host = options?.host ?? DEFAULT_HUB_HOST;
  if (host !== DEFAULT_HUB_HOST) {
    throw new RangeError(
      `Hub server must listen strictly on "${DEFAULT_HUB_HOST}", received "${host}"`,
    );
  }

  const port = options?.port ?? DEFAULT_HUB_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RangeError(`Invalid hub TCP port: ${String(port)}`);
  }

  const normalizedOrigins = new Set<string>();
  for (const raw of options?.allowedOrigins ?? []) {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed === 'null' || trimmed === '*') {
      throw new RangeError(`Disallowed CORS origin in config allowlist: "${raw}"`);
    }
    const parsed = new URL(trimmed);
    if (parsed.origin === 'null' || parsed.origin !== trimmed) {
      throw new RangeError(`Allowed origin must be an exact origin without path: "${raw}"`);
    }
    normalizedOrigins.add(parsed.origin);
  }

  return {
    host: DEFAULT_HUB_HOST,
    port,
    allowedOrigins: normalizedOrigins,
  };
}
