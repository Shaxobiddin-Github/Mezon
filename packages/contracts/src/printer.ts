import { z } from 'zod';
import { BigIntStringSchema, LoginRequestSchema, UuidV7Schema } from './auth.js';

export const PrinterModeSchema = z.enum(['disabled', 'windows_raw', 'network_tcp']);
export type PrinterModeDto = z.infer<typeof PrinterModeSchema>;

export const PrinterPaperWidthMmSchema = z.union([z.literal(58), z.literal(80)]);
export type PrinterPaperWidthMmDto = z.infer<typeof PrinterPaperWidthMmSchema>;

export const PrinterEncodingSchema = z.enum(['translit', 'cp866', 'cp1251']);
export type PrinterEncodingDto = z.infer<typeof PrinterEncodingSchema>;

export const PrintDocumentTypeSchema = z.enum(['sale', 'return', 'shift_close', 'test']);
export type PrintDocumentTypeDto = z.infer<typeof PrintDocumentTypeSchema>;

export const PrintOutcomeStatusSchema = z.enum(['printed', 'failed', 'disabled']);
export type PrintOutcomeStatusDto = z.infer<typeof PrintOutcomeStatusSchema>;

/**
 * P2: Validates that a network printer host is strictly a private/local IPv4 address:
 * - `127.0.0.0/8` (loopback)
 * - `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` (RFC 1918)
 * - `169.254.0.0/16` (link-local)
 * Public IPs (`8.8.8.8`) and hostnames (`example.com`) are rejected with `400 VALIDATION_ERROR`.
 */
export function isLocalPrinterIpv4Contract(host: string): boolean {
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
  if (a === 127 || a === 10) {
    return true;
  }
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  return false;
}

export const LocalPrinterHostSchema = z
  .string()
  .trim()
  .min(7)
  .max(45)
  .refine(isLocalPrinterIpv4Contract, {
    message:
      'Tarmoq printeri manzili faqat lokal IPv4 boʻlishi shart (10.x.x.x, 172.16-31.x.x, 192.168.x.x, 169.254.x.x yoki 127.x.x.x)',
  });

export const PrinterSettingsDtoSchema = z.object({
  mode: PrinterModeSchema,
  printerName: z.string().nullable(),
  host: z.string().nullable(),
  port: z.number().int().min(1).max(65535),
  timeoutMs: z.number().int().min(200).max(30000),
  paperWidthMm: PrinterPaperWidthMmSchema,
  encoding: PrinterEncodingSchema,
  autoPrintSale: z.boolean(),
  cashDrawerAutoOpen: z.boolean(),
  receiptHeaderTitle: z.string(),
  receiptFooterText: z.string(),
});
export type PrinterSettingsDto = z.infer<typeof PrinterSettingsDtoSchema>;

export const UpdatePrinterSettingsRequestSchema = z
  .object({
    mode: PrinterModeSchema.optional(),
    printerName: z.string().trim().min(1).max(200).nullable().optional(),
    host: LocalPrinterHostSchema.nullable().optional(),
    port: z.number().int().min(1).max(65535).optional(),
    timeoutMs: z.number().int().min(200).max(30000).optional(),
    paperWidthMm: PrinterPaperWidthMmSchema.optional(),
    encoding: PrinterEncodingSchema.optional(),
    autoPrintSale: z.boolean().optional(),
    cashDrawerAutoOpen: z.boolean().optional(),
    receiptHeaderTitle: z.string().trim().min(1).max(80).optional(),
    receiptFooterText: z.string().trim().min(1).max(160).optional(),
  })
  .strict();
export type UpdatePrinterSettingsRequestDto = z.infer<typeof UpdatePrinterSettingsRequestSchema>;

export const PrinterSettingsResponseSchema = z.object({
  settings: PrinterSettingsDtoSchema,
});
export type PrinterSettingsResponseDto = z.infer<typeof PrinterSettingsResponseSchema>;

