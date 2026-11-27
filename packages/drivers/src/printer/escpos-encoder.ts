import { encodeLineBytes, getEscPosCodePageNumber, normalizeTextForEncoding } from './codepage.js';
import {
  centerLine,
  formatKeyValueRows,
  formatMilliQty,
  formatTiyinAmount,
  formatVatRatePercent,
  getPaperWidthColumns,
  repeatDivider,
  wrapTextLines,
} from './layout.js';
import type { ReceiptFiscalBlock } from '@mezon/domain';
import type {
  EncodedReceiptOutput,
  PrintableDocument,
  PrinterEncodingMode,
  PrinterPaperWidthMm,
  ReturnReceiptDocument,
  SaleReceiptDocument,
  ShiftCloseReportDocument,
  TestPrintDocument,
} from './types.js';

export const ESC_INIT = new Uint8Array([0x1b, 0x40]); // ESC @
export const ESC_BOLD_ON = new Uint8Array([0x1b, 0x45, 0x01]); // ESC E 1
export const ESC_BOLD_OFF = new Uint8Array([0x1b, 0x45, 0x00]); // ESC E 0
export const GS_CUT_PARTIAL_FEED = new Uint8Array([0x1d, 0x56, 0x42, 0x03]); // GS V 66 3

/**
 * Generates an ESC/POS cash drawer kick pulse (`ESC p m t1 t2`):
 * - `pin = 0` -> Drawer kick-out connector pin 2 (`0x00`)
 * - `pin = 1` -> Drawer kick-out connector pin 5 (`0x01`)
 * - `t1 = 0x19` (25 * 2ms = 50ms ON), `t2 = 0xfa` (250 * 2ms = 500ms OFF)
 */
export function encodeCashDrawerPulse(pin: 0 | 1 = 0): Uint8Array {
  return new Uint8Array([0x1b, 0x70, pin === 1 ? 0x01 : 0x00, 0x19, 0xfa]);
}

function translatePaymentMethodLabel(method: string): string {
  switch (method) {
    case 'cash':
      return 'Naqd';
    case 'card':
      return 'Karta';
    case 'uzqr':
      return 'UzQR';
    case 'payme':
      return 'Payme';
    case 'click':
      return 'Click';
    case 'uzum':
      return 'Uzum';
    case 'social_card':
      return 'Ijtimoiy karta';
    case 'advance':
      return 'Avans';
    case 'debt_reduction':
      return 'Qarzdan ayrildi';
    default:
      return 'Boshqa';
  }
}

interface StyledLine {
  readonly text: string;
  readonly bold?: boolean;
  /** When set, the line is a QR code (printer-native `GS ( k`), `text` is only the preview. */
  readonly qr?: string;
}

/** Max QR model 2 data length accepted by `GS ( k` store (bytes). */
export const ESC_POS_QR_MAX_BYTES = 7089;

/**
 * ESC/POS QR (model 2, error correction M) using the printer's own `GS ( k` functions — a printer
 * standard, not a fiscal API. The payload bytes are the opaque driver QR text as UTF-8, verbatim.
 */
export function encodeEscPosQr(payload: string, moduleSize: number): Uint8Array {
  const data = new TextEncoder().encode(payload);
  if (data.length < 1 || data.length > ESC_POS_QR_MAX_BYTES) {
    throw new RangeError(
      `QR payload must be 1..${String(ESC_POS_QR_MAX_BYTES)} bytes, got ${String(data.length)}`,
    );
  }
  if (!Number.isInteger(moduleSize) || moduleSize < 1 || moduleSize > 16) {
    throw new RangeError('QR module size must be 1..16');
  }
  const storeLen = data.length + 3;
  // prettier-ignore
  const head = [
    0x1b, 0x61, 0x01, // ESC a 1 (center)
    0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00, // model 2
    0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, moduleSize, // module size
    0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31, // error correction M
    0x1d, 0x28, 0x6b, storeLen & 0xff, (storeLen >> 8) & 0xff, 0x31, 0x50, 0x30, // store
  ];
  // prettier-ignore
  const tail = [
    0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30, // print
    0x0a,
    0x1b, 0x61, 0x00, // ESC a 0 (left)
  ];
  const out = new Uint8Array(head.length + data.length + tail.length);
  out.set(head, 0);
  out.set(data, head.length);
  out.set(tail, head.length + data.length);
  return out;
}

