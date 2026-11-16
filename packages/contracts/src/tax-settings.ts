import { z } from 'zod';
import { BigIntStringSchema, UuidV7Schema } from './auth.js';
import { VatRateBpSchema } from './catalog.js';

/**
 * Organization TIN (STIR): exactly 9 ASCII digits after trimming.
 * Only the documented length/digit format is enforced; no checksum algorithm is invented (GEMINI.md 3.3).
 */
export const TinSchema = z
  .string()
  .transform((val) => val.trim())
  .pipe(z.string().regex(/^[0-9]{9}$/, { message: 'INVALID_TIN' }));

const TaxTextSchema = (max: number) =>
  z
    .string()
    .transform((val) => val.normalize('NFC').trim())
    .pipe(z.string().min(1).max(max));

export const LegalNameSchema = TaxTextSchema(256);
export const LegalAddressSchema = TaxTextSchema(512);

export const OrganizationTaxProfileSchema = z.strictObject({
  id: UuidV7Schema,
  organizationId: UuidV7Schema,
  tin: z.string(),
  legalName: z.string(),
  legalAddress: z.string(),
  isVatPayer: z.boolean(),
  defaultVatRateBp: VatRateBpSchema,
  updatedByUserId: UuidV7Schema,
  updatedAtMs: BigIntStringSchema,
});
export type OrganizationTaxProfileDto = z.infer<typeof OrganizationTaxProfileSchema>;

export const TaxProfileResponseSchema = z.strictObject({
  profile: OrganizationTaxProfileSchema.nullable(),
});
export type TaxProfileResponseDto = z.infer<typeof TaxProfileResponseSchema>;

export const UpdateTaxProfileRequestSchema = z.strictObject({
  tin: TinSchema,
  legalName: LegalNameSchema,
  legalAddress: LegalAddressSchema,
  isVatPayer: z.boolean(),
  defaultVatRateBp: VatRateBpSchema,
});
export type UpdateTaxProfileRequestDto = z.infer<typeof UpdateTaxProfileRequestSchema>;

export const MissingMxikCountResponseSchema = z.strictObject({
  count: z.number().int().min(0),
});
export type MissingMxikCountResponseDto = z.infer<typeof MissingMxikCountResponseSchema>;
