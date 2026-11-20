import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';

/** The signed envelope is small; anything bigger is refused before parsing. */
const MAX_ENVELOPE_BYTES = 64 * 1024;

export async function fetchUpdateEnvelope(url: string, timeoutMs = 15_000): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  if (res.status !== 200) throw new Error(`Update manifest: HTTP ${String(res.status)}`);
  const text = await res.text();
  if (text.length > MAX_ENVELOPE_BYTES) throw new Error('Update manifest is too large');
  return JSON.parse(text) as unknown;
}

/** Streams the installer to `destPath`, stopping as soon as it grows past `maxBytes`. */
export async function downloadInstaller(
  url: string,
  destPath: string,
  maxBytes: number,
  timeoutMs = 30 * 60_000,
): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (res.status !== 200 || res.body === null) {
    throw new Error(`Installer download: HTTP ${String(res.status)}`);
  }
  const file = await fs.open(destPath, 'w');
  let written = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      written += chunk.byteLength;
      if (written > maxBytes) throw new Error('Installer is larger than the signed size');
      await file.write(chunk);
    }
  } finally {
    await file.close();
  }
}

export function sha256File(
  filePath: string,
): Promise<{ readonly sha256: string; readonly sizeBytes: number }> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    let size = 0;
    createReadStream(filePath)
      .on('data', (chunk: string | Buffer) => {
        size += chunk.length;
        hash.update(chunk);
      })
      .on('error', reject)
      .on('end', () => resolve({ sha256: hash.digest('hex'), sizeBytes: size }));
  });
}

/**
 * Starts the NSIS installer silently (`/S`); `--updated --force-run` make the electron-builder
 * installer start the app again when it is done. The caller shuts the hub down and quits.
 */
export function startInstallerDetached(installerPath: string): void {
  const child = spawn(installerPath, ['--updated', '/S', '--force-run'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}
