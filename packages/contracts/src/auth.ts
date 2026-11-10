import {
  DomainError,
  USER_ROLES,
  type UuidV7,
  normalizeUsername,
  parseUuidV7,
  validateFullName,
  validatePinFormat,
} from '@mezon/domain';
import { z } from 'zod';

export const UuidV7Schema = z.string().transform((val, ctx): UuidV7 => {
  try {
    return parseUuidV7(val);
  } catch {
    ctx.addIssue({
      code: 'custom',
      message: 'Must be a valid UUIDv7 string',
    });
    return z.NEVER;
  }
});

export const UsernameSchema = z.string().transform((val, ctx): string => {
  try {
    return normalizeUsername(val);
  } catch (err) {
    ctx.addIssue({
      code: 'custom',
      message: err instanceof DomainError ? err.message : 'Invalid username',
    });
    return z.NEVER;
  }
});

export const FullNameSchema = z.string().transform((val, ctx): string => {
  try {
    return validateFullName(val);
  } catch (err) {
    ctx.addIssue({
      code: 'custom',
      message: err instanceof DomainError ? err.message : 'Invalid full name',
    });
    return z.NEVER;
  }
});

export const NewPinSchema = z.string().transform((val, ctx): string => {
  try {
    return validatePinFormat(val);
  } catch (err) {
    ctx.addIssue({
      code: 'custom',
      message: err instanceof DomainError ? err.message : 'Invalid PIN format',
    });
    return z.NEVER;
  }
});

export const LoginPinInputSchema = z
  .string()
  .min(1, 'PIN is required')
  .max(64, 'PIN exceeds maximum length');

export const BigIntStringSchema = z
  .string()
  .regex(/^\d+$/, 'Must be a non-negative integer string');

export const UserRoleSchema = z.enum(USER_ROLES);

export const ApiErrorEnvelopeSchema = z.strictObject({
  error: z.strictObject({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ApiErrorEnvelope = z.infer<typeof ApiErrorEnvelopeSchema>;

export const UserSummarySchema = z.strictObject({
  id: UuidV7Schema,
  organizationId: UuidV7Schema,
  username: z.string(),
  fullName: z.string(),
  role: UserRoleSchema,
  isActive: z.boolean(),
});
export type UserSummaryDto = z.infer<typeof UserSummarySchema>;

export const HealthResponseSchema = z.strictObject({
  status: z.literal('ok'),
  service: z.literal('@mezon/hub'),
  needsSetup: z.boolean(),
});
export type HealthResponseDto = z.infer<typeof HealthResponseSchema>;

export const SetupRequestSchema = z.strictObject({
  owner: z.strictObject({
    fullName: FullNameSchema,
    username: UsernameSchema,
    pin: NewPinSchema,
  }),
});
export type SetupRequestDto = z.infer<typeof SetupRequestSchema>;

export const SetupResponseSchema = z.strictObject({
  organizationId: UuidV7Schema,
  storeId: UuidV7Schema,
  deviceId: UuidV7Schema,
  owner: UserSummarySchema,
});
export type SetupResponseDto = z.infer<typeof SetupResponseSchema>;

export const LoginOptionSchema = z.strictObject({
  id: UuidV7Schema,
  fullName: z.string(),
  role: UserRoleSchema,
});
export type LoginOptionDto = z.infer<typeof LoginOptionSchema>;

export const LoginOptionsResponseSchema = z.strictObject({
  options: z.array(LoginOptionSchema),
});
export type LoginOptionsResponseDto = z.infer<typeof LoginOptionsResponseSchema>;

export const LoginRequestSchema = z.union([
  z.strictObject({
    username: UsernameSchema,
    pin: LoginPinInputSchema,
  }),
  z.strictObject({
    userId: UuidV7Schema,
    pin: LoginPinInputSchema,
  }),
]);
export type LoginRequestDto = z.infer<typeof LoginRequestSchema>;

export const LoginResponseSchema = z.strictObject({
  token: z.string(),
  tokenType: z.literal('Bearer'),
  expiresAtMs: BigIntStringSchema,
  user: UserSummarySchema,
});
export type LoginResponseDto = z.infer<typeof LoginResponseSchema>;

export const LogoutResponseSchema = z.strictObject({
  revoked: z.literal(true),
});
export type LogoutResponseDto = z.infer<typeof LogoutResponseSchema>;

export const AuthMeResponseSchema = z.strictObject({
  user: UserSummarySchema,
  session: z.strictObject({
    id: UuidV7Schema,
    deviceId: UuidV7Schema,
    expiresAtMs: BigIntStringSchema,
  }),
});
export type AuthMeResponseDto = z.infer<typeof AuthMeResponseSchema>;

export const ListUsersResponseSchema = z.strictObject({
  users: z.array(UserSummarySchema),
});
export type ListUsersResponseDto = z.infer<typeof ListUsersResponseSchema>;

export const CreateUserRequestSchema = z.strictObject({
  fullName: FullNameSchema,
  username: UsernameSchema,
  role: UserRoleSchema,
  pin: NewPinSchema,
});
export type CreateUserRequestDto = z.infer<typeof CreateUserRequestSchema>;

export const UserResponseSchema = z.strictObject({
  user: UserSummarySchema,
});
export type UserResponseDto = z.infer<typeof UserResponseSchema>;

export const UpdateUserRequestSchema = z
  .strictObject({
    fullName: FullNameSchema.optional(),
    role: UserRoleSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.fullName !== undefined || value.role !== undefined || value.isActive !== undefined,
    { message: 'At least one field (fullName, role, or isActive) must be provided' },
  );
export type UpdateUserRequestDto = z.infer<typeof UpdateUserRequestSchema>;

export const ResetUserPinRequestSchema = z.strictObject({
  pin: NewPinSchema,
});
export type ResetUserPinRequestDto = z.infer<typeof ResetUserPinRequestSchema>;

export const UnlockUserResponseSchema = z.strictObject({
  unlocked: z.literal(true),
  userId: UuidV7Schema,
});
export type UnlockUserResponseDto = z.infer<typeof UnlockUserResponseSchema>;

export const DeleteUserResponseSchema = z.strictObject({
  deleted: z.literal(true),
  userId: UuidV7Schema,
});
export type DeleteUserResponseDto = z.infer<typeof DeleteUserResponseSchema>;

export const UserIdParamsSchema = z.strictObject({
  id: UuidV7Schema,
});
export type UserIdParamsDto = z.infer<typeof UserIdParamsSchema>;
