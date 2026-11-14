import { describe, expect, it } from 'vitest';
import {
  OpenCashDrawerRequestSchema,
  PrintDocumentRequestSchema,
  UpdatePrinterSettingsRequestSchema,
} from './printer.js';

describe('@mezon/contracts - T1.12 Printer & Receipt Contracts (P1 & P2)', () => {
  it('P2: accepts RFC 1918, link-local, and loopback IPv4 hosts and rejects public IPs & hostnames', () => {
    expect(
      UpdatePrinterSettingsRequestSchema.safeParse({
        mode: 'network_tcp',
        host: '192.168.1.200',
        port: 9100,
      }).success,
    ).toBe(true);

    expect(
      UpdatePrinterSettingsRequestSchema.safeParse({
        mode: 'network_tcp',
        host: '10.10.0.15',
        port: 9100,
      }).success,
    ).toBe(true);

    expect(
      UpdatePrinterSettingsRequestSchema.safeParse({
        mode: 'network_tcp',
        host: '172.16.5.9',
        port: 9100,
      }).success,
    ).toBe(true);

    expect(
      UpdatePrinterSettingsRequestSchema.safeParse({
        mode: 'network_tcp',
        host: '127.0.0.1',
        port: 9100,
      }).success,
    ).toBe(true);

    // Rejects 8.8.8.8 and example.com
    expect(
      UpdatePrinterSettingsRequestSchema.safeParse({
        mode: 'network_tcp',
        host: '8.8.8.8',
        port: 9100,
      }).success,
    ).toBe(false);

    expect(
      UpdatePrinterSettingsRequestSchema.safeParse({
        mode: 'network_tcp',
        host: 'example.com',
        port: 9100,
      }).success,
    ).toBe(false);
  });

  it('P1: requires UUIDv7 clientRequestId on PrintDocumentRequestSchema and OpenCashDrawerRequestSchema', () => {
    const validUuid = '01950000-0000-7000-8000-000000000001';
    expect(
      PrintDocumentRequestSchema.safeParse({
        clientRequestId: validUuid,
        reprint: true,
      }).success,
    ).toBe(true);

    expect(PrintDocumentRequestSchema.safeParse({}).success).toBe(false);

    expect(
      OpenCashDrawerRequestSchema.safeParse({
        clientRequestId: validUuid,
        reason: 'Mayda pul almashtirish',
      }).success,
    ).toBe(true);
  });
});
