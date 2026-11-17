import { normalizeCloudLogin } from '@mezon/domain';
import { z } from 'zod';

export { normalizeCloudLogin };

export const CloudUserRoleSchema = z.enum(['owner', 'manager']);
export type CloudUserRole = z.infer<typeof CloudUserRoleSchema>;

export const CloudLoginRequestSchema = z.object({
  login: z.string().trim().min(3).max(255).transform(normalizeCloudLogin),
  password: z.string().min(6).max(128),
});
export type CloudLoginRequestDto = z.infer<typeof CloudLoginRequestSchema>;

export const CloudRefreshRequestSchema = z.object({
  refreshToken: z.string().trim().min(10).max(500),
});
export type CloudRefreshRequestDto = z.infer<typeof CloudRefreshRequestSchema>;

export const CloudLogoutRequestSchema = z.object({
  refreshToken: z.string().trim().min(10).max(500),
});
export type CloudLogoutRequestDto = z.infer<typeof CloudLogoutRequestSchema>;

export const CloudUserDtoSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  username: z.string().min(1).max(100),
  role: CloudUserRoleSchema,
  hubUserId: z.string().uuid().nullable().optional(),
});
export type CloudUserDto = z.infer<typeof CloudUserDtoSchema>;

export const CloudLoginResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  user: CloudUserDtoSchema,
});
export type CloudLoginResponseDto = z.infer<typeof CloudLoginResponseSchema>;

export const CloudCreateStoreRequestSchema = z.object({
  name: z.string().trim().min(1).max(100),
  code: z
    .string()
    .trim()
    .min(1)
    .max(50)
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      'Store code may only contain letters, digits, underscores, and dashes',
    ),
});
export type CloudCreateStoreRequestDto = z.infer<typeof CloudCreateStoreRequestSchema>;

export const CloudStoreDtoSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  name: z.string(),
  code: z.string(),
  isActive: z.boolean(),
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
});
export type CloudStoreDto = z.infer<typeof CloudStoreDtoSchema>;

export const CloudOrganizationDtoSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  status: z.enum(['active', 'suspended']),
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
});
export type CloudOrganizationDto = z.infer<typeof CloudOrganizationDtoSchema>;
