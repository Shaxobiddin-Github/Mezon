import {
  DomainError,
  type UnixMs,
  type UuidV7,
  parseUuidV7,
  unixMsFromBigInt,
} from '@mezon/domain';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { LocalSqliteConnection } from './connection.js';
import { localHubConfig, localRulePackages } from './schema/index.js';
import type { SqliteUnitOfWork } from './uow.js';

export interface RulesRuntimeContext {
  readonly uow: SqliteUnitOfWork;
  readonly organizationId: UuidV7;
}

export interface CreateSqliteRulesStoreOptions {
  readonly connection: LocalSqliteConnection;
  readonly getRuntimeContext: () => RulesRuntimeContext | null;
}

export interface StoredRulePackageRecord {
  readonly id: UuidV7;
  readonly packageVersion: bigint;
  readonly keyId: string;
  readonly issuedAtMs: UnixMs;
  readonly validUntilMs: UnixMs;
  /** Canonical envelope JSON exactly as verified on import (re-verified on every load). */
  readonly envelopeJson: string;
  readonly importedByUserId: UuidV7;
  readonly importedAtMs: UnixMs;
  readonly isActive: boolean;
}

/**
 * Already-verified package metadata handed over by the hub. `db-local` never verifies signatures
 * (it does not depend on `@mezon/rules`); the hub verifies before calling `importVerifiedPackage`.
 */
export interface VerifiedRulePackageImport {
  readonly packageVersion: bigint;
  readonly keyId: string;
  readonly issuedAtMs: bigint;
  readonly validUntilMs: bigint;
  readonly envelopeJson: string;
}

export interface RulePackageImportOutcome {
  readonly record: StoredRulePackageRecord;
  readonly idempotentReplay: boolean;
}

function toRecord(row: typeof localRulePackages.$inferSelect): StoredRulePackageRecord {
  return {
    id: row.id,
    packageVersion: BigInt(row.packageVersion),
    keyId: row.keyId,
    issuedAtMs: row.issuedAtMs,
    validUntilMs: row.validUntilMs,
    envelopeJson: row.envelopeJson,
    importedByUserId: row.importedByUserId,
    importedAtMs: row.createdAtMs,
    isActive: Boolean(row.isActive),
  };
}

/** Highest version ever seen: max(config high-water mark, stored package rows). */
export function readMaxRulePackageVersionSync(
  db: BetterSQLite3Database,
  organizationId: UuidV7,
): bigint {
  const cfg = db
    .select({ max: localHubConfig.maxRulePackageVersion })
    .from(localHubConfig)
    .limit(1)
    .all()[0];
  const rows = db
    .select({ max: sql<bigint | null>`max(${localRulePackages.packageVersion})` })
    .from(localRulePackages)
    .where(eq(localRulePackages.organizationId, organizationId))
    .all()[0];
  const a = cfg ? BigInt(cfg.max) : 0n;
  const b = rows?.max !== null && rows?.max !== undefined ? BigInt(rows.max) : 0n;
  return a > b ? a : b;
}

export function readFiscalModeEnabledSync(db: BetterSQLite3Database): boolean {
  const row = db
    .select({ on: localHubConfig.fiscalModeEnabled })
    .from(localHubConfig)
    .limit(1)
    .all()[0];
  return row ? Boolean(row.on) : false;
}

export class SqliteRulesStore {
  private readonly connection: LocalSqliteConnection;
  private readonly getRuntimeContext: () => RulesRuntimeContext | null;

  constructor(options: CreateSqliteRulesStoreOptions) {
    this.connection = options.connection;
    this.getRuntimeContext = options.getRuntimeContext;
  }

  private requireContext(): RulesRuntimeContext {
    const ctx = this.getRuntimeContext();
    if (ctx === null) {
      throw new DomainError('AUTH_UNAUTHORIZED', 'Hub setup has not been completed');
    }
    return ctx;
  }

  /** Active package row (or null) — read without a context for the hub's evaluator loader. */
  getActivePackageSync(organizationId: UuidV7): StoredRulePackageRecord | null {
    const row = this.connection.db
      .select()
      .from(localRulePackages)
      .where(
        and(
          eq(localRulePackages.organizationId, organizationId),
          eq(localRulePackages.isActive, true),
        ),
      )
      .limit(1)
      .all()[0];
    return row ? toRecord(row) : null;
  }