const FISCAL_MARK_TEXT: Readonly<Record<ReceiptFiscalBlock['mark'], string>> = {
  FISCAL: '*** FISKAL CHEK ***',
  FISCAL_INCOMPLETE: "*** FISKAL MA'LUMOT TO'LIQ EMAS ***",
  FISCAL_PENDING: '*** FISKAL KUTILMOQDA ***',
  NOT_FISCAL: '*** FISKAL EMAS ***',
};

/** Top banner lines: legacy test banner (no fiscal block) or test banner + fiscal mark. */
/** v1 (fiscal mode off): every paper document says it is not fiscal. */
const NON_FISCAL_LINE = '*** FISKAL EMAS ***';
/** A test fiscal driver: the receipt additionally says it is a test (§3.3). */
const TEST_DRIVER_LINE = '*** SINOV — FISKAL EMAS ***';

function fiscalHeaderLines(
  fiscal: ReceiptFiscalBlock | undefined,
  width: 32 | 48,
  norm: (s: string) => string,
): StyledLine[] {
  const test = { text: centerLine(norm(TEST_DRIVER_LINE), width), bold: true };
  // v1: fiscal mode off = a real, non-fiscal receipt (not a "test"); "SINOV" only for a test driver.
  if (fiscal === undefined) return [{ text: centerLine(norm(NON_FISCAL_LINE), width), bold: true }];
  const out: StyledLine[] = fiscal.testBanner ? [test] : [];
  out.push({ text: centerLine(norm(FISCAL_MARK_TEXT[fiscal.mark]), width), bold: true });
  return out;
}

/** Fiscal rows + QR (only for a complete FISCAL block). */
function fiscalBodyLines(
  fiscal: ReceiptFiscalBlock | undefined,
  width: 32 | 48,
  norm: (s: string) => string,
): StyledLine[] {
  if (fiscal?.mark !== 'FISCAL') return [];
  const out: StyledLine[] = [{ text: repeatDivider('-', width) }];
  for (const r of fiscal.rows) {
    for (const row of formatKeyValueRows(norm(`${r.label}:`), norm(r.value), width)) {
      out.push({ text: row });
    }
  }
  if (fiscal.qrPayload !== null) {
    out.push({ text: centerLine('[QR]', width), qr: fiscal.qrPayload });
  }
  return out;
}

/** Bottom banner: kept for the test driver / legacy receipts only. */
function fiscalFooterLines(
  fiscal: ReceiptFiscalBlock | undefined,
  width: 32 | 48,
  norm: (s: string) => string,
): StyledLine[] {
  if (fiscal !== undefined && !fiscal.testBanner) return [];
  const line = fiscal === undefined ? NON_FISCAL_LINE : TEST_DRIVER_LINE;
  return [{ text: centerLine(norm(line), width), bold: true }];
}

