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
}

function buildSaleReceiptLines(
  doc: SaleReceiptDocument,
  width: 32 | 48,
  encoding: PrinterEncodingMode,
): readonly StyledLine[] {
  const norm = (s: string) => normalizeTextForEncoding(s, encoding);
  const out: StyledLine[] = [];

  out.push({ text: centerLine(norm('*** SINOV — FISKAL EMAS ***'), width), bold: true });
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

  out.push({ text: repeatDivider('=', width) });
  for (const footerLine of wrapTextLines(
    norm(doc.footerText || 'Xaridingiz uchun rahmat!'),
    width,
  )) {
    out.push({ text: centerLine(footerLine, width) });
  }
  out.push({ text: centerLine(norm('*** SINOV — FISKAL EMAS ***'), width), bold: true });

  return out;
}

function buildReturnReceiptLines(
  doc: ReturnReceiptDocument,
  width: 32 | 48,
  encoding: PrinterEncodingMode,
): readonly StyledLine[] {
  const norm = (s: string) => normalizeTextForEncoding(s, encoding);
  const out: StyledLine[] = [];

  out.push({ text: centerLine(norm('*** SINOV — FISKAL EMAS ***'), width), bold: true });
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
  out.push({ text: centerLine(norm('*** SINOV — FISKAL EMAS ***'), width), bold: true });

  return out;
}

function buildShiftCloseLines(
  doc: ShiftCloseReportDocument,
  width: 32 | 48,
  encoding: PrinterEncodingMode,
): readonly StyledLine[] {
  const norm = (s: string) => normalizeTextForEncoding(s, encoding);
  const out: StyledLine[] = [];

  out.push({ text: centerLine(norm('*** SINOV — FISKAL EMAS ***'), width), bold: true });
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
  out.push({ text: centerLine(norm('*** SINOV — FISKAL EMAS ***'), width), bold: true });

  return out;
}

function buildTestPrintLines(
  doc: TestPrintDocument,
  width: 32 | 48,
  encoding: PrinterEncodingMode,
): readonly StyledLine[] {
  const norm = (s: string) => normalizeTextForEncoding(s, encoding);
  const out: StyledLine[] = [];

  out.push({ text: centerLine(norm('*** SINOV — FISKAL EMAS ***'), width), bold: true });
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
  out.push({ text: centerLine(norm('*** SINOV — FISKAL EMAS ***'), width), bold: true });

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
