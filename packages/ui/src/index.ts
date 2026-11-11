import {
  type Money,
  type ProductUnit,
  type Quantity,
  formatMoneyDecimal,
  formatQuantityDecimal,
  isIntegerOnlyUnit,
  moneyFromTiyin,
  moneyToTiyin,
  parseMoneyDecimal,
  parseQuantityDecimal,
  quantityFromMilli,
  quantityToMilli,
} from '@mezon/domain';

export const UI_PACKAGE = '@mezon/ui';

function groupThousands(intDigits: string): string {
  return intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/**
 * Formats a tiyin bigint string (or `Money`) into human-readable Uzbek so'm (`15 000` or `15 000.50`)
 * using pure bigint/string operations (zero float math).
 */
export function formatTiyinToSom(tiyinOrMoney: string | bigint | Money): string {
  const tiyin =
    typeof tiyinOrMoney === 'string'
      ? BigInt(tiyinOrMoney)
      : typeof tiyinOrMoney === 'bigint'
        ? tiyinOrMoney
        : moneyToTiyin(tiyinOrMoney);
  const dec = formatMoneyDecimal(moneyFromTiyin(tiyin));
  const isNeg = dec.startsWith('-');
  const unsigned = isNeg ? dec.slice(1) : dec;
  const [intPart = '0', fracPart = '00'] = unsigned.split('.');
  const groupedInt = groupThousands(intPart);
  const prefix = isNeg ? '-' : '';
  if (fracPart === '00') {
    return `${prefix}${groupedInt}`;
  }
  return `${prefix}${groupedInt}.${fracPart}`;
}

/**
 * Converts a tiyin bigint string to a plain decimal so'm input string (`15000` or `15000.50`)
 * suitable for `<input>` fields.
 */
export function tiyinToSomInputString(tiyinStr: string): string {
  const dec = formatMoneyDecimal(moneyFromTiyin(BigInt(tiyinStr)));
  if (dec.endsWith('.00')) {
    return dec.slice(0, -3);
  }
  return dec;
}

/**
 * Parses user-entered so'm text (e.g. `"15 000"`, `"15000.5"`, `"0"`) into canonical tiyin bigint string.
 * Never uses `Number` or `parseFloat`.
 */
export function parseSomInputToTiyinString(rawSomInput: string): string {
  const cleaned = rawSomInput.replace(/\s+/g, '').replace(/,/g, '.');
  const money = parseMoneyDecimal(cleaned);
  return moneyToTiyin(money).toString();
}

/**
 * Formats a milli-unit quantity string (e.g. `"1000"` -> `"1"`, `"1500"` -> `"1.5"`, `"125"` -> `"0.125"`).
 */
export function formatMilliToQtyString(milliOrQty: string | bigint | Quantity): string {
  const milli =
    typeof milliOrQty === 'string'
      ? BigInt(milliOrQty)
      : typeof milliOrQty === 'bigint'
        ? milliOrQty
        : quantityToMilli(milliOrQty);
  const dec = formatQuantityDecimal(quantityFromMilli(milli));
  const [intPart = '0', fracPart = '000'] = dec.split('.');
  const trimmedFrac = fracPart.replace(/0+$/, '');
  return trimmedFrac.length > 0 ? `${intPart}.${trimmedFrac}` : intPart;
}

/**
 * Parses user-entered quantity text (e.g. `"1"`, `"2.5"`, `"0.250"`) into canonical milli-unit bigint string.
 */
export function parseQtyInputToMilliString(rawQtyInput: string, unit?: ProductUnit): string {
  const cleaned = rawQtyInput.replace(/\s+/g, '').replace(/,/g, '.');
  const qty = parseQuantityDecimal(cleaned);
  const milli = quantityToMilli(qty);
  if (unit !== undefined && isIntegerOnlyUnit(unit) && milli % 1000n !== 0n) {
    throw new Error(`Unit "${unit}" requires a whole-unit quantity`);
  }
  return milli.toString();
}

/**
 * Increments or decrements a milli-unit quantity string by 1 whole unit (`1000n` milli) while staying `>= 1000n` (or `>= 100n` for fractional).
 */
export function stepMilliQuantity(currentMilliStr: string, deltaWholeUnits: 1 | -1): string {
  const current = BigInt(currentMilliStr);
  const step = 1000n * BigInt(deltaWholeUnits);
  const next = current + step;
  return (next >= 1000n ? next : current).toString();
}
