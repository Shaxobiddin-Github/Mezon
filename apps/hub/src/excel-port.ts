import ExcelJS from 'exceljs';
import { moneyToTiyin, quantityToMilli } from '@mezon/domain';
import type {
  DailySalesReportResult,
  DebtsReportResult,
  StoredProductRecord,
} from '@mezon/db-local';

export interface ExcelImportParsedRow {
  readonly rowNumber: number;
  readonly name: string;
  readonly sku?: string | null;
  readonly barcode?: string | null;
  readonly unit: string;
  readonly salePriceTiyin: bigint;
  readonly costPriceTiyin?: bigint | null;
  readonly minStockMilli?: bigint | null;
  readonly error?: string;
}

export interface ParseImportWorkbookResult {
  readonly totalRows: number;
  readonly validRows: readonly ExcelImportParsedRow[];
  readonly invalidRows: readonly ExcelImportParsedRow[];
}

export class ExcelPort {
  /**
   * Generates Daily Sales Excel report.
   * If includeCost is false, COGS and Gross Profit columns are omitted completely (for cashier/manager).
   */
  public static async generateDailySalesWorkbook(
    report: DailySalesReportResult,
    options: { readonly includeCost: boolean },
  ): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Guzar Hub';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Kunlik savdo');

    const columns: Partial<ExcelJS.Column>[] = [
      { header: 'Sana', key: 'date', width: 14 },
      { header: 'Cheklar soni', key: 'salesCount', width: 14 },
      { header: 'Qaytarishlar soni', key: 'returnsCount', width: 16 },
      { header: 'Jami tushum (soʻm)', key: 'grossSales', width: 20 },
      { header: 'Qaytarish summasi (soʻm)', key: 'returnsTotal', width: 22 },
      { header: 'Sof savdo (soʻm)', key: 'netSales', width: 20 },
      { header: 'Naqd (soʻm)', key: 'cashSales', width: 18 },
      { header: 'Naqd pulsiz (soʻm)', key: 'nonCashSales', width: 18 },
    ];

    if (options.includeCost) {
      columns.push(
        { header: 'Tannarx (soʻm)', key: 'costValue', width: 20 },
        { header: 'Yalpi foyda (soʻm)', key: 'grossProfit', width: 20 },
      );
    }

    sheet.columns = columns;

    // Header styling
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFEFEFEF' },
    };

    for (const d of report.days) {
      const rowData: Record<string, string | number> = {
        date: d.date,
        salesCount: d.salesCount,
        returnsCount: d.returnsCount,
        grossSales: Number(moneyToTiyin(d.grossSales) / 100n),
        returnsTotal: Number(moneyToTiyin(d.returnsTotal) / 100n),
        netSales: Number(moneyToTiyin(d.netSales) / 100n),
        cashSales: Number(moneyToTiyin(d.cashSales) / 100n),
        nonCashSales: Number(moneyToTiyin(d.nonCashSales) / 100n),
      };

      if (options.includeCost && d.costValue && d.grossProfit) {
        rowData.costValue = Number(moneyToTiyin(d.costValue) / 100n);
        rowData.grossProfit = Number(moneyToTiyin(d.grossProfit) / 100n);
      }

      sheet.addRow(rowData);
    }

    const arrayBuffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(arrayBuffer);
  }

  /**
   * Generates Customer & Supplier Debts Excel report.
   */
  public static async generateDebtsWorkbook(report: DebtsReportResult): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Guzar Hub';
    workbook.created = new Date();

    const custSheet = workbook.addWorksheet('Mijozlar qarzi');
    custSheet.columns = [
      { header: 'Mijoz F.I.Sh', key: 'fullName', width: 30 },
      { header: 'Telefon', key: 'phone', width: 18 },
      { header: 'Umumiy qarz (soʻm)', key: 'balance', width: 20 },
      { header: 'Muddati oʻtgan qarz (soʻm)', key: 'overdueAmount', width: 25 },
    ];
    custSheet.getRow(1).font = { bold: true };

    for (const c of report.customers) {
      custSheet.addRow({
        fullName: c.fullName,
        phone: c.phone ?? '-',
        balance: Number(moneyToTiyin(c.balance) / 100n),
        overdueAmount: Number(moneyToTiyin(c.overdueAmount) / 100n),
      });
    }

    const supSheet = workbook.addWorksheet('Yetkazib beruvchilar qarzi');
    supSheet.columns = [
      { header: 'Yetkazib beruvchi', key: 'name', width: 30 },
      { header: 'Qarz (soʻm)', key: 'balance', width: 20 },
    ];
    supSheet.getRow(1).font = { bold: true };

    for (const s of report.suppliers) {
      supSheet.addRow({
        name: s.name,
        balance: Number(moneyToTiyin(s.balance) / 100n),
      });
    }

    const arrayBuffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(arrayBuffer);
  }

  /**
   * Generates Catalog Excel export.
   * Omits cost price for non-owner callers.
   */
  public static async generateCatalogWorkbook(
    products: readonly StoredProductRecord[],
    _options: { readonly includeCost: boolean },
  ): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Guzar Hub';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Mahsulotlar');
    const cols: Partial<ExcelJS.Column>[] = [
      { header: 'Nomi', key: 'name', width: 30 },
      { header: 'Artikul (SKU)', key: 'sku', width: 16 },
      { header: 'Oʻlchov birligi', key: 'unit', width: 15 },
      { header: 'Sotish narxi (soʻm)', key: 'salePrice', width: 18 },
      { header: 'Minimal zaxira', key: 'minStock', width: 15 },
    ];

    sheet.columns = cols;
    sheet.getRow(1).font = { bold: true };

    for (const p of products) {
      const rowData: Record<string, string | number> = {
        name: p.name,
        sku: p.sku ?? '',
        unit: p.unit,
        salePrice: Number(moneyToTiyin(p.salePrice) / 100n),
        minStock: p.minStock ? Number(quantityToMilli(p.minStock) / 1000n) : '',
      };

      sheet.addRow(rowData);
    }

    const arrayBuffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(arrayBuffer);
  }

  /**
   * Normalizes barcode string, e.g. trims whitespace, handles 12-digit UPC-A by padding to 13 digits if appropriate.
   */
  public static normalizeBarcode(raw: string): string {
    const trimmed = raw.trim();
    if (/^\d{12}$/.test(trimmed)) {
      return `0${trimmed}`;
    }
    return trimmed;
  }

  /**
   * Parses uploaded Excel workbook for product import (max 5000 rows).
   */
  public static async parseImportWorkbook(buffer: Buffer): Promise<ParseImportWorkbookResult> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

    const sheet = workbook.worksheets[0];
    if (!sheet) {
      return { totalRows: 0, validRows: [], invalidRows: [] };
    }

    const validRows: ExcelImportParsedRow[] = [];
    const invalidRows: ExcelImportParsedRow[] = [];

    let totalDataRows = 0;

    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // Skip header row
      totalDataRows++;

      if (totalDataRows > 5000) {
        invalidRows.push({
          rowNumber,
          name: 'LIMIT_EXCEEDED',
          unit: 'dona',
          salePriceTiyin: 0n,
          error: 'Maksimal 5,000 qator ruxsat etiladi',
        });
        return;
      }

      const getCellString = (idx: number): string => {
        const val = row.getCell(idx).value;
        if (val === null || val === undefined) return '';
        if (typeof val === 'object') {
          if ('text' in val && typeof (val as { text?: unknown }).text === 'string') {
            return (val as { text: string }).text.trim();
          }
          if (
            'result' in val &&
            (typeof val.result === 'string' || typeof val.result === 'number')
          ) {
            return String(val.result).trim();
          }
          return '';
        }
        if (
          typeof val === 'string' ||
          typeof val === 'number' ||
          typeof val === 'boolean' ||
          typeof val === 'bigint'
        ) {
          return String(val).trim();
        }
        return '';
      };

      const name = getCellString(1);
      const skuRaw = getCellString(2);
      const barcodeRaw = getCellString(3);
      const unitRaw = getCellString(4).toLowerCase();
      const priceRaw = getCellString(5);
      const minStockRaw = getCellString(6);

      if (!name) {
        invalidRows.push({
          rowNumber,
          name: '',
          unit: unitRaw || 'dona',
          salePriceTiyin: 0n,
          error: 'Mahsulot nomi kiritilmagan',
        });
        return;
      }

      const validUnits = ['dona', 'kg', 'g', 'litr', 'metr', 'm2', 'qadoq'];
      const unit = validUnits.includes(unitRaw) ? unitRaw : 'dona';

      // Price parsing
      const cleanPrice = priceRaw.replace(/[^0-9.]/g, '');
      const priceNum = parseFloat(cleanPrice);
      if (isNaN(priceNum) || priceNum <= 0) {
        invalidRows.push({
          rowNumber,
          name,
          sku: skuRaw || null,
          barcode: barcodeRaw || null,
          unit,
          salePriceTiyin: 0n,
          error: 'Sotish narxi notoʻgʻri',
        });
        return;
      }
      const salePriceTiyin = BigInt(Math.round(priceNum * 100));

      // Min stock parsing
      let minStockMilli: bigint | null = null;
      if (minStockRaw) {
        const cleanStock = minStockRaw.replace(/[^0-9.]/g, '');
        const stockNum = parseFloat(cleanStock);
        if (!isNaN(stockNum) && stockNum >= 0) {
          minStockMilli = BigInt(Math.round(stockNum * 1000));
        }
      }

      const barcode = barcodeRaw ? ExcelPort.normalizeBarcode(barcodeRaw) : null;

      validRows.push({
        rowNumber,
        name,
        sku: skuRaw || null,
        barcode,
        unit,
        salePriceTiyin,
        minStockMilli,
      });
    });

    return {
      totalRows: totalDataRows,
      validRows,
      invalidRows,
    };
  }
}
