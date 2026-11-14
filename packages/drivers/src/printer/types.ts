import { DomainError } from '@mezon/domain';

export const PRINTER_MODES = ['disabled', 'windows_raw', 'network_tcp'] as const;
export type PrinterMode = (typeof PRINTER_MODES)[number];

export const PRINTER_PAPER_WIDTHS = [58, 80] as const;
export type PrinterPaperWidthMm = (typeof PRINTER_PAPER_WIDTHS)[number];

export const PRINTER_ENCODINGS = ['translit', 'cp866', 'cp1251'] as const;
export type PrinterEncodingMode = (typeof PRINTER_ENCODINGS)[number];

export const PRINT_DOCUMENT_TYPES = ['sale', 'return', 'shift_close', 'test'] as const;
export type PrintDocumentType = (typeof PRINT_DOCUMENT_TYPES)[number];

export const PRINT_OUTCOME_STATUSES = ['printed', 'failed', 'disabled'] as const;
export type PrintOutcomeStatus = (typeof PRINT_OUTCOME_STATUSES)[number];

export interface PrinterConfig {
  readonly mode: PrinterMode;
  readonly printerName: string | null;
  readonly host: string | null;
  readonly port: number;
  readonly timeoutMs: number;
  readonly paperWidthMm: PrinterPaperWidthMm;
  readonly encoding: PrinterEncodingMode;
  readonly autoPrintSale: boolean;
  readonly cashDrawerAutoOpen: boolean;
  readonly receiptHeaderTitle: string;
  readonly receiptFooterText: string;
}

export const DEFAULT_PRINTER_CONFIG: PrinterConfig = {
  mode: 'disabled',
  printerName: null,
  host: null,
  port: 9100,
  timeoutMs: 3000,
  paperWidthMm: 80,
  encoding: 'translit',
  autoPrintSale: true,
  cashDrawerAutoOpen: true,
  receiptHeaderTitle: 'GUZAR KASSA',
  receiptFooterText: 'Xaridingiz uchun rahmat!',
};

export interface DiscoveredWindowsPrinter {
  readonly name: string;
  readonly isDefault: boolean;
}

export interface PrintSendSuccess {
  readonly ok: true;
  readonly mode: PrinterMode;
  readonly target: string | null;
  readonly bytesSent: number;
}

export interface PrintSendFailure {
  readonly ok: false;
  readonly mode: PrinterMode;
  readonly target: string | null;
  readonly errorCode: string;
  readonly errorMessage: string;
}

export type PrintSendResult = PrintSendSuccess | PrintSendFailure;

/**
 * Port for sending raw ESC/POS bytes to a physical or virtual receipt printer.
 * Implementations NEVER throw on operational printer failures (offline, paper out, timeout);
 * instead they return a structured `PrintSendFailure` so sales/returns/shift closes never fail.
 */
export interface PrinterDriver {
  readonly mode: PrinterMode;
  sendRaw(bytes: Uint8Array, jobTitle?: string): Promise<PrintSendResult>;
}

export interface SaleReceiptLineInput {
  readonly lineNo: number;
  readonly itemName: string;
  readonly isQuickSale: boolean;
  readonly unit: string;
  readonly qtyMilli: bigint;
  readonly unitPriceTiyin: bigint;
  readonly grossTotalTiyin: bigint;
  readonly promoDiscountTiyin: bigint;
  readonly allocatedOrderDiscountTiyin: bigint;
  readonly finalTotalTiyin: bigint;
  readonly vatRateBp: number;
  readonly vatTotalTiyin: bigint;
}

export interface SaleReceiptPaymentInput {
  readonly method: string;
  readonly amountTiyin: bigint;
  readonly tenderedAmountTiyin: bigint | null;
  readonly providerRef: string | null;
}

export interface SaleReceiptDocument {
  readonly kind: 'sale';
  readonly headerTitle: string;
  readonly footerText: string;
  readonly receiptNo: bigint;
  readonly receiptCode: string;
  readonly shiftCode: string;
  readonly cashierName: string;
  readonly customerName: string | null;
  readonly formattedDateTime: string;
  readonly copyNumber: number;
  readonly isReprint: boolean;
  readonly lines: readonly SaleReceiptLineInput[];
  readonly subtotalGrossTiyin: bigint;
  readonly promoDiscountTotalTiyin: bigint;
  readonly orderDiscountTotalTiyin: bigint;
  readonly totalFinalTiyin: bigint;
  readonly totalVatTiyin: bigint;
  readonly paidAmountTiyin: bigint;
  readonly debtAmountTiyin: bigint;
  readonly changeAmountTiyin: bigint;
  readonly payments: readonly SaleReceiptPaymentInput[];
  readonly openCashDrawer: boolean;
}

