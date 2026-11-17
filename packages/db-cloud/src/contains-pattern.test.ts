import { describe, expect, it } from 'vitest';
import { containsPattern } from './admin-store.js';

describe('@mezon/db-cloud - containsPattern (ILIKE user input, review K5)', () => {
  it('escapes %, _ and the backslash; plain text is wrapped unchanged', () => {
    expect(containsPattern('Aziz')).toBe('%Aziz%');
    expect(containsPattern('50%')).toBe('%50\\%%');
    expect(containsPattern('a_b')).toBe('%a\\_b%');
    expect(containsPattern('c:\\x')).toBe('%c:\\\\x%');
  });
});
