import type { ApiErrorEnvelope } from '@mezon/contracts';
import { DomainError, type DomainErrorCode } from '@mezon/domain';
import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

const DOMAIN_ERROR_HTTP_STATUS: Readonly<Record<DomainErrorCode, number>> = {
  INVALID_DENOMINATOR: 400,
  INVALID_VAT_RATE: 400,
  ALLOCATE_EMPTY_WEIGHTS: 400,
  ALLOCATE_ZERO_TOTAL_WEIGHT: 400,
  ALLOCATE_NEGATIVE_WEIGHT: 400,
  INVALID_SERIALIZED_STRING: 400,
  STRING_TOO_LONG: 400,
  INVALID_DECIMAL_FORMAT: 400,
  INVALID_TIMESTAMP: 400,
  INVALID_RANDOM_BYTES: 400,
  INVALID_UUID_FORMAT: 400,
  INVALID_UUID_VERSION: 400,
  INVALID_UUID_VARIANT: 400,
  UUID_TIMESTAMP_OVERFLOW: 400,
  INVALID_HLC_FORMAT: 400,
  INVALID_HLC_COUNTER: 400,
  INVALID_MAX_SKEW: 400,
  VALIDATION_ERROR: 400,
  INVALID_PIN: 400,
  INVALID_UNIT: 400,
  INVALID_UNIT_QUANTITY: 400,
  INVALID_BARCODE: 400,
  INVALID_BARCODE_CHECK_DIGIT: 400,
  AUTH_UNAUTHORIZED: 401,
  AUTH_INVALID_CREDENTIALS: 401,
  AUTH_FORBIDDEN: 403,
  FORBIDDEN_ORIGIN: 403,
  UNIT_OF_WORK_TENANT_MISMATCH: 403,
  USER_NOT_FOUND: 404,
  CATEGORY_NOT_FOUND: 404,
  PRODUCT_NOT_FOUND: 404,
  VARIANT_NOT_FOUND: 404,
  BARCODE_NOT_FOUND: 404,
  SETUP_ALREADY_COMPLETED: 409,
  USERNAME_ALREADY_EXISTS: 409,
  LAST_OWNER_PROTECTED: 409,
  CATEGORY_CYCLE: 409,
  CATEGORY_IN_USE: 409,
  CATEGORY_ALREADY_EXISTS: 409,
  PRODUCT_SKU_ALREADY_EXISTS: 409,
  VARIANT_SKU_ALREADY_EXISTS: 409,
  BARCODE_ALREADY_EXISTS: 409,
  INVALID_HOST: 421,
  AUTH_RATE_LIMITED: 429,
  UNIT_OF_WORK_REENTRANCY: 500,
  UNIT_OF_WORK_REQUIRED: 500,
  UNIT_OF_WORK_SESSION_CLOSED: 500,
  UNIT_OF_WORK_CONCURRENT_NESTED: 500,
};

export function domainErrorToHttpStatus(code: DomainErrorCode): number {
  return DOMAIN_ERROR_HTTP_STATUS[code];
}

function formatSafeZodMessage(err: ZodError): string {
  const first = err.issues[0];
  if (!first) {
    return 'Validation failed';
  }
  const pathText = first.path.length > 0 ? first.path.join('.') : 'payload';
  return `${pathText}: ${first.message}`;
}

function hasFastifyBadRequestStatus(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const statusCode = (err as { readonly statusCode?: unknown }).statusCode;
  return typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500;
}

export function registerHubErrorHandlers(app: FastifyInstance): void {
  app.setNotFoundHandler((_request, reply) => {
    const body: ApiErrorEnvelope = {
      error: {
        code: 'NOT_FOUND',
        message: 'Route not found',
      },
    };
    return reply.code(404).send(body);
  });

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof ZodError) {
      const body: ApiErrorEnvelope = {
        error: {
          code: 'VALIDATION_ERROR',
          message: formatSafeZodMessage(err),
        },
      };
      return reply.code(400).send(body);
    }

    if (err instanceof DomainError) {
      const status = domainErrorToHttpStatus(err.code);
      if (status >= 500) {
        request.log.error({ err, domainCode: err.code }, 'Internal domain invariant failure');
        return reply.code(500).send({
          error: {
            code: err.code,
            message: 'Internal server error',
          },
        } satisfies ApiErrorEnvelope);
      }

      if (err.retryAfterSeconds !== undefined) {
        reply.header('retry-after', err.retryAfterSeconds.toString());
      }
      return reply.code(status).send({
        error: {
          code: err.code,
          message: err.message,
        },
      } satisfies ApiErrorEnvelope);
    }

    if (hasFastifyBadRequestStatus(err)) {
      return reply.code(400).send({
        error: {
          code: 'BAD_REQUEST',
          message: 'Malformed request',
        },
      } satisfies ApiErrorEnvelope);
    }

    request.log.error({ err }, 'Unhandled hub error');
    return reply.code(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      },
    } satisfies ApiErrorEnvelope);
  });
}
