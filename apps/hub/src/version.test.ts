import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HUB_APP_VERSION } from './version.js';

describe('hub version', () => {
  it('equals the hub and desktop package versions (the cabinet shows it per register)', () => {
    const read = (p: string) =>
      (
        JSON.parse(fs.readFileSync(path.join(import.meta.dirname, p), 'utf8')) as {
          version: string;
        }
      ).version;
    expect(HUB_APP_VERSION).toBe(read('../package.json'));
    expect(HUB_APP_VERSION).toBe(read('../../desktop/package.json'));
  });
});
