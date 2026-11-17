import { FISCAL_DOC_KINDS, FISCAL_DOC_STATUSES, FISCAL_RECEIPT_FIELD_KEYS } from '@mezon/domain';
import { z } from 'zod';
import { UuidV7Schema } from './auth.js';

/** Integer-as-string for UnixMs / durations on the wire. */
const MsStringSchema = z.string().regex(/^(0|[1-9][0-9]{0,18})$/);

/**
 * T3.4 receipt fiscal field configuration (`local_hub_config.fiscal_receipt_fields_json`,
 * [TASDIQLANSIN]). Only opaque driver values and the organization TIN may be referenced.
 */
export const FiscalReceiptFieldsConfigSchema = z
  .array(
    z.strictObject({
      key: z.enum(FISCAL_RECEIPT_FIELD_KEYS),
      label: z.string().trim().min(1).max(32),
    }),
  )
  .max(16)
  .refine((rows) => new Set(rows.map((r) => r.key)).size === rows.length, {
    message: 'duplicate fiscal receipt field key',
  });
export type FiscalReceiptFieldsConfig = z.infer<typeof FiscalReceiptFieldsConfigSchema>;

export const FiscalDocStatusSchema = z.enum(FISCAL_DOC_STATUSES);
export const FiscalDocKindSchema = z.enum(FISCAL_DOC_KINDS);

export const FiscalDocDtoSchema = z.strictObject({
  id: UuidV7Schema,
  docKind: FiscalDocKindSchema,
  saleId: UuidV7Schema.nullable(),
  returnId: UuidV7Schema.nullable(),
  shiftId: UuidV7Schema.nullable(),
  dependsOnDocId: UuidV7Schema.nullable(),
  receiptCode: z.string().nullable(),
  status: FiscalDocStatusSchema,
  attempts: z.number().int().nonnegative(),
  lastErrorCode: z.string().nullable(),
  lastErrorMessage: z.string().nullable(),
  sentAtMs: MsStringSchema.nullable(),
  confirmedAtMs: MsStringSchema.nullable(),
  fiscalSign: z.string().nullable(),
  fiscalNumber: z.string().nullable(),
  driverId: z.string(),
  offlineDeadlineMs: MsStringSchema,
  createdAtMs: MsStringSchema,
});
export type FiscalDocDto = z.infer<typeof FiscalDocDtoSchema>;

/** Offline-window warning level: `approaching` from 75 % of the window, `expired` past the deadline. */
export const FiscalOfflineWarningSchema = z.enum(['none', 'approaching', 'expired']);
export type FiscalOfflineWarning = z.infer<typeof FiscalOfflineWarningSchema>;

export const FiscalStatusResponseSchema = z.strictObject({
  modeEnabled: z.boolean(),
  driverId: z.string(),
  isTestDriver: z.boolean(),
  counts: z.record(FiscalDocStatusSchema, z.number().int().nonnegative()),
  oldestDeadlineMs: MsStringSchema.nullable(),
  offlineWindowMs: MsStringSchema,
  offlineWarning: FiscalOfflineWarningSchema,
  offlineExpiredAction: z.enum(['warn', 'block']),
  shiftNotOpenAction: z.enum(['warn', 'block']),
  shiftNotOpenOnDriver: z.boolean(),
  receiptFieldsValid: z.boolean(),
});
export type FiscalStatusResponse = z.infer<typeof FiscalStatusResponseSchema>;

export const FiscalUnsettledListResponseSchema = z.strictObject({
  docs: z.array(FiscalDocDtoSchema),
});

export const FiscalDocResponseSchema = z.strictObject({ doc: FiscalDocDtoSchema });

export const SaleFiscalResponseSchema = z.strictObject({
  doc: FiscalDocDtoSchema.nullable(),
  isTestDriver: z.boolean(),
});

export const SetFiscalModeRequestSchema = z.strictObject({ enabled: z.boolean() });
export const SetFiscalModeResponseSchema = z.strictObject({ modeEnabled: z.boolean() });
