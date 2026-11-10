import { DomainError } from './errors.js';

export const USER_ROLES = ['owner', 'manager', 'cashier'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export type HubPermission =
  'auth:self' | 'users:read' | 'users:write' | 'users:unlock' | 'catalog:read' | 'catalog:write';

const ROLE_PERMISSION_TABLE: Readonly<Record<UserRole, ReadonlySet<HubPermission>>> = {
  owner: new Set<HubPermission>([
    'auth:self',
    'users:read',
    'users:write',
    'users:unlock',
    'catalog:read',
    'catalog:write',
  ]),
  manager: new Set<HubPermission>([
    'auth:self',
    'users:read',
    'users:unlock',
    'catalog:read',
    'catalog:write',
  ]),
  cashier: new Set<HubPermission>(['auth:self', 'catalog:read']),
};

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value);
}

export function roleHasPermission(role: UserRole, permission: HubPermission): boolean {
  return ROLE_PERMISSION_TABLE[role].has(permission);
}

export const PIN_MIN_LENGTH = 6;
export const PIN_MAX_LENGTH = 12;

export const PIN_SECURITY_CONSTANTS = {
  MAX_USER_FAILED_ATTEMPTS: 5,
  USER_LOCKOUT_DURATION_MS: 300_000n,
  MAX_DEVICE_FAILED_ATTEMPTS_IN_WINDOW: 15,
  DEVICE_FAILURE_WINDOW_MS: 300_000n,
  DEVICE_BACKOFF_BASE_MS: 2_000n,
  DEVICE_BACKOFF_MAX_MS: 60_000n,
  SESSION_TTL_MS: 43_200_000n,
  SESSION_LAST_SEEN_THROTTLE_MS: 60_000n,
  SESSION_TOKEN_BYTES: 32,
} as const;

/**
 * Port for asynchronous password/PIN hashing & constant-time verification.
 * Production hub binds Argon2id (`@node-rs/argon2`); tests may bind either Argon2id or a fast stub.
 */
export interface PinHasher {
  hash(pin: string): Promise<string>;
  verify(hash: string, pin: string): Promise<boolean>;
}

const PIN_PATTERN = /^\d{6,12}$/;
const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])$/;

/**
 * Validates POS PIN policy (6–12 digits, rejecting repeated digits and strict ascending/descending
 * step-1 sequences such as `000000`, `111111`, `123456`, or `654321`).
 * Never includes the raw PIN inside thrown error messages.
 */
export function validatePinFormat(pin: string): string {
  if (typeof pin !== 'string' || !PIN_PATTERN.test(pin)) {
    throw new DomainError('INVALID_PIN', 'PIN must consist of 6 to 12 digits');
  }

  let allSame = true;
  let allAscending = true;
  let allDescending = true;

  for (let i = 1; i < pin.length; i++) {
    const delta = pin.charCodeAt(i) - pin.charCodeAt(i - 1);
    if (delta !== 0) {
      allSame = false;
    }
    if (delta !== 1) {
      allAscending = false;
    }
    if (delta !== -1) {
      allDescending = false;
    }
  }

  if (allSame || allAscending || allDescending) {
    throw new DomainError('INVALID_PIN', 'PIN must not be repeated or sequential digits');
  }

  return pin;
}

export function normalizeUsername(username: string): string {
  if (typeof username !== 'string') {
    throw new DomainError('VALIDATION_ERROR', 'Username must be a string');
  }
  const normalized = username.trim().toLowerCase();
  if (!USERNAME_PATTERN.test(normalized)) {
    throw new DomainError(
      'VALIDATION_ERROR',
      'Username must be 2 to 64 ASCII lowercase characters (a-z, 0-9, ., _, -)',
    );
  }
  return normalized;
}

export function validateFullName(fullName: string): string {
  if (typeof fullName !== 'string') {
    throw new DomainError('VALIDATION_ERROR', 'Full name must be a string');
  }
  const trimmed = fullName.trim();
  if (trimmed.length === 0 || trimmed.length > 120) {
    throw new DomainError('VALIDATION_ERROR', 'Full name must be between 1 and 120 characters');
  }
  return trimmed;
}

/**
 * Computes progressive device-level delay after hitting the failure threshold (`T0.6` T1).
 * Failures 1..14 return `0n`; on failure 15 (`>= MAX_DEVICE_FAILED_ATTEMPTS_IN_WINDOW`) cooldown
 * starts at `2000n` ms before the 16th attempt, doubling per subsequent failure and capping strictly
 * at `60000n` ms (`DEVICE_BACKOFF_MAX_MS`): 2s, 4s, 8s, 16s, 32s, 60s, 60s...
 */
export function computeDeviceCooldownDelayMs(failedAttemptsInWindow: number): bigint {
  if (failedAttemptsInWindow < PIN_SECURITY_CONSTANTS.MAX_DEVICE_FAILED_ATTEMPTS_IN_WINDOW) {
    return 0n;
  }
  const step = failedAttemptsInWindow - PIN_SECURITY_CONSTANTS.MAX_DEVICE_FAILED_ATTEMPTS_IN_WINDOW;
  if (step >= 5) {
    return PIN_SECURITY_CONSTANTS.DEVICE_BACKOFF_MAX_MS;
  }
  const doubled = PIN_SECURITY_CONSTANTS.DEVICE_BACKOFF_BASE_MS << BigInt(step);
  return doubled > PIN_SECURITY_CONSTANTS.DEVICE_BACKOFF_MAX_MS
    ? PIN_SECURITY_CONSTANTS.DEVICE_BACKOFF_MAX_MS
    : doubled;
}

export function computeRetryAfterSeconds(remainingMs: bigint): bigint {
  if (remainingMs <= 0n) {
    return 0n;
  }
  return (remainingMs + 999n) / 1000n;
}
