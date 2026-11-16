import { z } from 'zod';
import { BigIntStringSchema, UuidV7Schema } from './auth.js';
import { SalePaymentInputSchema } from './sale.js';

/**
 * T3.2 signed rules package — wire (JSON) schemas. The hub additionally re-parses strictly with
 * `@mezon/rules` `parseRulesEnvelope` before signature verification; both share fixtures in tests.
 */
const UintStringSchema = z.string().regex(/^(0|[1-9][0-9]{0,18})$/, 'canonical uint string');
const MxikCodeSchema = z.string().regex(/^[A-Za-z0-9._/-]{1,32}$/);
const MxikMatchListSchema = z.strictObject({
  exact: z.array(MxikCodeSchema).max(100_000),
  prefixes: z.array(MxikCodeSchema).max(100_000),
});

export const RulesPayloadWireSchema = z.strictObject({
  packageVersion: UintStringSchema,
  issuedAtMs: UintStringSchema,
  validUntilMs: UintStringSchema,
  sourceRefs: z.array(z.string().min(1).max(256)).max(64),
  cashForbidden: MxikMatchListSchema,
  perMxikCashLimit: z
    .strictObject({
      limitTiyin: UintStringSchema,
      appliesTo: z.enum(['cash', 'mxikTotal']),
      inclusive: z.boolean(),
      exempt: MxikMatchListSchema,
    })
    .nullable(),
  expiredGoods: z.strictObject({ enabled: z.boolean() }),
});
export type RulesPayloadWireDto = z.infer<typeof RulesPayloadWireSchema>;

export const RulesPackageEnvelopeWireSchema = z.strictObject({
  format: z.literal('mezon-rules'),
  formatVersion: z.literal(1),
  keyId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  payload: RulesPayloadWireSchema,
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/, 'base64 Ed25519 signature (64 bytes)'),
});
export type RulesPackageEnvelopeWireDto = z.infer<typeof RulesPackageEnvelopeWireSchema>;

export const ImportRulesPackageRequestSchema = z.strictObject({
  envelope: RulesPackageEnvelopeWireSchema,
});
export type ImportRulesPackageRequestDto = z.infer<typeof ImportRulesPackageRequestSchema>;

export const ImportRulesPackageResponseSchema = z.strictObject({
  packageVersion: BigIntStringSchema,
  keyId: z.string(),
  validUntilMs: BigIntStringSchema,
  importedByUserId: UuidV7Schema,
  idempotentReplay: z.boolean(),
});
export type ImportRulesPackageResponseDto = z.infer<typeof ImportRulesPackageResponseSchema>;

export const RulesPackageStateSchema = z.enum(['ok', 'missing', 'expired', 'invalid']);

export const ActiveRulesPackageResponseSchema = z.strictObject({
  state: RulesPackageStateSchema,
  fiscalMode: z.boolean(),
  packageVersion: BigIntStringSchema.nullable(),
  keyId: z.string().nullable(),
  issuedAtMs: BigIntStringSchema.nullable(),
  validUntilMs: BigIntStringSchema.nullable(),
  /** Verified payload so the POS can run the same `evaluate` locally (no signature check in UI). */
  payload: RulesPayloadWireSchema.nullable(),
});
export type ActiveRulesPackageResponseDto = z.infer<typeof ActiveRulesPackageResponseSchema>;

export const RuleFindingSchema = z.strictObject({
  code: z.string(),
  i18nKey: z.string(),
  lineIds: z.array(z.string()),
  details: z.record(z.string(), z.string()).optional(),
});
export type RuleFindingDto = z.infer<typeof RuleFindingSchema>;

export const RulesCheckRequestSchema = z.strictObject({
  payments: z.array(SalePaymentInputSchema).max(64).default([]),
});
export type RulesCheckRequestDto = z.infer<typeof RulesCheckRequestSchema>;

export const RulesCheckResponseSchema = z.strictObject({
  block: z.array(RuleFindingSchema),
  warn: z.array(RuleFindingSchema),
  packageVersion: z.string().nullable(),
});
export type RulesCheckResponseDto = z.infer<typeof RulesCheckResponseSchema>;