export interface ReturnReceiptLineInput {
  readonly lineNo: number;
  readonly itemName: string;
  readonly unit: string;
  readonly qtyMilli: bigint;
  readonly unitPriceTiyin: bigint;
  readonly refundAmountTiyin: bigint;
  readonly vatTotalTiyin: bigint;
}

export interface ReturnReceiptPaymentInput {
  readonly method: string;
  readonly amountTiyin: bigint;
  readonly providerRef: string | null;
}

export interface ReturnReceiptDocument {
  readonly kind: 'return';
  readonly headerTitle: string;
  readonly footerText: string;
  readonly returnNo: bigint;
  readonly returnCode: string;
  readonly saleReceiptCode: string;
  readonly shiftCode: string;
  readonly actorName: string;
  readonly reason: string;
  readonly formattedDateTime: string;
  readonly copyNumber: number;
  readonly isReprint: boolean;
  readonly lines: readonly ReturnReceiptLineInput[];
  readonly totalRefundTiyin: bigint;
  readonly totalVatTiyin: bigint;
  readonly payments: readonly ReturnReceiptPaymentInput[];
  readonly openCashDrawer: boolean;
}

export interface ShiftCloseNonCashMethodInput {
  readonly method: string;
  readonly netAmountTiyin: bigint;
}

export interface ShiftCloseReportDocument {
  readonly kind: 'shift_close';
  readonly headerTitle: string;
  readonly shiftCode: string;
  readonly closeSeq: number;
  readonly closedByName: string;
  readonly openedAtFormatted: string;
  readonly closedAtFormatted: string;
  readonly copyNumber: number;
  readonly isReprint: boolean;
  readonly salesCount: number;
  readonly returnsCount: number;
  readonly voidsCount: number;
  readonly grossSalesTiyin: bigint;
  readonly returnsTotalTiyin: bigint;
  readonly netSalesTiyin: bigint;
  readonly openingCashTiyin: bigint;
  readonly cashSalesNetTiyin: bigint;
  readonly cashReturnsTotalTiyin: bigint;
  readonly cashInTotalTiyin: bigint;
  readonly cashOutTotalTiyin: bigint;
  readonly expenseTotalTiyin: bigint;
  readonly expectedCashTiyin: bigint;
  readonly countedCashTiyin: bigint;
  readonly cashDiscrepancyTiyin: bigint;
  readonly nonCashNetTotalTiyin: bigint;
  readonly nonCashByMethod: readonly ShiftCloseNonCashMethodInput[];
}

export interface TestPrintDocument {
  readonly kind: 'test';
  readonly headerTitle: string;
  readonly footerText: string;
  readonly printerMode: PrinterMode;
  readonly target: string;
  readonly paperWidthMm: PrinterPaperWidthMm;
  readonly encoding: PrinterEncodingMode;
  readonly formattedDateTime: string;
}

export type PrintableDocument =
  SaleReceiptDocument | ReturnReceiptDocument | ShiftCloseReportDocument | TestPrintDocument;

export interface EncodedReceiptOutput {
  readonly bytes: Uint8Array;
  readonly textPreview: string;
  readonly lineWidthChars: 32 | 48;
}

/**
 * Validates that a network printer host is strictly a private / local IPv4 address (P2):
 * - Loopback: `127.0.0.0/8`
 * - Private RFC 1918: `10.0.0.0/8`, `172.16.0.0/12` (`172.16..172.31`), `192.168.0.0/16`
 * - Link-local: `169.254.0.0/16`
 *
 * Hostnames (e.g. `example.com`) and public IPv4/IPv6 addresses (e.g. `8.8.8.8`, `1.1.1.1`)
 * are strictly rejected to prevent SSRF / exfiltration of receipt data over TCP.
 */
export function isAllowedLocalPrinterIpv4(host: string): boolean {
  const trimmed = host.trim();
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(trimmed);
  if (!match) {
    return false;
  }
  const octets = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
  for (const octet of octets) {
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      return false;
    }
  }
  const [a, b] = octets;
  // 127.0.0.0/8 loopback
  if (a === 127) {
    return true;
  }
  // 10.0.0.0/8 RFC 1918
  if (a === 10) {
    return true;
  }
  // 172.16.0.0/12 RFC 1918 (172.16.0.0 – 172.31.255.255)
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) {
    return true;
  }
  // 192.168.0.0/16 RFC 1918
  if (a === 192 && b === 168) {
    return true;
  }
  // 169.254.0.0/16 link-local
  if (a === 169 && b === 254) {
    return true;
  }
  return false;
}

export function assertValidLocalPrinterHost(host: string): string {
  const trimmed = host.trim();
  if (!isAllowedLocalPrinterIpv4(trimmed)) {
    throw new DomainError(
      'VALIDATION_ERROR',
      'Tarmoq printeri manzili faqat lokal IPv4 boʻlishi shart (10.x.x.x, 172.16-31.x.x, 192.168.x.x, 169.254.x.x yoki 127.x.x.x)',
    );
  }
  return trimmed;
}
