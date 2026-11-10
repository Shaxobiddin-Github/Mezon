import path from 'node:path';

export const APP_SCHEME = 'app';
export const APP_HOST = 'mezon';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_HOME_URL = `${APP_ORIGIN}/`;

export const DESKTOP_FUSE_REQUIREMENTS = {
  runAsNode: false,
  enableCookieEncryption: true,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true,
  grantFileProtocolExtraPrivileges: false,
} as const;

export function parseLoopbackHubOrigin(hubBaseUrl: string | null): string | null {
  if (hubBaseUrl === null) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(hubBaseUrl);
  } catch {
    throw new Error(`Invalid Hub URL: ${hubBaseUrl}`);
  }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.port.length === 0) {
    throw new Error(`Hub URL must be loopback http://127.0.0.1:<port>: ${hubBaseUrl}`);
  }
  return `http://127.0.0.1:${parsed.port}`;
}

export function buildDesktopCspHeader(hubBaseUrl: string | null): string {
  const hubOrigin = parseLoopbackHubOrigin(hubBaseUrl);
  const connectSources =
    hubOrigin === null ? `'self' ${APP_ORIGIN}` : `'self' ${APP_ORIGIN} ${hubOrigin}`;

  return [
    `default-src 'self' ${APP_ORIGIN}`,
    `script-src 'self' ${APP_ORIGIN}`,
    `style-src 'self' ${APP_ORIGIN}`,
    `img-src 'self' ${APP_ORIGIN} data:`,
    `font-src 'self' ${APP_ORIGIN}`,
    `connect-src ${connectSources}`,
    `object-src 'none'`,
    `base-uri 'none'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
  ].join('; ');
}

export function isAllowedNavigationUrl(targetUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return false;
  }
  return (
    parsed.protocol === `${APP_SCHEME}:` &&
    parsed.hostname === APP_HOST &&
    parsed.port === '' &&
    parsed.username === '' &&
    parsed.password === ''
  );
}

export function isPathInsideRoot(rootDir: string, candidatePath: string): boolean {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedCandidate = path.resolve(candidatePath);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function resolveAppProtocolFilePath(requestUrl: string, uiRootDir: string): string | null {
  if (!isAllowedNavigationUrl(requestUrl)) {
    return null;
  }

  const withoutHashOrQuery = requestUrl.split(/[?#]/, 1)[0] ?? '';
  if (!withoutHashOrQuery.startsWith(APP_ORIGIN)) {
    return null;
  }
  const rawSuffix = withoutHashOrQuery.slice(APP_ORIGIN.length);
  if (rawSuffix !== '' && !rawSuffix.startsWith('/')) {
    return null;
  }

  for (const rawSegment of rawSuffix.split('/')) {
    if (rawSegment.length === 0) {
      continue;
    }
    if (rawSegment === '.' || rawSegment === '..') {
      return null;
    }
    let onceDecoded: string;
    try {
      onceDecoded = decodeURIComponent(rawSegment);
    } catch {
      return null;
    }
    if (
      onceDecoded === '.' ||
      onceDecoded === '..' ||
      onceDecoded.includes('\0') ||
      onceDecoded.includes('\\') ||
      onceDecoded.includes('/')
    ) {
      return null;
    }
  }

  const parsed = new URL(requestUrl);
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }

  if (decodedPath.includes('\0') || decodedPath.includes('\\')) {
    return null;
  }

  const rawSegments = decodedPath.split('/').filter((segment) => segment.length > 0);
  if (rawSegments.some((segment) => segment === '.' || segment === '..')) {
    return null;
  }

  const relativePath = rawSegments.length === 0 ? 'index.html' : path.join(...rawSegments);
  const resolvedRoot = path.resolve(uiRootDir);
  const candidate = path.resolve(resolvedRoot, relativePath);

  if (!isPathInsideRoot(resolvedRoot, candidate)) {
    return null;
  }

  return candidate;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export function getMimeTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}
