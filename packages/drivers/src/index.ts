export const DRIVERS_PACKAGE = '@mezon/drivers';

export { SystemClock } from './system-clock.js';
export { CryptoRandomSource } from './crypto-random.js';
export { createSystemUuidV7Generator } from './uuidv7-generator.js';

export {
  DEFAULT_PRINTER_CONFIG,
  PRINTER_ENCODINGS,
  PRINTER_MODES,
  PRINTER_PAPER_WIDTHS,
  PRINT_DOCUMENT_TYPES,
  PRINT_OUTCOME_STATUSES,
  assertValidLocalPrinterHost,
  isAllowedLocalPrinterIpv4,
  type DiscoveredWindowsPrinter,
  type EncodedReceiptOutput,
  type PrintDocumentType,
  type PrintOutcomeStatus,
  type PrintSendFailure,
  type PrintSendResult,
  type PrintSendSuccess,
  type PrintableDocument,
  type PrinterConfig,
  type PrinterDriver,
  type PrinterEncodingMode,
  type PrinterMode,
  type PrinterPaperWidthMm,
  type ReturnReceiptDocument,
  type ReturnReceiptLineInput,
  type ReturnReceiptPaymentInput,
  type SaleReceiptDocument,
  type SaleReceiptLineInput,
  type SaleReceiptPaymentInput,
  type ShiftCloseNonCashMethodInput,
  type ShiftCloseReportDocument,
  type TestPrintDocument,
} from './printer/types.js';
export {
  encodeLineBytes,
  getEscPosCodePageNumber,
  normalizeTextForEncoding,
  normalizeUzbekTypography,
  transliterateToAscii,
} from './printer/codepage.js';
export {
  centerLine,
  formatKeyValueRows,
  formatMilliQty,
  formatTiyinAmount,
  formatVatRatePercent,
  getPaperWidthColumns,
  repeatDivider,
  wrapTextLines,
} from './printer/layout.js';
export {
  ESC_BOLD_OFF,
  ESC_BOLD_ON,
  ESC_INIT,
  GS_CUT_PARTIAL_FEED,
  encodeCashDrawerPulse,
  encodeEscPosDocument,
} from './printer/escpos-encoder.js';
export { NullPrinterDriver } from './printer/null-driver.js';
export {
  FakePrinterDriver,
  type FakePrintJob,
  type FakePrinterFailureConfig,
} from './printer/fake-driver.js';
