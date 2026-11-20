import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type DataKeyCipher, loadOrCreateDataKey } from './data-key.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmpFile = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-dk-'));
  dirs.push(d);
  return path.join(d, 'sub', 'hub-data-key.json');
};

/** Reversible fake of the OS wrap; tags the bytes so a plain key cannot pass as wrapped. */
const osCipher = (available = true): DataKeyCipher => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(`os:${s}`, 'utf8'),
  decryptString: (b) => {
    const s = b.toString('utf8');
    if (!s.startsWith('os:')) throw new Error('not wrapped by this OS user');
    return s.slice(3);
  },
});

describe('hub data key (secrets must survive a restart)', () => {
  it('is created once and returned unchanged on every later start', () => {
    const filePath = tmpFile();
    const first = loadOrCreateDataKey({ filePath, cipher: osCipher() });
    expect(Buffer.from(first, 'base64')).toHaveLength(32);
    const again = loadOrCreateDataKey({ filePath, cipher: osCipher() });
    expect(again).toBe(first);
    // At rest only the OS-wrapped form.
    const raw = fs.readFileSync(filePath, 'utf8');
    expect(raw).not.toContain(first);
    expect(JSON.parse(raw)).toMatchObject({ v: 1, wrap: 'os' });
  });

  it('without OS encryption it still persists (warns), so secrets stay readable', () => {
    const filePath = tmpFile();
    let warned = 0;
    const key = loadOrCreateDataKey({
      filePath,
      cipher: osCipher(false),
      onUnwrapped: () => {
        warned += 1;
      },
    });
    expect(warned).toBe(1);
    expect(loadOrCreateDataKey({ filePath, cipher: osCipher(false) })).toBe(key);
  });

  it('a corrupt or foreign key file stops the start instead of silently making a new key', () => {
    const filePath = tmpFile();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ v: 1, wrap: 'none', key: 'c2hvcnQ=' }));
    expect(() => loadOrCreateDataKey({ filePath, cipher: osCipher() })).toThrow(/corrupt/);
    fs.writeFileSync(filePath, JSON.stringify({ v: 1, wrap: 'os', key: 'AAAA' }));
    expect(() => loadOrCreateDataKey({ filePath, cipher: osCipher() })).toThrow();
  });
});
