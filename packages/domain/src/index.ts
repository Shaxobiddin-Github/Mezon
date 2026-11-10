export { DomainError, type DomainErrorCode } from './errors.js';

export {
  type Money,
  ZERO_MONEY,
  moneyFromTiyin,
  moneyToTiyin,
  addMoney,
  subtractMoney,
  negateMoney,
  sumMoney,
} from './money.js';

export {
  type Quantity,
  ZERO_QUANTITY,
  quantityFromMilli,
  quantityToMilli,
  addQuantity,
  subtractQuantity,
  negateQuantity,
} from './quantity.js';

export { divideRoundHalfAwayFromZero, multiply } from './rounding.js';

export { allocate } from './allocate.js';

export {
  type VatRate,
  ZERO_VAT_RATE,
  vatRateFromBasisPoints,
  vatRateToBasisPoints,
  type VatExcludedResult,
  type VatIncludedResult,
  calculateVatExcluded,
  calculateVatIncluded,
} from './vat.js';

export {
  serializeMoney,
  parseMoney,
  serializeQuantity,
  parseQuantity,
  formatMoneyDecimal,
  parseMoneyDecimal,
  formatQuantityDecimal,
  parseQuantityDecimal,
} from './serialize.js';

export {
  type UnixMs,
  MIN_UNIX_MS,
  MAX_UNIX_MS,
  type Clock,
  type RandomSource,
  unixMsFromBigInt,
  unixMsToBigInt,
  addUnixMs,
  diffUnixMs,
  serializeUnixMs,
  parseUnixMs,
} from './clock.js';

export {
  type UuidV7,
  type IdGenerator,
  type MonotonicUuidV7State,
  type MonotonicUuidV7StepResult,
  type MonotonicUuidV7GeneratorOptions,
  UUID_V7_RANDOM_BYTES_LENGTH,
  MAX_UUID_V7_COUNTER,
  encodeUuidV7,
  parseUuidV7,
  isValidUuidV7,
  extractUuidV7Timestamp,
  uuidV7ToBytes,
  uuidV7FromBytes,
  stepMonotonicUuidV7,
  MonotonicUuidV7Generator,
} from './uuidv7.js';

export {
  DEFAULT_HLC_MAX_SKEW_MS,
  MAX_HLC_COUNTER,
  HLC_STRING_LENGTH,
  type HlcTimestamp,
  type HlcState,
  type HlcNowResult,
  type HlcReceiveResult,
  type HlcClockOptions,
  createHlcTimestamp,
  serializeHlc,
  parseHlc,
  compareHlc,
  HlcClock,
} from './hlc.js';
