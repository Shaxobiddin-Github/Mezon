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
  UNLIMITED_PRODUCT_STOCK_NOT_TRACKED: 400,
  INVALID_STOCK_MOVE_REASON: 400,
  BATCH_REQUIRED: 400,
  INVALID_PROMOTION: 400,
  CART_EMPTY: 400,
  CUSTOMER_REQUIRED: 400,
  AUTH_UNAUTHORIZED: 401,
  AUTH_INVALID_CREDENTIALS: 401,
  AUTH_FORBIDDEN: 403,
  FORBIDDEN_ORIGIN: 403,
  UNIT_OF_WORK_TENANT_MISMATCH: 403,
  DISCOUNT_OVERRIDE_REQUIRED: 403,
  SUPERVISOR_OVERRIDE_REQUIRED: 403,
  USER_NOT_FOUND: 404,
  CATEGORY_NOT_FOUND: 404,
  PRODUCT_NOT_FOUND: 404,
  VARIANT_NOT_FOUND: 404,
  BARCODE_NOT_FOUND: 404,
  BATCH_NOT_FOUND: 404,
  INVENTORY_COUNT_NOT_FOUND: 404,
  CART_NOT_FOUND: 404,
  CART_LINE_NOT_FOUND: 404,
  PROMOTION_NOT_FOUND: 404,
  SALE_NOT_FOUND: 404,
  RETURN_NOT_FOUND: 404,
  SALE_LINE_NOT_FOUND: 404,
  CUSTOMER_NOT_FOUND: 404,
  SUPPLIER_NOT_FOUND: 404,
  RECEIVING_NOT_FOUND: 404,
  RECEIVING_LINE_NOT_FOUND: 404,
  SUPPLIER_RETURN_NOT_FOUND: 404,
  SHIFT_NOT_FOUND: 404,
  SHIFT_CLOSURE_NOT_FOUND: 404,
  DAY_CLOSE_NOT_FOUND: 404,
  RECEIVING_EMPTY: 400,
  SETUP_ALREADY_COMPLETED: 409,
  USERNAME_ALREADY_EXISTS: 409,
  LAST_OWNER_PROTECTED: 409,
  CATEGORY_CYCLE: 409,
  CATEGORY_IN_USE: 409,
  CATEGORY_ALREADY_EXISTS: 409,
  PRODUCT_SKU_ALREADY_EXISTS: 409,
  VARIANT_SKU_ALREADY_EXISTS: 409,
  BARCODE_ALREADY_EXISTS: 409,
  STOCK_COSTING_LOCKED: 409,
  INSUFFICIENT_STOCK: 409,
  INVENTORY_COUNT_NOT_OPEN: 409,
  CART_NOT_OPEN: 409,
  CART_NOT_PARKED: 409,
  SALE_TOTAL_CHANGED: 409,
  IDEMPOTENCY_CONFLICT: 409,
  VOID_WINDOW_EXPIRED: 409,
  SALE_ALREADY_VOIDED: 409,
  SALE_HAS_RETURNS: 409,
  FISCALIZED_SALE_CANNOT_VOID: 409,
  RETURN_QTY_EXCEEDED: 409,
  RETURN_PAYMENT_LIMIT_EXCEEDED: 409,
  INSUFFICIENT_CASH_IN_DRAWER: 409,
  CUSTOMER_PHONE_ALREADY_EXISTS: 409,
  CUSTOMER_INACTIVE: 409,
  CUSTOMER_HAS_OPEN_DEBT: 409,
  CREDIT_LIMIT_EXCEEDED: 409,
  OPENING_BALANCE_ALREADY_EXISTS: 409,
  OVERPAYMENT_NOT_ALLOWED: 409,
  RETURN_DEBT_OFFSET_EXCEEDED: 409,
  SALE_DEBT_HAS_PAYMENTS: 409,
  SUPPLIER_TIN_ALREADY_EXISTS: 409,
  SUPPLIER_PHONE_ALREADY_EXISTS: 409,
  SUPPLIER_INACTIVE: 409,
  SUPPLIER_HAS_OPEN_BALANCE: 409,
  RECEIVING_NOT_DRAFT: 409,
  RECEIVING_LINE_COST_UNKNOWN: 409,
  RECEIVING_LINE_COST_ALREADY_CONFIRMED: 409,
  SUPPLIER_RETURN_QTY_EXCEEDED: 409,
  SUPPLIER_RETURN_BATCH_DEPLETED: 409,
  SHIFT_ALREADY_OPEN: 409,
  SHIFT_NOT_OPEN: 409,
  SHIFT_ALREADY_CLOSED: 409,
  SHIFT_NOT_CLOSED: 409,
  CASHIER_SESSION_MISMATCH: 409,
  CASHIER_SESSION_ALREADY_CLOSED: 409,
  DAY_HAS_OPEN_SHIFTS: 409,
  ORDER_NOT_FOUND: 404,
  ORDER_EMPTY: 400,
  ORDER_INVALID_TRANSITION: 409,
  ORDER_ADVANCE_EXCEEDS_TOTAL: 409,
  ORDER_ADVANCE_REFUND_EXCEEDED: 409,
  ORDER_EXCESS_ADVANCE: 409,
  ORDER_SALE_USE_RETURN: 409,
  ORDER_TOTAL_CHANGED: 409,
  INVALID_HOST: 421,
  AUTH_RATE_LIMITED: 429,
  STORE_NOT_FOUND: 404,
  DEVICE_NOT_FOUND: 404,
  DEVICE_ALREADY_REGISTERED: 409,
  DEVICE_REVOKED: 403,
  DEVICE_TOKEN_REUSE: 401,
  PAIRING_CODE_NOT_FOUND: 404,
  PAIRING_CODE_EXPIRED: 400,
  PAIRING_CODE_BLOCKED: 429,
  PAIRING_ALREADY_USED: 409,
  DEVICE_NOT_INITIALIZED: 400,
  NETWORK_ERROR: 502,
  RATE_LIMITED: 429,
  PAIRING_FAILED: 400,
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
      if (status === 500) {
        request.log.error({ err, domainCode: err.code }, 'Internal domain invariant failure');
        return reply.code(500).send({
          error: {
            code: err.code,
            message: 'Internal server error',
          },
        } satisfies ApiErrorEnvelope);
      }

      if (status === 502) {
        request.log.error({ err, domainCode: err.code }, 'External service network failure');
        return reply.code(502).send({
          error: {
            code: err.code,
            message: err.message,
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
          ...(err.details !== undefined ? { details: err.details } : {}),
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
