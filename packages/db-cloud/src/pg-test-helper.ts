import { execFileSync } from 'node:child_process';

export function isDockerAvailable(): boolean {
  try {
    const osType = execFileSync('docker', ['info', '--format', '{{.OSType}}'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return osType === 'linux';
  } catch {
    return false;
  }
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
