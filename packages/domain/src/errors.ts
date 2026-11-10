export type DomainErrorCode =
  | 'INVALID_DENOMINATOR'
  | 'INVALID_VAT_RATE'
  | 'ALLOCATE_EMPTY_WEIGHTS'
  | 'ALLOCATE_ZERO_TOTAL_WEIGHT'
  | 'ALLOCATE_NEGATIVE_WEIGHT'
  | 'INVALID_SERIALIZED_STRING'
  | 'STRING_TOO_LONG'
  | 'INVALID_DECIMAL_FORMAT'
  | 'INVALID_TIMESTAMP'
  | 'INVALID_RANDOM_BYTES'
  | 'INVALID_UUID_FORMAT'
  | 'INVALID_UUID_VERSION'
  | 'INVALID_UUID_VARIANT'
  | 'UUID_TIMESTAMP_OVERFLOW'
  | 'INVALID_HLC_FORMAT'
  | 'INVALID_HLC_COUNTER'
  | 'INVALID_MAX_SKEW'
  | 'UNIT_OF_WORK_REENTRANCY'
  | 'UNIT_OF_WORK_REQUIRED'
  | 'UNIT_OF_WORK_SESSION_CLOSED'
  | 'UNIT_OF_WORK_CONCURRENT_NESTED'
  | 'UNIT_OF_WORK_TENANT_MISMATCH';

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'DomainError';
    this.code = code;
  }
}
