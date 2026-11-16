import { z } from 'zod';

export const CloudDevicePlatformSchema = z.enum(['windows', 'android', 'linux']);
export type CloudDevicePlatform = z.infer<typeof CloudDevicePlatformSchema>;

export const CloudDeviceStatusSchema = z.enum(['active', 'blocked', 'revoked']);
export type CloudDeviceStatus = z.infer<typeof CloudDeviceStatusSchema>;

export const CloudCreatePairingCodeRequestSchema = z.object({
  storeId: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
});
export type CloudCreatePairingCodeRequestDto = z.infer<typeof CloudCreatePairingCodeRequestSchema>;

export const CloudCreatePairingCodeResponseSchema = z.object({
  code: z.string().regex(/^[2-9A-HJ-NP-Z]{8}$/, 'Pairing code must be 8 alphanumeric characters'),
  expiresAtMs: z.number().int().positive(),
  storeId: z.string().uuid(),
  storeName: z.string(),
});
export type CloudCreatePairingCodeResponseDto = z.infer<
  typeof CloudCreatePairingCodeResponseSchema
>;

export const CloudPairDeviceRequestSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[2-9A-HJ-NP-Z]{8}$/, 'Pairing code must be 8 alphanumeric characters'),
  deviceId: z.string().uuid(),
  platform: CloudDevicePlatformSchema,
  appVersion: z.string().trim().min(1).max(50),
});
export type CloudPairDeviceRequestDto = z.infer<typeof CloudPairDeviceRequestSchema>;

export const CloudPairDeviceResponseSchema = z.object({
  deviceToken: z.string().min(20),
  organizationId: z.string().uuid(),
  storeId: z.string().uuid(),
  storeName: z.string(),
  organizationName: z.string(),
});
export type CloudPairDeviceResponseDto = z.infer<typeof CloudPairDeviceResponseSchema>;

export const CloudRotateDeviceTokenRequestSchema = z.object({
  clientRequestId: z.string().uuid(),
});
export type CloudRotateDeviceTokenRequestDto = z.infer<typeof CloudRotateDeviceTokenRequestSchema>;

export const CloudRotateDeviceTokenResponseSchema = z.object({
  deviceToken: z.string().min(20),
  expiresAtMs: z.number().int().positive(),
});
export type CloudRotateDeviceTokenResponseDto = z.infer<
  typeof CloudRotateDeviceTokenResponseSchema
>;

export const CloudDeviceDtoSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  storeId: z.string().uuid(),
  deviceId: z.string().uuid(),
  name: z.string(),
  platform: CloudDevicePlatformSchema,
  appVersion: z.string(),
  status: CloudDeviceStatusSchema,
  lastSeenAtMs: z.number().int().positive(),
  createdAtMs: z.number().int().positive(),
});
export type CloudDeviceDto = z.infer<typeof CloudDeviceDtoSchema>;

export const HubCloudStatusSchema = z.object({
  status: z.enum(['unpaired', 'paired', 'revoked']),
  cloudUrl: z.string().url().nullable().optional(),
  organizationId: z.string().uuid().nullable().optional(),
  storeId: z.string().uuid().nullable().optional(),
  pairedAtMs: z.number().int().positive().nullable().optional(),
  lastSyncAtMs: z.number().int().positive().nullable().optional(),
});
export type HubCloudStatusDto = z.infer<typeof HubCloudStatusSchema>;

export const HubPairCloudRequestSchema = z.object({
  cloudUrl: z.string().url(),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[2-9A-HJ-NP-Z]{8}$/),
});
export type HubPairCloudRequestDto = z.infer<typeof HubPairCloudRequestSchema>;
