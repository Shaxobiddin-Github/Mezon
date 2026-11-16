import { execFileSync } from 'node:child_process';

let cachedDockerAvailable: boolean | null = null;

export function isDockerAvailable(): boolean {
  if (cachedDockerAvailable !== null) {
    return cachedDockerAvailable;
  }
  try {
    const osType = execFileSync('docker', ['info', '--format', '{{.OSType}}'], {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    cachedDockerAvailable = osType === 'linux';
  } catch {
    cachedDockerAvailable = false;
  }
  return cachedDockerAvailable;
}

export function shouldRunPgTests(): boolean {
  const requirePg = process.env.MEZON_REQUIRE_PG === '1';
  const available = isDockerAvailable();
  if (requirePg && !available) {
    throw new Error(
      'MEZON_REQUIRE_PG=1 talab qilingan, lekin Linux Docker container runtime topilmadi! PostgreSQL testlarini o‘tkazib yuborish taqiqlangan.',
    );
  }
  return requirePg || available;
}