function buildSaleReceiptLines(
  doc: SaleReceiptDocument,
  width: 32 | 48,
  encoding: PrinterEncodingMode,
): readonly StyledLine[] {
  const norm = (s: string) => normalizeTextForEncoding(s, encoding);
  const out: StyledLine[] = [];

  out.push(...fiscalHeaderLines(doc.fiscal, width, norm));
  if (doc.isReprint || doc.copyNumber > 1) {
    out.push({
      text: centerLine(norm(`*** NUSXA #${String(doc.copyNumber)} (QAYTA CHOP ETILDI) ***`), width),
      bold: true,
    });
  }
  for (const titleLine of wrapTextLines(norm(doc.headerTitle || 'GUZAR KASSA'), width)) {
    out.push({ text: centerLine(titleLine, width), bold: true });
  }
  out.push({ text: repeatDivider('=', width) });

  for (const row of formatKeyValueRows(
    norm('Chek:'),
    norm(`${doc.receiptCode} (#${doc.receiptNo.toString()})`),
    width,
  )) {
    out.push({ text: row });
  }
  for (const row of formatKeyValueRows(norm('Smena:'), norm(doc.shiftCode), width)) {
    out.push({ text: row });
  }
  for (const row of formatKeyValueRows(norm('Sana:'), norm(doc.formattedDateTime), width)) {
    out.push({ text: row });
  }
  for (const row of formatKeyValueRows(norm('Kassir:'), norm(doc.cashierName), width)) {
    out.push({ text: row });
  }
  if (doc.customerName) {
    for (const row of formatKeyValueRows(norm('Mijoz:'), norm(doc.customerName), width)) {
      out.push({ text: row });
    }
  }

  out.push({ text: repeatDivider('-', width) });

  for (const line of doc.lines) {
    const tag = line.isQuickSale ? ' [Tez savdo]' : '';
    const itemTitle = `${String(line.lineNo)}. ${norm(line.itemName)}${tag}`;
    for (const wrapped of wrapTextLines(itemTitle, width, '   ')) {
      out.push({ text: wrapped });
    }

    const qtyPriceExpr = `   ${formatMilliQty(line.qtyMilli)} ${norm(line.unit)} x ${formatTiyinAmount(line.unitPriceTiyin)}`;
    const grossRight = formatTiyinAmount(line.grossTotalTiyin);
    for (const row of formatKeyValueRows(qtyPriceExpr, grossRight, width)) {
      out.push({ text: row });
    }

    const lineDiscount = line.promoDiscountTiyin + line.allocatedOrderDiscountTiyin;
    if (lineDiscount > 0n) {
      for (const row of formatKeyValueRows(
        norm('   Chegirma:'),
        `-${formatTiyinAmount(lineDiscount)}`,
        width,
      )) {
        out.push({ text: row });
      }
      for (const row of formatKeyValueRows(
        norm('   Qator jami:'),
        formatTiyinAmount(line.finalTotalTiyin),
        width,
      )) {
        out.push({ text: row });
      }
    }

    for (const row of formatKeyValueRows(
      norm(`   QQS (${formatVatRatePercent(line.vatRateBp)}):`),
      formatTiyinAmount(line.vatTotalTiyin),
      width,
    )) {
      out.push({ text: row });
    }
  }

  out.push({ text: repeatDivider('-', width) });

  const totalDiscounts = doc.promoDiscountTotalTiyin + doc.orderDiscountTotalTiyin;
  if (totalDiscounts > 0n) {
    for (const row of formatKeyValueRows(
      norm('Jami (chegirmasiz):'),
      formatTiyinAmount(doc.subtotalGrossTiyin),
      width,
    )) {
      out.push({ text: row });
    }
    if (doc.promoDiscountTotalTiyin > 0n) {
      for (const row of formatKeyValueRows(
        norm('Aksiya chegirmasi:'),
        `-${formatTiyinAmount(doc.promoDiscountTotalTiyin)}`,
        width,
      )) {
        out.push({ text: row });
      }
    }
    if (doc.orderDiscountTotalTiyin > 0n) {
      for (const row of formatKeyValueRows(
        norm('Chegirma:'),
        `-${formatTiyinAmount(doc.orderDiscountTotalTiyin)}`,
        width,
      )) {
        out.push({ text: row });
      }
    }
  }

  for (const row of formatKeyValueRows(
    norm("JAMI TO'LOV:"),
    `${formatTiyinAmount(doc.totalFinalTiyin)} so'm`,
    width,
  )) {
    out.push({ text: row, bold: true });
  }
  for (const row of formatKeyValueRows(
    norm('Shu jumladan QQS:'),
    `${formatTiyinAmount(doc.totalVatTiyin)} so'm`,
    width,
  )) {
    out.push({ text: row });
  }

  out.push({ text: repeatDivider('-', width) });

  for (const p of doc.payments) {
    const label = translatePaymentMethodLabel(p.method);
    if (p.method === 'cash' && p.tenderedAmountTiyin !== null) {
      for (const row of formatKeyValueRows(
        norm(`${label} (berildi):`),
        `${formatTiyinAmount(p.tenderedAmountTiyin)} so'm`,
        width,
      )) {
        out.push({ text: row });
      }
    } else {
      const refSuffix = p.providerRef ? ` (${norm(p.providerRef)})` : '';
      for (const row of formatKeyValueRows(
        norm(`${label}${refSuffix}:`),
        `${formatTiyinAmount(p.amountTiyin)} so'm`,
        width,
      )) {
        out.push({ text: row });
      }
    }
  }

  if (doc.changeAmountTiyin > 0n) {
    for (const row of formatKeyValueRows(
      norm('Qaytim (naqd):'),
      `${formatTiyinAmount(doc.changeAmountTiyin)} so'm`,
      width,
    )) {
      out.push({ text: row, bold: true });
    }
  }
  if (doc.debtAmountTiyin > 0n) {
    for (const row of formatKeyValueRows(
      norm('Nasiya (qarzga):'),
      `${formatTiyinAmount(doc.debtAmountTiyin)} so'm`,
      width,
    )) {
      out.push({ text: row, bold: true });
    }
  }

  // C20: the customer's running debt, so the buyer sees what they owe after this purchase.
  if (doc.customerDebt !== undefined) {
    out.push({ text: repeatDivider('-', width) });
    out.push({ text: centerLine(norm('MIJOZ QARZI'), width), bold: true });
    for (const row of formatKeyValueRows(
      norm('Xariddan oldin:'),
      `${formatTiyinAmount(doc.customerDebt.beforeTiyin)} so'm`,
      width,
    )) {
      out.push({ text: row });
    }
    if (doc.debtAmountTiyin > 0n) {
      for (const row of formatKeyValueRows(
        norm('Shu chekda:'),
        `+${formatTiyinAmount(doc.debtAmountTiyin)} so'm`,
        width,
      )) {
        out.push({ text: row });
      }
    }
    for (const row of formatKeyValueRows(
      norm('Xariddan keyin:'),
      `${formatTiyinAmount(doc.customerDebt.afterTiyin)} so'm`,
      width,
    )) {
      out.push({ text: row, bold: true });
    }
  }

  out.push(...fiscalBodyLines(doc.fiscal, width, norm));
  // C20: a non-fiscal receipt carries its code as a QR (scan it at the till to find the receipt).
  if (doc.fiscal === undefined && doc.lookupQr !== undefined && doc.lookupQr.length > 0) {
    out.push({ text: repeatDivider('-', width) });
    out.push({ text: centerLine('[QR]', width), qr: doc.lookupQr });
    out.push({ text: centerLine(norm(`Chek: ${doc.lookupQr}`), width) });
  }
  out.push({ text: repeatDivider('=', width) });
  for (const footerLine of wrapTextLines(
    norm(doc.footerText || 'Xaridingiz uchun rahmat!'),
    width,
  )) {
    out.push({ text: centerLine(footerLine, width) });
  }
  out.push(...fiscalFooterLines(doc.fiscal, width, norm));

  return out;
}

