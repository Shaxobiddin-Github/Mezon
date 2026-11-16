import { DomainError, normalizeFiscalCode } from '@mezon/domain';
import { canonicalJson } from './canonical.js';
import {
  type MxikMatchList,
  RULES_PACKAGE_FORMAT,
  RULES_PACKAGE_FORMAT_VERSION,
  type RulesPackageEnvelope,
  type RulesPayload,
} from './types.js';

/** Domain-separation prefix of the signed message (T3.2 §1). */
export const RULES_SIGNING_PREFIX = 'mezon-rules/v1\n';

const UINT_STRING = /^(0|[1-9][0-9]{0,18})$/;
const BASE64_SIG = /^[A-Za-z0-9+/]{86}==$/; // 64 bytes
const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_LIST = 100_000;

function fail(message: string): never {
  throw new DomainError('RULES_PACKAGE_INVALID', message);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function assertExactKeys(obj: Record<string, unknown>, keys: readonly string[], where: string) {
  for (const k of Object.keys(obj)) {
    if (!keys.includes(k)) fail(`${where}: unknown field "${k}"`);
  }
  for (const k of keys) {
    if (!(k in obj)) fail(`${where}: missing field "${k}"`);
  }
}

function parseUint(v: unknown, where: string): bigint {
  if (typeof v !== 'string' || !UINT_STRING.test(v))
    fail(`${where}: must be a canonical uint string`);
  return BigInt(v);
}

function parseBool(v: unknown, where: string): boolean {
  if (typeof v !== 'boolean') fail(`${where}: must be boolean`);
  return v;
}

function parseMxikList(v: unknown, where: string): MxikMatchList {
  if (!isRecord(v)) fail(`${where}: must be an object`);
  assertExactKeys(v, ['exact', 'prefixes'], where);
  const out = (arr: unknown, sub: string): string[] => {
    if (!Array.isArray(arr) || arr.length > MAX_LIST) fail(`${where}.${sub}: must be an array`);
    return arr.map((code: unknown, i) => {
      if (typeof code !== 'string') fail(`${where}.${sub}[${String(i)}]: must be a string`);
      let norm: string | null;
      try {
        norm = normalizeFiscalCode(code, 'MXIK');
      } catch {
        fail(`${where}.${sub}[${String(i)}]: invalid MXIK code`);
      }
      if (norm !== code) fail(`${where}.${sub}[${String(i)}]: must be normalized`);
      return code;
    });
  };
  return { exact: out(v.exact, 'exact'), prefixes: out(v.prefixes, 'prefixes') };
}

function parseFlag(v: unknown, where: string): { enabled: boolean } {
  if (!isRecord(v)) fail(`${where}: must be an object`);
  assertExactKeys(v, ['enabled'], where);
  return { enabled: parseBool(v.enabled, `${where}.enabled`) };
}

const PAYLOAD_KEYS = [
  'packageVersion',
  'issuedAtMs',
  'validUntilMs',
  'sourceRefs',
  'cashForbidden',
  'prescriptionRequired',
  'perMxikCashLimit',
  'socialCard',
  'expiredGoods',
] as const;

/** Strict structural parse of a wire payload (strings for bigint values) into typed form. */
export function parseRulesPayload(raw: unknown): RulesPayload {
  if (!isRecord(raw)) fail('payload: must be an object');
  assertExactKeys(raw, PAYLOAD_KEYS, 'payload');
  const packageVersion = parseUint(raw.packageVersion, 'payload.packageVersion');
  if (packageVersion < 1n) fail('payload.packageVersion: must be ≥ 1');
  const issuedAtMs = parseUint(raw.issuedAtMs, 'payload.issuedAtMs');
  const validUntilMs = parseUint(raw.validUntilMs, 'payload.validUntilMs');
  if (validUntilMs <= issuedAtMs) fail('payload.validUntilMs: must be after issuedAtMs');
  const refs = raw.sourceRefs;
  if (!Array.isArray(refs) || refs.length > 64) fail('payload.sourceRefs: must be an array');
  const sourceRefs = refs.map((r: unknown) => {
    if (typeof r !== 'string' || r.length === 0 || r.length > 256)
      fail('payload.sourceRefs: bad item');
    return r;
  });
  let perMxikCashLimit: RulesPayload['perMxikCashLimit'] = null;
  if (raw.perMxikCashLimit !== null) {
    const l = raw.perMxikCashLimit;
    if (!isRecord(l)) fail('payload.perMxikCashLimit: must be an object or null');
    assertExactKeys(l, ['limitTiyin', 'exempt'], 'payload.perMxikCashLimit');
    perMxikCashLimit = {
      limitTiyin: parseUint(l.limitTiyin, 'payload.perMxikCashLimit.limitTiyin'),
      exempt: parseMxikList(l.exempt, 'payload.perMxikCashLimit.exempt'),
    };
  }
  return {
    packageVersion,
    issuedAtMs,
    validUntilMs,
    sourceRefs,
    cashForbidden: parseMxikList(raw.cashForbidden, 'payload.cashForbidden'),
    prescriptionRequired: parseMxikList(raw.prescriptionRequired, 'payload.prescriptionRequired'),
    perMxikCashLimit,
    socialCard: parseFlag(raw.socialCard, 'payload.socialCard'),
    expiredGoods: parseFlag(raw.expiredGoods, 'payload.expiredGoods'),
  };
}

/** Typed payload → wire object (bigint as canonical decimal strings). Exact inverse of parse. */
export function rulesPayloadToWire(p: RulesPayload): Record<string, unknown> {
  const list = (l: MxikMatchList) => ({ exact: [...l.exact], prefixes: [...l.prefixes] });
  return {
    packageVersion: p.packageVersion.toString(),
    issuedAtMs: p.issuedAtMs.toString(),
    validUntilMs: p.validUntilMs.toString(),
    sourceRefs: [...p.sourceRefs],
    cashForbidden: list(p.cashForbidden),
    prescriptionRequired: list(p.prescriptionRequired),
    perMxikCashLimit:
      p.perMxikCashLimit === null
        ? null
        : {
            limitTiyin: p.perMxikCashLimit.limitTiyin.toString(),
            exempt: list(p.perMxikCashLimit.exempt),
          },
    socialCard: { enabled: p.socialCard.enabled },
    expiredGoods: { enabled: p.expiredGoods.enabled },
  };
}

/** Strict parse of a wire envelope (`format`, `formatVersion`, `keyId`, `payload`, `signature`). */
export function parseRulesEnvelope(raw: unknown): RulesPackageEnvelope {
  if (!isRecord(raw)) fail('envelope: must be an object');
  assertExactKeys(raw, ['format', 'formatVersion', 'keyId', 'payload', 'signature'], 'envelope');
  if (raw.format !== RULES_PACKAGE_FORMAT) fail('envelope.format: unsupported');
  if (raw.formatVersion !== RULES_PACKAGE_FORMAT_VERSION)
    fail('envelope.formatVersion: unsupported');
  if (typeof raw.keyId !== 'string' || !KEY_ID.test(raw.keyId)) fail('envelope.keyId: invalid');
  if (typeof raw.signature !== 'string' || !BASE64_SIG.test(raw.signature)) {
    fail('envelope.signature: must be base64 of 64 bytes');
  }
  return {
    format: RULES_PACKAGE_FORMAT,
    formatVersion: RULES_PACKAGE_FORMAT_VERSION,
    keyId: raw.keyId,
    payload: parseRulesPayload(raw.payload),
    signature: raw.signature,
  };
}

/**
 * Exact text that is signed: prefix + canonical({ formatVersion, keyId, payload }).
 * `keyId` is inside the signed text so a signature cannot be re-attributed to another key.
 */
export function buildRulesSigningMessage(
  keyId: string,
  payload: RulesPayload,
  formatVersion: number = RULES_PACKAGE_FORMAT_VERSION,
): string {
  return (
    RULES_SIGNING_PREFIX +
    canonicalJson({ formatVersion, keyId, payload: rulesPayloadToWire(payload) })
  );
}

/** Wire form of a full envelope (for storage / transport), canonical and byte-stable. */
export function rulesEnvelopeToCanonicalJson(env: RulesPackageEnvelope): string {
  return canonicalJson({
    format: env.format,
    formatVersion: env.formatVersion,
    keyId: env.keyId,
    payload: rulesPayloadToWire(env.payload),
    signature: env.signature,
  });
}
