import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  type LanTerminalRow,
  type LocalSqliteConnection,
  consumeLanPairingCodeAndAddTerminalSync,
  getLanIdentitySync,
  getLanTerminalSync,
  insertLanIdentityIfAbsentSync,
  insertLanPairingCodeSync,
  listActiveLanPairingCodesSync,
  listLanTerminalsSync,
  listSalesByTerminalSync,
  recordLanPairingFailureSync,
  revokeLanTerminalSync,
  touchLanTerminalSync,
} from '@mezon/db-local';
import { DomainError, type UnixMs, type UuidV7 } from '@mezon/domain';
import { generateSelfSignedTlsMaterial, lanPairingProof } from '@mezon/drivers/node';
import type { SafeStoragePort } from './safe-storage-port.js';

/** [TASDIQLANSIN] pairing parameters. */
export const LAN_PAIRING_CODE_TTL_MS = 5n * 60_000n;
export const LAN_PAIRING_MAX_FAILED_ATTEMPTS = 5;
export const LAN_CERT_VALID_DAYS = 3650;

/** Crockford-style base32 without I, L, O, U: 10 symbols = 50 bits, typed as XXXXX-XXXXX. */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export interface LanTlsMaterial {
  readonly certPem: string;
  readonly keyPem: string;
  readonly fingerprint256: string;
}

export interface LanTerminalDto {
  readonly id: string;
  readonly name: string;
  readonly status: 'active' | 'revoked';
  readonly pairedAtMs: string;
  readonly revokedAtMs: string | null;
  readonly lastSeenAtMs: string | null;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

const toDto = (t: LanTerminalRow): LanTerminalDto => ({
  id: t.id,
  name: t.name,
  status: t.status,
  pairedAtMs: t.pairedAtMs.toString(),
  revokedAtMs: t.revokedAtMs?.toString() ?? null,
  lastSeenAtMs: t.lastSeenAtMs?.toString() ?? null,
});

/**
 * T4.1 LAN terminals: hub TLS identity, one-time pairing codes and terminal keys.
 * - The pairing code never crosses the network: both sides prove it with an HMAC bound to the
 *   certificate fingerprint each of them sees (a MITM certificate breaks the proof).
 * - A code is single-use (guarded UPDATE), expires, and burns after a few wrong proofs.
 * - Only SHA-256 of a terminal key is stored; revocation is immediate (checked on every request).
 */
export class HubLanService {
  constructor(
    private readonly o: {
      readonly connection: LocalSqliteConnection;
      readonly safeStorage: SafeStoragePort;
      readonly getOrganizationId: () => UuidV7 | null;
      readonly nowMs: () => UnixMs;
      readonly nextId: () => UuidV7;
    },
  ) {}

  private get sqlite() {
    return this.o.connection.sqlite;
  }

  private org(): UuidV7 {
    const org = this.o.getOrganizationId();
    if (org === null)
      throw new DomainError('AUTH_UNAUTHORIZED', 'Hub setup has not been completed');
    return org;
  }

  private async encrypt(s: string): Promise<string> {
    return (await this.o.safeStorage.encryptString(s)).toString('base64');
  }

  private decrypt(b64: string): Promise<string> {
    return this.o.safeStorage.decryptString(Buffer.from(b64, 'base64'));
  }

  /** The hub certificate + key; created once on first use. */
  async tlsMaterial(): Promise<LanTlsMaterial> {
    const org = this.org();
    let row = getLanIdentitySync(this.sqlite, org);
    if (row === null) {
      const nowMs = this.o.nowMs();
      const m = generateSelfSignedTlsMaterial({
        commonName: 'Mezon hub',
        nowMs: Number(nowMs),
        validDays: LAN_CERT_VALID_DAYS,
      });
      row = insertLanIdentityIfAbsentSync(this.sqlite, {
        id: this.o.nextId(),
        organizationId: org,
        certPem: m.certPem,
        keyEncB64: await this.encrypt(m.keyPem),
        fingerprint256: m.fingerprint256,
        notAfterMs: BigInt(m.notAfterMs),
        nowMs,
      });
    }
    return {
      certPem: row.certPem,
      keyPem: await this.decrypt(row.keyEncB64),
      fingerprint256: row.fingerprint256,
    };
  }

  async status(): Promise<{ readonly fingerprint256: string; readonly activeTerminals: number }> {
    const m = await this.tlsMaterial();
    return {
      fingerprint256: m.fingerprint256,
      activeTerminals: listLanTerminalsSync(this.sqlite, this.org()).filter(
        (t) => t.status === 'active',
      ).length,
    };
  }