function buildReturnReceiptLines(
  doc: ReturnReceiptDocument,
  width: 32 | 48,
  encoding: PrinterEncodingMode,
): readonly StyledLine[] {
  const norm = (s: string) => normalizeTextForEncoding(s, encoding);
  const out: StyledLine[] = [];

  out.push(...fiscalHeaderLines(doc.fiscal, width, norm));
  out.push({ text: centerLine(norm('=== TOVAR QAYTARISH CHEKI ==='), width), bold: true });
  if (doc.isReprint || doc.copyNumber > 1) {
    out.push({
      text: centerLine(norm(`*** NUSXA #${String(doc.copyNumber)} (QAYTA CHOP ETILDI) ***`), width),
      bold: true,
    });
  }
  for (const titleLine of wrapTextLines(norm(doc.headerTitle || 'GUZAR KASSA'), width)) {
    out.push({ text: centerLine(titleLine, width) });
  }
  out.push({ text: repeatDivider('=', width) });

  for (const row of formatKeyValueRows(
    norm('Qaytarish:'),
    norm(`${doc.returnCode} (#${doc.returnNo.toString()})`),
    width,
  )) {
    out.push({ text: row });
  }
  for (const row of formatKeyValueRows(norm('Asl chek:'), norm(doc.saleReceiptCode), width)) {
    out.push({ text: row });
  }
  for (const row of formatKeyValueRows(norm('Smena:'), norm(doc.shiftCode), width)) {
    out.push({ text: row });
  }
  for (const row of formatKeyValueRows(norm('Sana:'), norm(doc.formattedDateTime), width)) {
    out.push({ text: row });
  }
  for (const row of formatKeyValueRows(norm('Xodim:'), norm(doc.actorName), width)) {
    out.push({ text: row });
  }
  for (const row of formatKeyValueRows(norm('Sabab:'), norm(doc.reason), width)) {
    out.push({ text: row });
  }

  out.push({ text: repeatDivider('-', width) });

  for (const line of doc.lines) {
    const itemTitle = `${String(line.lineNo)}. ${norm(line.itemName)}`;
    for (const wrapped of wrapTextLines(itemTitle, width, '   ')) {
      out.push({ text: wrapped });
    }
    const qtyPriceExpr = `   ${formatMilliQty(line.qtyMilli)} ${norm(line.unit)} x ${formatTiyinAmount(line.unitPriceTiyin)}`;
    for (const row of formatKeyValueRows(
      qtyPriceExpr,
      formatTiyinAmount(line.refundAmountTiyin),
      width,
    )) {
      out.push({ text: row });
    }
  }

  out.push({ text: repeatDivider('-', width) });

  for (const row of formatKeyValueRows(
    norm('JAMI QAYTARILDI:'),
    `${formatTiyinAmount(doc.totalRefundTiyin)} so'm`,
    width,
  )) {
    out.push({ text: row, bold: true });
  }
  for (const row of formatKeyValueRows(
    norm('Shu jumladan QQS:'),
    `${formatTiyinAmount(doc.totalVatTiyin)} so'm`,
    width,
  )) {
    out.push({ text: row });
  }

  out.push({ text: repeatDivider('-', width) });
  for (const p of doc.payments) {
    const label = translatePaymentMethodLabel(p.method);
    for (const row of formatKeyValueRows(
      norm(`${label}:`),
      `${formatTiyinAmount(p.amountTiyin)} so'm`,
      width,
    )) {
      out.push({ text: row });
    }
  }

  out.push({ text: repeatDivider('=', width) });
  out.push(...fiscalBodyLines(doc.fiscal, width, norm));
  out.push(...fiscalFooterLines(doc.fiscal, width, norm));

  return out;
}

