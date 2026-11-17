import { DomainError } from '@mezon/domain';

const MAX_SAFE = 9007199254740991;

/**
 * Deterministic canonical JSON used as the signed byte source (T3.2 §1).
 * - object keys sorted lexicographically by UTF-16 code units; array order preserved;
 * - allowed values: string, safe integer, boolean, null, array, plain object;
 * - floats, NaN/Infinity, undefined, bigint, functions are rejected (money travels as strings);
 * - no insignificant whitespace; strings escaped exactly like `JSON.stringify`.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number': {
      if (value % 1 !== 0 || value > MAX_SAFE || value < -MAX_SAFE) {
        throw new DomainError('RULES_PACKAGE_INVALID', 'canonical JSON allows only safe integers');
      }
      return JSON.stringify(value);
    }
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((v: unknown) => canonicalJson(v)).join(',')}]`;
      }
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new DomainError('RULES_PACKAGE_INVALID', 'canonical JSON allows only plain objects');
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      const parts: string[] = [];
      for (const k of keys) {
        const v = record[k];
        if (v === undefined) {
          throw new DomainError('RULES_PACKAGE_INVALID', `canonical JSON: undefined at "${k}"`);
        }
        parts.push(`${JSON.stringify(k)}:${canonicalJson(v)}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      throw new DomainError('RULES_PACKAGE_INVALID', `canonical JSON: unsupported ${typeof value}`);
  }
}
