import {
  DomainError,
  effectiveVatRate,
  vatRateToBasisPoints,
  type UnixMs,
  type UuidV7,
  parseUuidV7,
  vatRateFromBasisPoints,
} from '@mezon/domain';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { LocalSqliteConnection } from './connection.js';
import { organizationTaxProfiles } from './schema/index.js';
import type { SqliteUnitOfWork } from './uow.js';
import { insertAttr, restoreAttr, updateAttr } from './writers.js';

export interface TaxSettingsRuntimeContext {
  readonly uow: SqliteUnitOfWork;
  readonly organizationId: UuidV7;
}

export interface CreateSqliteTaxSettingsStoreOptions {
  readonly connection: LocalSqliteConnection;
  readonly getRuntimeContext: () => TaxSettingsRuntimeContext | null;
}

export interface StoredTaxProfileRecord {
  readonly id: UuidV7;
  readonly organizationId: UuidV7;
  readonly tin: string;
  readonly legalName: string;
  readonly legalAddress: string;
  readonly isVatPayer: boolean;
  readonly defaultVatRateBp: number;
  readonly updatedByUserId: UuidV7;
  readonly updatedAtMs: UnixMs;
}

export interface UpsertTaxProfileInput {
  readonly tin: string;
  readonly legalName: string;
  readonly legalAddress: string;
  readonly isVatPayer: boolean;
  readonly defaultVatRateBp: number;
}

/**
 * VAT settings consulted when snapshotting NEW cart/order lines.
 * No profile yet ⇒ `isVatPayer: true` + `defaultVatRateBp: 0`, i.e. exactly the pre-T3.1 behaviour
 * (each product's own `vat_rate_bp` is snapshotted unchanged).
 */
export interface EffectiveVatSettings {
  readonly isVatPayer: boolean;
  readonly defaultVatRateBp: number;
}

export const DEFAULT_VAT_SETTINGS: EffectiveVatSettings = {
  isVatPayer: true,
  defaultVatRateBp: 0,
};

/**
 * Storage-layer wrapper of domain `effectiveVatRate` for raw `vat_rate_bp` integers (domain forbids
 * `Number`). Used for every NEW cart/order line snapshot (T3.1 S2).
 */
export function effectiveVatRateBp(productRateBp: number, isVatPayer: boolean): number {
  const rate = vatRateFromBasisPoints(BigInt(productRateBp));
  return Number(vatRateToBasisPoints(effectiveVatRate(rate, isVatPayer)));
}

const TIN_REGEX = /^[0-9]{9}$/;

function toStoredTaxProfile(
  row: typeof organizationTaxProfiles.$inferSelect,
): StoredTaxProfileRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    tin: row.tin,
    legalName: row.legalName,
    legalAddress: row.legalAddress,
    isVatPayer: Boolean(row.isVatPayer),
    defaultVatRateBp: Number(row.defaultVatRateBp),
    updatedByUserId: row.updatedByUserId,
    updatedAtMs: row.updatedAtMs,
  };
}

function normalizeRequiredText(raw: string, field: string, max: number): string {
  const clean = raw.normalize('NFC').trim();
  if (clean.length === 0 || clean.length > max) {
    throw new DomainError('VALIDATION_ERROR', `${field} must be 1–${String(max)} characters`);
  }
  return clean;
}

/**
 * Reads the active tax profile row for `organizationId` using any drizzle handle (plain connection
 * or an active UnitOfWork session db), so snapshot writers can consult it inside their own tx.
 */
export function readTaxProfileRowSync(
  db: BetterSQLite3Database,
  organizationId: UuidV7,
): typeof organizationTaxProfiles.$inferSelect | null {
  return (
    db
      .select()
      .from(organizationTaxProfiles)
      .where(
        and(
          eq(organizationTaxProfiles.organizationId, organizationId),
          isNull(organizationTaxProfiles.deletedAtMs),
        ),
      )
      .limit(1)
      .all()[0] ?? null
  );
}

/**
 * True when the T3.1 table exists. Not cached: a connection may be migrated forward later
 * (e.g. the 0006→0007 upgrade test populates sales with current cart code BEFORE migrating).
 */
function hasTaxProfilesTableSync(db: BetterSQLite3Database): boolean {
  const row = db.get<{ readonly n: number }>(
    sql`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'organization_tax_profiles'`,
  );
  return Number(row.n) > 0;
}

/**
 * VAT settings for snapshotting NEW lines. On a database not yet migrated to the T3.1 schema the
 * pre-T3.1 behaviour (`DEFAULT_VAT_SETTINGS`) applies, keeping the cart/sale path compatible with
 * older schemas exactly as before; production hubs always migrate to the latest schema at startup.
 */