  isFiscalModeEnabledSync(): boolean {
    return readFiscalModeEnabledSync(this.connection.db);
  }

  /** Store timezone for the store-local business date used by date-based rules. */
  getStoreTimezoneSync(): string {
    const row = this.connection.db
      .select({ tz: localHubConfig.storeTimezone })
      .from(localHubConfig)
      .limit(1)
      .all()[0];
    return row?.tz ?? 'Asia/Tashkent';
  }

  async listPackages(): Promise<readonly StoredRulePackageRecord[]> {
    const { uow, organizationId } = this.requireContext();
    return uow.runReadOnly(() =>
      Promise.resolve(
        this.connection.db
          .select()
          .from(localRulePackages)
          .where(eq(localRulePackages.organizationId, organizationId))
          .orderBy(desc(localRulePackages.packageVersion))
          .all()
          .map(toRecord),
      ),
    );
  }

  /**
   * Re-derives the rollback high-water mark after startup / backup restore so the config value is
   * never lower than any stored package version.
   */
  async recomputeMaxVersion(floor: bigint = 0n): Promise<bigint> {
    const { uow, organizationId } = this.requireContext();
    return uow.execute((session) => {
      const stored = readMaxRulePackageVersionSync(session.db, organizationId);
      const max = stored > floor ? stored : floor;
      session.db.update(localHubConfig).set({ maxRulePackageVersion: max }).run();
      return Promise.resolve(max);
    });
  }

  /**
   * Imports an already-verified package in ONE transaction: rollback check against the high-water
   * mark, deactivate the current package, insert + activate the new one, advance the mark.
   * Same version with identical bytes is an idempotent replay; same version with different bytes
   * is a conflict; any version ≤ high-water mark is a rollback and is rejected.
   */
  async importVerifiedPackage(
    pkg: VerifiedRulePackageImport,
    actorUserId: UuidV7,
  ): Promise<RulePackageImportOutcome> {
    const { uow, organizationId } = this.requireContext();
    const actor = parseUuidV7(actorUserId);
    return uow.execute<RulePackageImportOutcome>((session) => {
      const sameVersion = session.db
        .select()
        .from(localRulePackages)
        .where(
          and(
            eq(localRulePackages.organizationId, organizationId),
            eq(localRulePackages.packageVersion, pkg.packageVersion),
          ),
        )
        .limit(1)
        .all()[0];
      if (sameVersion !== undefined) {
        if (sameVersion.envelopeJson === pkg.envelopeJson) {
          return Promise.resolve({ record: toRecord(sameVersion), idempotentReplay: true });
        }
        throw new DomainError(
          'RULES_PACKAGE_CONFLICT',
          `Rules package version ${pkg.packageVersion.toString()} already exists with different content`,
        );
      }

      const max = readMaxRulePackageVersionSync(session.db, organizationId);
      if (pkg.packageVersion <= max) {
        throw new DomainError(
          'RULES_PACKAGE_ROLLBACK',
          `Rules package version ${pkg.packageVersion.toString()} is not newer than ${max.toString()}`,
          { details: { maxVersion: max.toString() } },
        );
      }

      const nowMs = session.nowUnixMs();
      session.db
        .update(localRulePackages)
        .set({ isActive: false, updatedAtMs: nowMs })
        .where(
          and(
            eq(localRulePackages.organizationId, organizationId),
            eq(localRulePackages.isActive, true),
          ),
        )
        .run();
      const row = session.db
        .insert(localRulePackages)
        .values({
          id: session.nextId(),
          organizationId,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
          packageVersion: pkg.packageVersion,
          keyId: pkg.keyId,
          issuedAtMs: unixMsFromBigInt(pkg.issuedAtMs),
          validUntilMs: unixMsFromBigInt(pkg.validUntilMs),
          envelopeJson: pkg.envelopeJson,
          importedByUserId: actor,
          isActive: true,
        })
        .returning()
        .all()[0];
      session.db.update(localHubConfig).set({ maxRulePackageVersion: pkg.packageVersion }).run();
      if (row === undefined) {
        throw new Error('Rules package insert returned no row');
      }
      return Promise.resolve({ record: toRecord(row), idempotentReplay: false });
    });
  }
}

export function createSqliteRulesStore(options: CreateSqliteRulesStoreOptions): SqliteRulesStore {
  return new SqliteRulesStore(options);
}