function buildShiftCloseLines(
  doc: ShiftCloseReportDocument,
  width: 32 | 48,
  encoding: PrinterEncodingMode,
): readonly StyledLine[] {
  const norm = (s: string) => normalizeTextForEncoding(s, encoding);
  const out: StyledLine[] = [];

  out.push({ text: centerLine(norm(NON_FISCAL_LINE), width), bold: true });
  out.push({ text: centerLine(norm('=== SMENA YOPILISH HISOBOTI ==='), width), bold: true });
  if (doc.isReprint || doc.copyNumber > 1) {
    out.push({
      text: centerLine(norm(`*** NUSXA #${String(doc.copyNumber)} (QAYTA CHOP ETILDI) ***`), width),
      bold: true,
    });
  }
  for (const titleLine of wrapTextLines(norm(doc.headerTitle || 'GUZAR KASSA'), width)) {
    out.push({ text: centerLine(titleLine, width) });
  }
  out.push({ text: repeatDivider('=', width) });

  for (const row of formatKeyValueRows(
    norm('Smena:'),
    norm(`${doc.shiftCode} (Yopish #${String(doc.closeSeq)})`),
    width,
  )) {
    out.push({ text: row });
  }
  for (const row of formatKeyValueRows(norm('Yopdi:'), norm(doc.closedByName), width)) {
    out.push({ text: row });
  }
  for (const row of formatKeyValueRows(norm('Ochildi:'), norm(doc.openedAtFormatted), width)) {
    out.push({ text: row });
  }
  for (const row of formatKeyValueRows(norm('Yopildi:'), norm(doc.closedAtFormatted), width)) {
    out.push({ text: row });
  }

  out.push({ text: repeatDivider('-', width) });
  for (const row of formatKeyValueRows(norm('Cheklar soni:'), String(doc.salesCount), width)) {
    out.push({ text: row });
  }
  for (const row of formatKeyValueRows(norm('Qaytarishlar:'), String(doc.returnsCount), width)) {
    out.push({ text: row });
  }
  for (const row of formatKeyValueRows(norm('Bekor qilingan:'), String(doc.voidsCount), width)) {
    out.push({ text: row });
  }
  for (const row of formatKeyValueRows(
    norm('Yalpi savdo:'),
    `${formatTiyinAmount(doc.grossSalesTiyin)} so'm`,
    width,
  )) {
    out.push({ text: row });
  }
  for (const row of formatKeyValueRows(
    norm('Qaytarish summasi:'),
    `${formatTiyinAmount(doc.returnsTotalTiyin)} so'm`,
    width,
  )) {
    out.push({ text: row });
  }
  for (const row of formatKeyValueRows(
    norm('Sof savdo:'),
    `${formatTiyinAmount(doc.netSalesTiyin)} so'm`,
    width,
  )) {
    out.push({ text: row, bold: true });
  }

  out.push({ text: repeatDivider('-', width) });
  for (const row of formatKeyValueRows(
    norm("Boshlang'ich naqd:"),
    `${formatTiyinAmount(doc.openingCashTiyin)} so'm`,
    width,
  )) {
    out.push({ text: row });
  }
  for (const row of formatKeyValueRows(
    norm('Naqd savdo (sof):'),
    `${formatTiyinAmount(doc.cashSalesNetTiyin)} so'm`,
    width,
  )) {
    out.push({ text: row });
  }
  for (const row of formatKeyValueRows(
    norm('Naqd qaytarish:'),
    `${formatTiyinAmount(doc.cashReturnsTotalTiyin)} so'm`,
    width,
  )) {
    out.push({ text: row });
  }
  for (const row of formatKeyValueRows(
    norm('Kassa kirim:'),
    `${formatTiyinAmount(doc.cashInTotalTiyin)} so'm`,
    width,
  )) {
    out.push({ text: row });
  }
  for (const row of formatKeyValueRows(
    norm('Kassa chiqim:'),
    `${formatTiyinAmount(doc.cashOutTotalTiyin)} so'm`,
    width,
  )) {
    out.push({ text: row });
  }
  for (const row of formatKeyValueRows(
    norm('Xarajatlar:'),
    `${formatTiyinAmount(doc.expenseTotalTiyin)} so'm`,
    width,
  )) {
    out.push({ text: row });
  }
  for (const row of formatKeyValueRows(
    norm('Kutilgan naqd:'),
    `${formatTiyinAmount(doc.expectedCashTiyin)} so'm`,
    width,
  )) {
    out.push({ text: row, bold: true });
  }
  for (const row of formatKeyValueRows(
    norm('Sanab chiqilgan:'),
    `${formatTiyinAmount(doc.countedCashTiyin)} so'm`,
    width,
  )) {
    out.push({ text: row, bold: true });
  }
  for (const row of formatKeyValueRows(
    norm('Farq (naqd):'),
    `${formatTiyinAmount(doc.cashDiscrepancyTiyin)} so'm`,
    width,
  )) {
    out.push({ text: row, bold: true });
  }

  out.push({ text: repeatDivider('-', width) });
  for (const m of doc.nonCashByMethod) {
    if (m.netAmountTiyin !== 0n) {
      for (const row of formatKeyValueRows(
        norm(`${translatePaymentMethodLabel(m.method)}:`),
        `${formatTiyinAmount(m.netAmountTiyin)} so'm`,
        width,
      )) {
        out.push({ text: row });
      }
    }
  }
  for (const row of formatKeyValueRows(
    norm('Jami naqdsiz:'),
    `${formatTiyinAmount(doc.nonCashNetTotalTiyin)} so'm`,
    width,
  )) {
    out.push({ text: row, bold: true });
  }

  out.push({ text: repeatDivider('=', width) });
  out.push({ text: centerLine(norm(NON_FISCAL_LINE), width), bold: true });

  return out;
}