export const DiscoveredWindowsPrinterDtoSchema = z.object({
  name: z.string(),
  isDefault: z.boolean(),
});
export type DiscoveredWindowsPrinterDto = z.infer<typeof DiscoveredWindowsPrinterDtoSchema>;

export const ListWindowsPrintersResponseSchema = z.object({
  printers: z.array(DiscoveredWindowsPrinterDtoSchema),
});
export type ListWindowsPrintersResponseDto = z.infer<typeof ListWindowsPrintersResponseSchema>;

/**
 * P1: Every print request (`sale`, `return`, `shift_close`) accepts `clientRequestId` (UUIDv7)
 * so duplicate clicks or network retries never re-send bytes to the printer or duplicate audit rows.
 */
export const PrintDocumentRequestSchema = z
  .object({
    clientRequestId: UuidV7Schema,
    reprint: z.boolean().optional(),
  })
  .strict();
export type PrintDocumentRequestDto = z.infer<typeof PrintDocumentRequestSchema>;

export const ReceiptPrintRecordDtoSchema = z.object({
  id: UuidV7Schema,
  organizationId: UuidV7Schema,
  storeId: UuidV7Schema,
  documentType: PrintDocumentTypeSchema,
  documentId: UuidV7Schema,
  printSeq: z.number().int().min(1),
  copyNumber: z.number().int().min(1),
  isReprint: z.boolean(),
  actorUserId: UuidV7Schema,
  status: PrintOutcomeStatusSchema,
  printerMode: PrinterModeSchema,
  printerTarget: z.string().nullable(),
  bytesSent: z.number().int().min(0),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  textPreview: z.string(),
  clientRequestId: UuidV7Schema,
  createdAtMs: BigIntStringSchema,
});
export type ReceiptPrintRecordDto = z.infer<typeof ReceiptPrintRecordDtoSchema>;

export const PrintDocumentResponseSchema = z.object({
  printRecord: ReceiptPrintRecordDtoSchema,
  idempotentReplay: z.boolean(),
});
export type PrintDocumentResponseDto = z.infer<typeof PrintDocumentResponseSchema>;

export const ListReceiptPrintsResponseSchema = z.object({
  prints: z.array(ReceiptPrintRecordDtoSchema),
});
export type ListReceiptPrintsResponseDto = z.infer<typeof ListReceiptPrintsResponseSchema>;

export const TestPrintResponseSchema = z.object({
  status: PrintOutcomeStatusSchema,
  printerMode: PrinterModeSchema,
  printerTarget: z.string().nullable(),
  bytesSent: z.number().int().min(0),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  textPreview: z.string(),
});
export type TestPrintResponseDto = z.infer<typeof TestPrintResponseSchema>;

export const OpenCashDrawerRequestSchema = z
  .object({
    clientRequestId: UuidV7Schema,
    reason: z.string().trim().min(2).max(200),
    override: LoginRequestSchema.optional(),
  })
  .strict();
export type OpenCashDrawerRequestDto = z.infer<typeof OpenCashDrawerRequestSchema>;

export const CashDrawerEventDtoSchema = z.object({
  id: UuidV7Schema,
  organizationId: UuidV7Schema,
  storeId: UuidV7Schema,
  shiftId: UuidV7Schema.nullable(),
  actorUserId: UuidV7Schema,
  overrideApprovedByUserId: UuidV7Schema.nullable(),
  reason: z.string(),
  status: PrintOutcomeStatusSchema,
  printerMode: PrinterModeSchema,
  printerTarget: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  clientRequestId: UuidV7Schema,
  createdAtMs: BigIntStringSchema,
});
export type CashDrawerEventDto = z.infer<typeof CashDrawerEventDtoSchema>;

export const OpenCashDrawerResponseSchema = z.object({
  event: CashDrawerEventDtoSchema,
  idempotentReplay: z.boolean(),
});
export type OpenCashDrawerResponseDto = z.infer<typeof OpenCashDrawerResponseSchema>;
