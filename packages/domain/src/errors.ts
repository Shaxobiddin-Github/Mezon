export type DomainErrorCode =
  | 'INVALID_DENOMINATOR'
  | 'INVALID_VAT_RATE'
  | 'ALLOCATE_EMPTY_WEIGHTS'
  | 'ALLOCATE_ZERO_TOTAL_WEIGHT'
  | 'ALLOCATE_NEGATIVE_WEIGHT'
  | 'INVALID_SERIALIZED_STRING'
  | 'STRING_TOO_LONG'
  | 'INVALID_DECIMAL_FORMAT';

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode) {
    super(code);
    this.name = 'DomainError';
    this.code = code;
  }
}