function buildTestPrintLines(
  doc: TestPrintDocument,
  width: 32 | 48,
  encoding: PrinterEncodingMode,
): readonly StyledLine[] {
  const norm = (s: string) => normalizeTextForEncoding(s, encoding);
  const out: StyledLine[] = [];

  out.push({ text: centerLine(norm(NON_FISCAL_LINE), width), bold: true });
  out.push({ text: centerLine(norm('=== PRINTER SINOV CHEKI ==='), width), bold: true });
  for (const titleLine of wrapTextLines(norm(doc.headerTitle || 'GUZAR KASSA'), width)) {
    out.push({ text: centerLine(titleLine, width) });
  }
  out.push({ text: repeatDivider('=', width) });
  for (const row of formatKeyValueRows(norm('Rejim:'), norm(doc.printerMode), width)) {
    out.push({ text: row });
  }
  for (const row of formatKeyValueRows(norm('Manzil:'), norm(doc.target), width)) {
    out.push({ text: row });
  }
  for (const row of formatKeyValueRows(
    norm('Kenglik:'),
    norm(`${String(doc.paperWidthMm)} mm (${String(width)} belgi)`),
    width,
  )) {
    out.push({ text: row });
  }
  for (const row of formatKeyValueRows(norm('Kodlash:'), norm(doc.encoding), width)) {
    out.push({ text: row });
  }
  for (const row of formatKeyValueRows(norm('Vaqt:'), norm(doc.formattedDateTime), width)) {
    out.push({ text: row });
  }
  out.push({ text: repeatDivider('-', width) });
  for (const wrapped of wrapTextLines(
    norm('Oʻzbek harflari sinovi: Oʻzbekiston, Gʻijduvon, Qahva aʼlo — 15 000 soʻm'),
    width,
  )) {
    out.push({ text: wrapped });
  }
  for (const wrapped of wrapTextLines(
    norm('Кирилл синови: Қўқон ҳолваси, Ғиждувон гўшти'),
    width,
  )) {
    out.push({ text: wrapped });
  }
  out.push({ text: repeatDivider('=', width) });
  out.push({ text: centerLine(norm(NON_FISCAL_LINE), width), bold: true });

  return out;
}

