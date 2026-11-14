import { describe, expect, it } from 'vitest';
import {
  ESC_BOLD_OFF,
  ESC_BOLD_ON,
  ESC_INIT,
  GS_CUT_PARTIAL_FEED,
  assertValidLocalPrinterHost,
  encodeCashDrawerPulse,
  encodeEscPosDocument,
  encodeLineBytes,
  isAllowedLocalPrinterIpv4,
  transliterateToAscii,
  type ReturnReceiptDocument,
  type SaleReceiptDocument,
  type ShiftCloseReportDocument,
} from '../index.js';

function startsWithBytes(buffer: Uint8Array, prefix: Uint8Array): boolean {
  if (buffer.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (buffer[i] !== prefix[i]) return false;
  }
  return true;
}

function endsWithBytes(buffer: Uint8Array, suffix: Uint8Array): boolean {
  if (buffer.length < suffix.length) return false;
  const offset = buffer.length - suffix.length;
  for (let i = 0; i < suffix.length; i += 1) {
    if (buffer[offset + i] !== suffix[i]) return false;
  }
  return true;
}

function containsSubsequence(buffer: Uint8Array, seq: Uint8Array): boolean {
  if (seq.length === 0 || buffer.length < seq.length) return false;
  for (let i = 0; i <= buffer.length - seq.length; i += 1) {
    let match = true;
    for (let j = 0; j < seq.length; j += 1) {
      if (buffer[i + j] !== seq[j]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

describe('@mezon/drivers - ESC/POS Encoder, Codepages (translit/cp866/cp1251), 58mm/80mm Layouts & P2 Host Guard', () => {
  const sampleSaleDoc: SaleReceiptDocument = {
    kind: 'sale',
    headerTitle: "MEZON O'ZBEKISTON DO'KONI",
    footerText: 'Xaridingiz uchun rahmat!',
    receiptNo: 42n,
    receiptCode: 'R-000042',
    shiftCode: 'SH-000005',
    cashierName: "G'olibjon A'zamov",
    customerName: "O'tkirbek Mo'minov",
    formattedDateTime: '2026-11-11 14:30:00',
    copyNumber: 1,
    isReprint: false,
    lines: [
      {
        lineNo: 1,
        itemName: "G'ijduvon oliy navli bug'doy uni 5kg qadoqda",
        isQuickSale: false,
        unit: 'qadoq',
        qtyMilli: 2000n,
        unitPriceTiyin: 4_500_000n,
        grossTotalTiyin: 9_000_000n,
        promoDiscountTiyin: 500_000n,
        allocatedOrderDiscountTiyin: 0n,
        finalTotalTiyin: 8_500_000n,
        vatRateBp: 1200,
        vatTotalTiyin: 910_714n,
      },
      {
        lineNo: 2,
        itemName: 'Қўқон ҳолваси (сутли)',
        isQuickSale: true,
        unit: 'kg',
        qtyMilli: 1500n,
        unitPriceTiyin: 3_000_000n,
        grossTotalTiyin: 4_500_000n,
        promoDiscountTiyin: 0n,
        allocatedOrderDiscountTiyin: 0n,
        finalTotalTiyin: 4_500_000n,
        vatRateBp: 0,
        vatTotalTiyin: 0n,
      },
    ],
    subtotalGrossTiyin: 13_500_000n,
    promoDiscountTotalTiyin: 500_000n,
    orderDiscountTotalTiyin: 0n,
    totalFinalTiyin: 13_000_000n,
    totalVatTiyin: 910_714n,
    paidAmountTiyin: 10_000_000n,
    debtAmountTiyin: 3_000_000n,
    changeAmountTiyin: 1_000_000n,
    payments: [
      {
        method: 'cash',
        amountTiyin: 5_000_000n,
        tenderedAmountTiyin: 6_000_000n,
        providerRef: null,
      },
      {
        method: 'uzqr',
        amountTiyin: 5_000_000n,
        tenderedAmountTiyin: null,
        providerRef: 'QR-991',
      },
    ],
    openCashDrawer: true,
  };

  it('encodes 80mm (48 chars) and 58mm (32 chars) sale receipts with exact width, SINOV banner, and cash drawer pulse', () => {
    const out80 = encodeEscPosDocument({
      document: sampleSaleDoc,
      paperWidthMm: 80,
      encoding: 'translit',
    });
    expect(out80.lineWidthChars).toBe(48);
    for (const line of out80.textPreview.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(48);
    }
    expect(out80.textPreview).toContain('*** SINOV - FISKAL EMAS ***');
    expect(out80.textPreview).not.toContain('NUSXA');
    expect(out80.textPreview).toContain("Qo'qon holvasi (sutli) [Tez savdo]");
    expect(out80.textPreview).toContain("JAMI TO'LOV:");
    expect(out80.textPreview).toContain("130 000 so'm");
    expect(out80.textPreview).toContain('Qaytim (naqd):');
    expect(out80.textPreview).toContain('Nasiya (qarzga):');

    // Byte snapshot assertions: ESC @ + ESC t 0 at start, ESC E 1 / ESC E 0 bold toggles, GS V 66 3 cut + ESC p 0 25 250 pulse at end
    expect(startsWithBytes(out80.bytes, new Uint8Array([...ESC_INIT, 0x1b, 0x74, 0x00]))).toBe(
      true,
    );
    expect(containsSubsequence(out80.bytes, ESC_BOLD_ON)).toBe(true);
    expect(containsSubsequence(out80.bytes, ESC_BOLD_OFF)).toBe(true);
    const expectedTail = new Uint8Array([...GS_CUT_PARTIAL_FEED, ...encodeCashDrawerPulse(0)]);
    expect(endsWithBytes(out80.bytes, expectedTail)).toBe(true);

    // 58mm (32 chars) layout + reprint copy #2 without cash drawer pulse
    const out58Reprint = encodeEscPosDocument({
      document: {
        ...sampleSaleDoc,
        copyNumber: 2,
        isReprint: true,
        openCashDrawer: false,
      },
      paperWidthMm: 58,
      encoding: 'translit',
    });
    expect(out58Reprint.lineWidthChars).toBe(32);
    for (const line of out58Reprint.textPreview.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(32);
    }
    expect(out58Reprint.textPreview).toContain('*** NUSXA #2 (QAYTA CHOP ETILDI)');
    expect(endsWithBytes(out58Reprint.bytes, GS_CUT_PARTIAL_FEED)).toBe(true);
    expect(endsWithBytes(out58Reprint.bytes, encodeCashDrawerPulse(0))).toBe(false);
  });

  it('encodes Uzbek Latin & Cyrillic across translit, cp866, and cp1251 codepages accurately', () => {
    const sample = 'Oʻzbekiston Gʻijduvon aʼlo — Қўқон ҳолваси №1';
    const ascii = transliterateToAscii(sample);
    expect(ascii).toBe("O'zbekiston G'ijduvon a'lo - Qo'qon holvasi No1");

    const bytesTranslit = encodeLineBytes(sample, 'translit');
    expect(new TextDecoder().decode(bytesTranslit)).toBe(
      "O'zbekiston G'ijduvon a'lo - Qo'qon holvasi No1",
    );

    // CP866: 'Қ' -> 'К' (0x8a), 'ў' -> 'у' (0xe3), 'қ' -> 'к' (0xaa), 'о' -> 0xae, 'н' -> 0xad, '№' -> 0xfc
    const bytesCp866 = encodeLineBytes('Қўқон №1', 'cp866');
    expect(Array.from(bytesCp866)).toEqual([0x8a, 0xe3, 0xaa, 0xae, 0xad, 0x20, 0xfc, 0x31]);

    // CP1251: 'Қ' -> 'К' (0xca), 'ў' -> 'у' (0xf3), 'қ' -> 'к' (0xea), 'о' -> 0xee, 'н' -> 0xed, '№' -> 0xb9
    const bytesCp1251 = encodeLineBytes('Қўқон №1', 'cp1251');
    expect(Array.from(bytesCp1251)).toEqual([0xca, 0xf3, 0xea, 0xee, 0xed, 0x20, 0xb9, 0x31]);

    const docCp866 = encodeEscPosDocument({
      document: sampleSaleDoc,
      paperWidthMm: 80,
      encoding: 'cp866',
    });
    expect(startsWithBytes(docCp866.bytes, new Uint8Array([0x1b, 0x40, 0x1b, 0x74, 17]))).toBe(
      true,
    );

    const docCp1251 = encodeEscPosDocument({
      document: sampleSaleDoc,
      paperWidthMm: 80,
      encoding: 'cp1251',
    });
    expect(startsWithBytes(docCp1251.bytes, new Uint8Array([0x1b, 0x40, 0x1b, 0x74, 73]))).toBe(
      true,
    );
  });

  it('encodes Return Receipt (T1.6) and Shift Close Report (T1.9) documents cleanly', () => {
    const returnDoc: ReturnReceiptDocument = {
      kind: 'return',
      headerTitle: 'GUZAR KASSA',
      footerText: 'Rahmat',
      returnNo: 7n,
      returnCode: 'RET-000007',
      saleReceiptCode: 'R-000042',
      shiftCode: 'SH-000005',
      actorName: 'Menejer Jasur',
      reason: 'Yaroqsiz qadoq',
      formattedDateTime: '2026-11-11 15:00:00',
      copyNumber: 1,
      isReprint: false,
      lines: [
        {
          lineNo: 1,
          itemName: 'Coca-Cola 1.5L',
          unit: 'dona',
          qtyMilli: 1000n,
          unitPriceTiyin: 1_200_000n,
          refundAmountTiyin: 1_200_000n,
          vatTotalTiyin: 128_571n,
        },
      ],
      totalRefundTiyin: 1_200_000n,
      totalVatTiyin: 128_571n,
      payments: [{ method: 'cash', amountTiyin: 1_200_000n, providerRef: null }],
      openCashDrawer: true,
    };

    const encodedReturn = encodeEscPosDocument({
      document: returnDoc,
      paperWidthMm: 58,
      encoding: 'translit',
    });
    expect(encodedReturn.textPreview).toContain('=== TOVAR QAYTARISH CHEKI ===');
    expect(encodedReturn.textPreview).toContain('RET-000007');
    expect(encodedReturn.textPreview).toContain('R-000042');
    expect(encodedReturn.textPreview).toContain('JAMI QAYTARILDI:');

    const shiftCloseDoc: ShiftCloseReportDocument = {
      kind: 'shift_close',
      headerTitle: 'GUZAR KASSA',
      shiftCode: 'SH-000005',
      closeSeq: 1,
      closedByName: 'Sardor Egasi',
      openedAtFormatted: '2026-11-11 08:00:00',
      closedAtFormatted: '2026-11-11 20:00:00',
      copyNumber: 2,
      isReprint: true,
      salesCount: 15,
      returnsCount: 1,
      voidsCount: 0,
      grossSalesTiyin: 50_000_000n,
      returnsTotalTiyin: 1_200_000n,
      netSalesTiyin: 48_800_000n,
      openingCashTiyin: 10_000_000n,
      cashSalesNetTiyin: 30_000_000n,
      cashReturnsTotalTiyin: 1_200_000n,
      cashInTotalTiyin: 0n,
      cashOutTotalTiyin: 0n,
      expenseTotalTiyin: 500_000n,
      expectedCashTiyin: 38_300_000n,
      countedCashTiyin: 38_300_000n,
      cashDiscrepancyTiyin: 0n,
      nonCashNetTotalTiyin: 18_800_000n,
      nonCashByMethod: [
        { method: 'card', netAmountTiyin: 10_000_000n },
        { method: 'uzqr', netAmountTiyin: 8_800_000n },
      ],
    };

    const encodedShift = encodeEscPosDocument({
      document: shiftCloseDoc,
      paperWidthMm: 80,
      encoding: 'translit',
    });
    expect(encodedShift.textPreview).toContain('=== SMENA YOPILISH HISOBOTI ===');
    expect(encodedShift.textPreview).toContain('*** NUSXA #2 (QAYTA CHOP ETILDI) ***');
    expect(encodedShift.textPreview).toContain('Kutilgan naqd:');
    expect(encodedShift.textPreview).toContain('Jami naqdsiz:');
  });

  it('P2: allows only private/local IPv4 printer hosts and rejects public IPs & hostnames', () => {
    expect(isAllowedLocalPrinterIpv4('127.0.0.1')).toBe(true);
    expect(isAllowedLocalPrinterIpv4('10.0.0.50')).toBe(true);
    expect(isAllowedLocalPrinterIpv4('172.16.0.10')).toBe(true);
    expect(isAllowedLocalPrinterIpv4('172.31.255.250')).toBe(true);
    expect(isAllowedLocalPrinterIpv4('192.168.1.200')).toBe(true);
    expect(isAllowedLocalPrinterIpv4('169.254.10.20')).toBe(true);

    // Public IPs and out-of-range 172.x must be rejected
    expect(isAllowedLocalPrinterIpv4('8.8.8.8')).toBe(false);
    expect(isAllowedLocalPrinterIpv4('1.1.1.1')).toBe(false);
    expect(isAllowedLocalPrinterIpv4('172.15.0.1')).toBe(false);
    expect(isAllowedLocalPrinterIpv4('172.32.0.1')).toBe(false);
    expect(isAllowedLocalPrinterIpv4('192.169.1.1')).toBe(false);
    expect(isAllowedLocalPrinterIpv4('example.com')).toBe(false);
    expect(isAllowedLocalPrinterIpv4('localhost')).toBe(false);

    expect(() => assertValidLocalPrinterHost('8.8.8.8')).toThrow(/lokal IPv4/);
    expect(() => assertValidLocalPrinterHost('example.com')).toThrow(/lokal IPv4/);
    expect(assertValidLocalPrinterHost(' 192.168.0.91 ')).toBe('192.168.0.91');
  });
});
