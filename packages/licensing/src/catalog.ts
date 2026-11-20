/**
 * T4.7 plan catalog — **approved by the owner on 2026-11-17** ("tariflar shundayligicha qoladi").
 *
 * Every value is a single constant, so a later price or limit change is data, not code. Licences
 * carry their own limits (signed), so an issued licence is not affected when this catalog changes.
 */
export const LICENCE_PLANS = ['start', 'business', 'pro'] as const;
export type LicencePlan = (typeof LICENCE_PLANS)[number];

export interface PlanLimits {
  /** `null` = unlimited. */
  readonly maxStores: number | null;
  readonly maxDevices: number | null;
}

export interface PlanCatalogEntry {
  readonly limits: PlanLimits;
  /** Monthly platform fee, tiyin. */
  readonly monthlyPriceTiyin: bigint;
}

/** Start 124 000, Business 249 000, Pro 499 000 so'm per month. */
export const PLAN_CATALOG: Readonly<Record<LicencePlan, PlanCatalogEntry>> = {
  start: { limits: { maxStores: 1, maxDevices: 2 }, monthlyPriceTiyin: 12_400_000n },
  business: { limits: { maxStores: 3, maxDevices: 10 }, monthlyPriceTiyin: 24_900_000n },
  pro: { limits: { maxStores: null, maxDevices: null }, monthlyPriceTiyin: 49_900_000n },
};

/** Free trial after the organization is created, with Business limits. */
export const TRIAL_DAYS = 14;
export const TRIAL_LIMITS: PlanLimits = PLAN_CATALOG.business.limits;

/** After a licence ends: full limits for this many days, with a warning. */
export const GRACE_DAYS = 7;