/**
 * Pure ESC/POS encoder converting a `PrintableDocument` (`sale`, `return`, `shift_close`, `test`)
 * into an exact `Uint8Array` byte sequence + human-readable `textPreview`.
 */
export function encodeEscPosDocument(params: {
  readonly document: PrintableDocument;
  readonly paperWidthMm: PrinterPaperWidthMm;
  readonly encoding: PrinterEncodingMode;
}): EncodedReceiptOutput {
  const width = getPaperWidthColumns(params.paperWidthMm);
  const { document, encoding } = params;

  let styledLines: readonly StyledLine[];
  let shouldOpenCashDrawer = false;

  switch (document.kind) {
    case 'sale':
      styledLines = buildSaleReceiptLines(document, width, encoding);
      shouldOpenCashDrawer = document.openCashDrawer;
      break;
    case 'return':
      styledLines = buildReturnReceiptLines(document, width, encoding);
      shouldOpenCashDrawer = document.openCashDrawer;
      break;
    case 'shift_close':
      styledLines = buildShiftCloseLines(document, width, encoding);
      break;
    case 'test':
      styledLines = buildTestPrintLines(document, width, encoding);
      break;
  }

  const chunks: Uint8Array[] = [];
  // 1. Initialize printer (`ESC @`) and select code page (`ESC t n`)
  chunks.push(ESC_INIT);
  chunks.push(new Uint8Array([0x1b, 0x74, getEscPosCodePageNumber(encoding)]));

  let isBoldActive = false;
  for (const line of styledLines) {
    const wantBold = Boolean(line.bold);
    if (wantBold !== isBoldActive) {
      chunks.push(wantBold ? ESC_BOLD_ON : ESC_BOLD_OFF);
      isBoldActive = wantBold;
    }
    if (line.qr !== undefined) {
      chunks.push(encodeEscPosQr(line.qr, params.paperWidthMm === 58 ? 4 : 6));
      continue;
    }
    chunks.push(encodeLineBytes(line.text, encoding));
    chunks.push(new Uint8Array([0x0a])); // LF
  }

  if (isBoldActive) {
    chunks.push(ESC_BOLD_OFF);
  }

  // 2. Partial cut with feed (`GS V 66 3`)
  chunks.push(GS_CUT_PARTIAL_FEED);

  // 3. Optional cash drawer kick pulse (`ESC p 0 25 250`)
  if (shouldOpenCashDrawer) {
    chunks.push(encodeCashDrawerPulse(0));
  }

  let totalLength = 0;
  for (const chunk of chunks) {
    totalLength += chunk.length;
  }
  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  const textPreview = styledLines.map((l) => l.text).join('\n');

  return {
    bytes,
    textPreview,
    lineWidthChars: width,
  };
}
