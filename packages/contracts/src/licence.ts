import { z } from 'zod';

/** T4.7: hub `GET /licence/status` (POS banner). */
export const LicenceStatusResponseSchema = z
  .object({
    state: z.enum(['unknown', 'trial', 'active', 'grace', 'expired']),
    plan: z.enum(['start', 'business', 'pro']).nullable(),
    daysLeft: z.number().int().nullable(),
    invalidLicence: z.boolean(),
    fetchedAtMs: z.string().nullable(),
  })
  .strict();

export type LicenceStatusResponseDto = z.infer<typeof LicenceStatusResponseSchema>;
