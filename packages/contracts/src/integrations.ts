import { z } from 'zod';
import { CartDetailSchema } from './cart.js';

/**
 * V2 QR payment intent as the kassa sees it (hub `HubPaymentService` DTO). Money is tiyin as a
 * string; `qrPayload` is shown as a QR picture and never parsed.
 */
export const PaymentIntentStatusSchema = z.enum([
  'pending',
  'paid',
  'expired',
  'cancelled',
  'failed',
  'amount_mismatch',
  'refunding',
  'refunded',
]);

export const PaymentIntentDtoSchema = z.object({
  id: z.string(),
  kind: z.enum(['dynamic', 'static']),
  amount: z.string(),
  status: PaymentIntentStatusSchema,
  providerRef: z.string(),
  qrPayload: z.string().nullable(),
  expiresAtMs: z.string(),
  paidLate: z.boolean(),
  consumedBySaleId: z.string().nullable(),
  receivedAmount: z.string().nullable(),
  isTestDriver: z.boolean(),
  demoPayAllowed: z.boolean(),
});
export type PaymentIntentDto = z.infer<typeof PaymentIntentDtoSchema>;

export const PaymentIntentResponseSchema = z.object({ intent: PaymentIntentDtoSchema });

const DriverInfoSchema = z.object({ driverId: z.string(), isTestDriver: z.boolean() });

/** V2 GET /settings/integrations: what is real, what is a demo, what is still missing. */
export const IntegrationsStatusResponseSchema = z.object({
  demoMode: z.boolean(),
  fiscal: DriverInfoSchema.extend({ modeEnabled: z.boolean() }),
  payment: DriverInfoSchema,
  marking: DriverInfoSchema.extend({ mxikPrefixes: z.array(z.string()) }),
  rules: z.object({
    state: z.enum(['ok', 'missing', 'expired', 'invalid']),
    isDemoPackage: z.boolean(),
    packageVersion: z.string().nullable(),
  }),
});
export type IntegrationsStatusResponse = z.infer<typeof IntegrationsStatusResponseSchema>;

export const SetDemoModeRequestSchema = z.strictObject({ enabled: z.boolean() });

export const SetMarkingPrefixesRequestSchema = z.strictObject({
  prefixes: z
    .array(
      z
        .string()
        .trim()
        .regex(/^\d{2,17}$/),
    )
    .max(200),
});

export const CartMarkDtoSchema = z.object({
  id: z.string(),
  cartLineId: z.string(),
  codeKey: z.string(),
  checkStatus: z.enum(['ok', 'unchecked']),
});
export type CartMarkDto = z.infer<typeof CartMarkDtoSchema>;

/** POST /carts/:id/marks and DELETE /carts/:id/marks/:markId. */
export const CartMarksResponseSchema = z.object({
  cart: CartDetailSchema,
  checkStatus: z.enum(['ok', 'unchecked']).optional(),
  marks: z.array(CartMarkDtoSchema),
});
export type CartMarksResponseDto = z.infer<typeof CartMarksResponseSchema>;

export const CartMarksListResponseSchema = z.object({ marks: z.array(CartMarkDtoSchema) });