  async createPairingCode(userId: UuidV7): Promise<{
    readonly code: string;
    readonly expiresAtMs: string;
    readonly fingerprint256: string;
  }> {
    const org = this.org();
    const { fingerprint256 } = await this.tlsMaterial();
    const bytes = randomBytes(10);
    const raw = Array.from(bytes, (b) => CODE_ALPHABET[b & 31]).join('');
    const nowMs = this.o.nowMs();
    const expiresAtMs = BigInt(nowMs) + LAN_PAIRING_CODE_TTL_MS;
    insertLanPairingCodeSync(this.sqlite, {
      id: this.o.nextId(),
      organizationId: org,
      codeEnc: await this.encrypt(raw),
      createdByUserId: userId,
      expiresAtMs,
      nowMs,
    });
    return {
      code: `${raw.slice(0, 5)}-${raw.slice(5)}`,
      expiresAtMs: expiresAtMs.toString(),
      fingerprint256,
    };
  }

  /** Called by the LAN listener for `POST /lan/pair` (the only unauthenticated LAN route). */
  async pair(input: {
    readonly terminalName: string;
    readonly nonce: string;
    readonly proof: string;
  }): Promise<{
    readonly terminalId: string;
    readonly terminalKey: string;
    readonly hubProof: string;
  }> {
    const org = this.org();
    const { fingerprint256 } = await this.tlsMaterial();
    const nowMs = this.o.nowMs();
    const active = listActiveLanPairingCodesSync(
      this.sqlite,
      org,
      nowMs,
      LAN_PAIRING_MAX_FAILED_ATTEMPTS,
    );
    for (const c of active) {
      const code = await this.decrypt(c.codeEnc);
      if (!sameHex(input.proof, lanPairingProof(code, 'terminal', fingerprint256, input.nonce))) {
        continue;
      }
      const terminalId = this.o.nextId();
      const terminalKey = randomBytes(32).toString('base64url');
      const ok = consumeLanPairingCodeAndAddTerminalSync(this.sqlite, {
        codeId: c.id,
        organizationId: org,
        terminalId,
        name: input.terminalName,
        keyHash: sha256(terminalKey),
        nowMs,
      });
      if (!ok) break; // a concurrent pairing used this code first
      return {
        terminalId,
        terminalKey,
        hubProof: lanPairingProof(code, 'hub', fingerprint256, input.nonce),
      };
    }
    // Unknown which code the caller aimed at: every live code loses an attempt (brute force cap).
    recordLanPairingFailureSync(
      this.sqlite,
      active.map((c) => c.id),
      nowMs,
    );
    throw new DomainError('LAN_PAIRING_REJECTED', 'Pairing code or certificate does not match');
  }

  /** `x-mezon-terminal: <id>.<key>` → the active terminal id, or TERMINAL_NOT_PAIRED. */
  authenticateTerminal(header: string | string[] | undefined): UuidV7 {
    const fail = () =>
      new DomainError('TERMINAL_NOT_PAIRED', 'This device is not a paired terminal');
    if (typeof header !== 'string') throw fail();
    const dot = header.indexOf('.');
    if (dot <= 0) throw fail();
    const t = getLanTerminalSync(this.sqlite, header.slice(0, dot));
    if (t === null || t.status !== 'active' || t.organizationId !== this.o.getOrganizationId()) {
      throw fail();
    }
    if (!sameHex(t.keyHash, sha256(header.slice(dot + 1)))) throw fail();
    touchLanTerminalSync(this.sqlite, t.id, this.o.nowMs());
    return t.id;
  }

  listTerminals(): LanTerminalDto[] {
    return listLanTerminalsSync(this.sqlite, this.org()).map(toDto);
  }

  /** T4.2 per-register sales (non-voided) for a period. */
  salesByTerminal(fromMs: bigint, toMs: bigint) {
    return listSalesByTerminalSync(this.sqlite, { organizationId: this.org(), fromMs, toMs }).map(
      (r) => ({
        terminalId: r.terminalId,
        terminalName: r.terminalName,
        saleCount: r.saleCount,
        totalFinal: r.totalFinal.toString(),
      }),
    );
  }

  revoke(id: UuidV7): LanTerminalDto {
    const t = getLanTerminalSync(this.sqlite, id);
    if (t === null || t.organizationId !== this.org()) {
      throw new DomainError('LAN_TERMINAL_NOT_FOUND', 'Terminal not found');
    }
    revokeLanTerminalSync(this.sqlite, id, this.o.nowMs());
    return toDto(getLanTerminalSync(this.sqlite, id)!);
  }
}