export function readEffectiveVatSettingsSync(
  db: BetterSQLite3Database,
  organizationId: UuidV7,
): EffectiveVatSettings {
  if (!hasTaxProfilesTableSync(db)) {
    return DEFAULT_VAT_SETTINGS;
  }
  const row = readTaxProfileRowSync(db, organizationId);
  if (row === null) {
    return DEFAULT_VAT_SETTINGS;
  }
  return {
    isVatPayer: Boolean(row.isVatPayer),
    defaultVatRateBp: Number(row.defaultVatRateBp),
  };
}

export class SqliteTaxSettingsStore {
  private readonly connection: LocalSqliteConnection;
  private readonly getRuntimeContext: () => TaxSettingsRuntimeContext | null;

  constructor(options: CreateSqliteTaxSettingsStoreOptions) {
    this.connection = options.connection;
    this.getRuntimeContext = options.getRuntimeContext;
  }

  private requireContext(): TaxSettingsRuntimeContext {
    const ctx = this.getRuntimeContext();
    if (ctx === null) {
      throw new DomainError('AUTH_UNAUTHORIZED', 'Hub setup has not been completed');
    }
    return ctx;
  }

  async getProfile(): Promise<StoredTaxProfileRecord | null> {
    const { uow, organizationId } = this.requireContext();
    return uow.runReadOnly(() => {
      const row = readTaxProfileRowSync(this.connection.db, organizationId);
      return Promise.resolve(row === null ? null : toStoredTaxProfile(row));
    });
  }

  async getEffectiveVatSettings(): Promise<EffectiveVatSettings> {
    const { uow, organizationId } = this.requireContext();
    return uow.runReadOnly(() =>
      Promise.resolve(readEffectiveVatSettingsSync(this.connection.db, organizationId)),
    );
  }

  /**
   * Creates or updates the organization's single tax profile in one UnitOfWork transaction with
   * its `local_outbox` ATTR event. The entity id is always `organization_id` (nazoratchi T1) and the
   * acting user is persisted as `updated_by_user_id` and carried in the event payload (nazoratchi T3).
   */
  async upsertProfile(
    input: UpsertTaxProfileInput,
    actorUserId: UuidV7,
  ): Promise<StoredTaxProfileRecord> {
    const { uow, organizationId } = this.requireContext();
    const tin = input.tin.trim();
    if (!TIN_REGEX.test(tin)) {
      throw new DomainError('VALIDATION_ERROR', 'INVALID_TIN');
    }
    const values = {
      tin,
      legalName: normalizeRequiredText(input.legalName, 'Legal name', 256),
      legalAddress: normalizeRequiredText(input.legalAddress, 'Legal address', 512),
      isVatPayer: input.isVatPayer,
      defaultVatRateBp: Number(vatRateFromBasisPoints(BigInt(input.defaultVatRateBp))),
      updatedByUserId: parseUuidV7(actorUserId),
    };

    return uow.execute((session) => {
      const existing = readTaxProfileRowSync(session.db, organizationId);
      if (existing === null) {
        // K2: the deterministic id (= organization_id) may already exist as a TOMBSTONE (e.g. a
        // delete applied by sync). Restore that row instead of INSERTing a colliding primary key.
        const tombstoned = session.db
          .select({ id: organizationTaxProfiles.id })
          .from(organizationTaxProfiles)
          .where(
            and(
              eq(organizationTaxProfiles.id, organizationId),
              eq(organizationTaxProfiles.organizationId, organizationId),
            ),
          )
          .limit(1)
          .all()[0];
        if (tombstoned !== undefined) {
          const res = restoreAttr(session, organizationTaxProfiles, {
            id: organizationId,
            organizationId,
            values,
            eventType: 'organization_tax_profile.restored',
            schemaVersion: 1,
          });
          return Promise.resolve(toStoredTaxProfile(res.row));
        }
        const res = insertAttr(session, organizationTaxProfiles, {
          entityId: organizationId,
          organizationId,
          values,
          eventType: 'organization_tax_profile.created',
          schemaVersion: 1,
        });
        return Promise.resolve(toStoredTaxProfile(res.row));
      }
      const res = updateAttr(session, organizationTaxProfiles, {
        id: existing.id,
        organizationId,
        values,
        eventType: 'organization_tax_profile.updated',
        schemaVersion: 1,
      });
      return Promise.resolve(toStoredTaxProfile(res.row));
    });
  }
}

export function createSqliteTaxSettingsStore(
  options: CreateSqliteTaxSettingsStoreOptions,
): SqliteTaxSettingsStore {
  return new SqliteTaxSettingsStore(options);
}
