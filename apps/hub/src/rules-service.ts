import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import type { SaleRulesEvaluator, SqliteRulesStore } from '@mezon/db-local';
import { type UnixMs, type UuidV7, getBusinessDateKey, unixMsFromBigInt } from '@mezon/domain';
import {
  type RulesCartInput,
  type RulesContext,
  type RulesPackageState,
  type RulesPaymentInput,
  type RulesResult,
  type RulesSignatureVerifier,
  type TrustedRuleKey,
  type VerifiedRulesPackage,
  evaluate,
  resolveRulesPackageState,
  rulesEnvelopeToCanonicalJson,
  verifyRulesPackage,
} from '@mezon/rules';
import type { Logger } from 'pino';

/** RFC 8410 SPKI DER prefix for a raw 32-byte Ed25519 public key. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Ed25519 implementation of the rules signature port (`node:crypto`). */
export const nodeEd25519RulesVerifier: RulesSignatureVerifier = {
  verifyEd25519(publicKeyB64: string, message: string, signatureB64: string): boolean {
    const raw = Buffer.from(publicKeyB64, 'base64');
    const sig = Buffer.from(signatureB64, 'base64');
    if (raw.length !== 32 || sig.length !== 64) {
      return false;
    }
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
      format: 'der',
      type: 'spki',
    });
    return cryptoVerify(null, Buffer.from(message, 'utf8'), key, sig);
  },
};

function dateKeyResolver(timeZone: string): (unixMs: bigint) => string {
  // Domain resolves Asia/Tashkent and UTC itself; other IANA zones use Intl (hub may use it).
  return (unixMs: bigint) =>
    getBusinessDateKey(unixMsFromBigInt(unixMs), timeZone, (ms: UnixMs, tz: string) =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(Number(ms))),
    );
}

export interface RulesPackageStatus {
  readonly state: RulesPackageState;
  readonly fiscalMode: boolean;
  readonly package: VerifiedRulesPackage | null;
}

export interface HubRulesServiceOptions {
  readonly store: SqliteRulesStore;
  readonly trustedKeys: readonly TrustedRuleKey[];
  readonly verifier: RulesSignatureVerifier;
  readonly getOrganizationId: () => UuidV7 | null;
  readonly nowMs: () => bigint;
  readonly logger?: Logger;
}

/**
 * Hub side of T3.2: verifies/imports signed packages, re-verifies the stored package on every load
 * (cached by exact canonical bytes) and builds the SINGLE evaluator injected into the sale and order
 * stores (`completeSaleCoreInTxSync`) and reused by the preview endpoint.
 */
export class HubRulesService {
  private readonly opts: HubRulesServiceOptions;
  /**
   * Cache keyed by EVERY stored column that the verdict depends on (row id, version column and the
   * exact envelope bytes). A change to any of them forces a full re-verification (C3/C4).
   */
  private cache: {
    readonly rowId: string;
    readonly packageVersion: bigint;
    readonly envelopeJson: string;
    readonly pkg: VerifiedRulesPackage;
  } | null = null;

  constructor(opts: HubRulesServiceOptions) {
    this.opts = opts;
  }

  /** Loads + re-verifies the active package. Tampered rows yield state `invalid` (never trusted). */
  loadStatusSync(nowMs: bigint): RulesPackageStatus {
    const fiscalMode = this.opts.store.isFiscalModeEnabledSync();
    const orgId = this.opts.getOrganizationId();
    const row = orgId === null ? null : this.opts.store.getActivePackageSync(orgId);
    if (row === null) {
      return { state: 'missing', fiscalMode, package: null };
    }
    if (
      this.cache !== null &&
      this.cache.rowId === row.id &&
      this.cache.packageVersion === row.packageVersion &&
      this.cache.envelopeJson === row.envelopeJson
    ) {
      return {
        state: resolveRulesPackageState(this.cache.pkg, false, nowMs),
        fiscalMode,
        package: this.cache.pkg,
      };
    }
    try {
      const pkg = verifyRulesPackage(
        JSON.parse(row.envelopeJson) as unknown,
        this.opts.trustedKeys,
        this.opts.verifier,
      );
      if (pkg.payload.packageVersion !== row.packageVersion) {
        throw new Error('stored version does not match signed payload');
      }
      this.cache = {
        rowId: row.id,
        packageVersion: row.packageVersion,
        envelopeJson: row.envelopeJson,
        pkg,
      };
      return { state: resolveRulesPackageState(pkg, false, nowMs), fiscalMode, package: pkg };
    } catch (err) {
      this.cache = null;
      this.opts.logger?.error(
        { event: 'rules.package_invalid', packageVersion: row.packageVersion.toString(), err },
        'Stored rules package failed re-verification; treated as invalid',
      );
      return { state: 'invalid', fiscalMode, package: null };
    }
  }

  private context(nowMs: bigint, phase: RulesContext['phase']): RulesContext {
    const status = this.loadStatusSync(nowMs);
    const toDateKey = dateKeyResolver(this.opts.store.getStoreTimezoneSync());
    return {
      nowMs,
      todayDateKey: toDateKey(nowMs),
      toDateKey,
      pkg: status.package,
      pkgState: status.state,
      fiscalMode: status.fiscalMode,
      phase,
    };
  }

  /** Same pure `evaluate` for the preview endpoint (no FIFO legs yet). */
  preview(cart: RulesCartInput, payments: readonly RulesPaymentInput[]): RulesResult {
    return evaluate(cart, payments, this.context(this.opts.nowMs(), 'preview'));
  }

  /** The single evaluator handed to the sale/order stores (final phase, inside the sale tx). */
  readonly saleEvaluator: SaleRulesEvaluator = (input) =>
    evaluate({ lines: input.lines }, input.payments, this.context(BigInt(input.nowMs), 'final'));

  /**
   * Verifies a wire envelope and imports it atomically (rollback/conflict checks in the store).
   * Only the canonical re-serialization of the verified envelope is stored.
   */
  async importPackage(raw: unknown, actorUserId: UuidV7) {
    const pkg = verifyRulesPackage(raw, this.opts.trustedKeys, this.opts.verifier);
    const outcome = await this.opts.store.importVerifiedPackage(
      {
        packageVersion: pkg.payload.packageVersion,
        keyId: pkg.keyId,
        issuedAtMs: pkg.payload.issuedAtMs,
        validUntilMs: pkg.payload.validUntilMs,
        envelopeJson: rulesEnvelopeToCanonicalJson(pkg.envelope),
      },
      actorUserId,
    );
    this.cache = null;
    return outcome;
  }
}
