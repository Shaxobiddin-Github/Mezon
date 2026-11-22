import {
  CreateCategoryRequestSchema,
  CreateCustomerRequestSchema,
  CreateProductRequestSchema,
  type LoadDemoCatalogResponse,
} from '@mezon/contracts';
import { DomainError, type ProductUnit, type UuidV7 } from '@mezon/domain';
import type { HubCatalogService } from './catalog-service.js';
import type { HubCustomerService } from './customer-service.js';
import type { HubStockService } from './stock-service.js';

/**
 * Starter catalog for trying the kassa as a real neighbourhood shop (C18): 100 everyday goods in
 * 10 categories, with sum prices typical for Tashkent in late 2026, opening stock, and a few
 * regular customers who buy on credit.
 *
 * Barcodes are in-store EAN-13 codes (prefix 20..29 is reserved for a shop's own labels), never
 * real manufacturers' codes: the owner prints them from the cabinet sheet or adds the real code of
 * a product by scanning it in the product form. MXIK is left empty on purpose (the owner fills the
 * real codes; we never invent tax codes).
 */
export interface DemoProduct {
  readonly name: string;
  readonly unit: ProductUnit;
  /** Sale price in sum (whole). */
  readonly priceSom: number;
  /** Opening stock in units (kg for weighed goods). */
  readonly stock: number;
  /** Low-stock warning threshold in units. */
  readonly minStock: number;
}

export interface DemoCategory {
  readonly name: string;
  readonly products: readonly DemoProduct[];
}

const p = (
  name: string,
  unit: ProductUnit,
  priceSom: number,
  stock: number,
  minStock: number,
): DemoProduct => ({ name, unit, priceSom, stock, minStock });

export const DEMO_CATALOG: readonly DemoCategory[] = [
  {
    name: 'Non va un',
    products: [
      p('Non (patir)', 'dona', 5_000, 60, 15),
      p('Non (obi non)', 'dona', 4_000, 80, 20),
      p('Baton oq', 'dona', 6_000, 30, 8),
      p('Qora non', 'dona', 7_000, 20, 5),
      p('Un oliy nav 2 kg', 'dona', 22_000, 25, 5),
      p('Un 1-nav 50 kg qop', 'dona', 390_000, 4, 1),
      p('Makaron (shoxcha) 400 g', 'dona', 9_000, 40, 10),
      p('Spagetti 500 g', 'dona', 14_000, 30, 8),
      p('Lag‘mon uchun xamir 500 g', 'dona', 12_000, 20, 5),
      p('Pechenye «Yubileynoe» 300 g', 'dona', 16_000, 24, 6),
    ],
  },
  {
    name: 'Sut mahsulotlari',
    products: [
      p('Sut 3,2% 1 l', 'dona', 14_000, 40, 10),
      p('Sut 2,5% 0,9 l', 'dona', 12_000, 30, 10),
      p('Qatiq 1 l', 'dona', 13_000, 25, 8),
      p('Kefir 1 l', 'dona', 14_000, 20, 6),
      p('Smetana 20% 400 g', 'dona', 18_000, 18, 5),
      p('Tvorog 9% 400 g', 'dona', 24_000, 12, 4),
      p('Sariyog‘ 82% 200 g', 'dona', 32_000, 15, 5),
      p('Pishloq «Gollandskiy»', 'kg', 120_000, 6, 1),
      p('Suzma 500 g', 'dona', 20_000, 10, 3),
      p('Tuxum (1 dona)', 'dona', 1_600, 360, 60),
    ],
  },
  {
    name: 'Ichimliklar',
    products: [
      p('Coca-Cola 1,5 l', 'dona', 14_000, 36, 12),
      p('Coca-Cola 0,5 l', 'dona', 7_000, 48, 12),
      p('Fanta 1,5 l', 'dona', 13_000, 24, 8),
      p('Sprite 1,5 l', 'dona', 13_000, 24, 8),
      p('Mineral suv «Hydrolife» 1,5 l', 'dona', 5_000, 60, 18),
      p('Mineral suv gazli 0,5 l', 'dona', 3_500, 60, 18),
      p('Sharbat «Bliss» 1 l', 'dona', 17_000, 18, 6),
      p('Energetik ichimlik 0,45 l', 'dona', 12_000, 24, 6),
      p('Kvas 1,5 l', 'dona', 11_000, 12, 4),
      p('Muzli choy 1 l', 'dona', 10_000, 18, 6),
    ],
  },
  {
    name: 'Choy va qahva',
    products: [
      p('Ko‘k choy №95 100 g', 'dona', 9_000, 40, 10),
      p('Qora choy «Ahmad» 100 g', 'dona', 25_000, 20, 5),
      p('Qora choy paketli 25 ta', 'dona', 15_000, 24, 6),
      p('Qahva «Nescafe Classic» 95 g', 'dona', 45_000, 12, 3),
      p('Qahva 3 in 1 (1 dona)', 'dona', 2_500, 100, 20),
      p('Kakao «Nesquik» 250 g', 'dona', 38_000, 8, 2),
      p('Shakar', 'kg', 15_000, 50, 10),
      p('Shakar kubik 500 g', 'dona', 16_000, 15, 4),
      p('Asal 500 g', 'dona', 60_000, 6, 2),
      p('Murabbo 400 g', 'dona', 22_000, 10, 3),
    ],
  },
  {
    name: 'Bakaleya',
    products: [
      p('Guruch «Lazer»', 'kg', 24_000, 40, 10),
      p('Guruch «Devzira»', 'kg', 38_000, 25, 5),
      p('Grechka 800 g', 'dona', 22_000, 15, 4),
      p('Mosh', 'kg', 20_000, 15, 3),
      p('No‘xat', 'kg', 18_000, 15, 3),
      p('Paxta yog‘i 1 l', 'dona', 24_000, 30, 8),
      p('Kungaboqar yog‘i 1 l', 'dona', 22_000, 30, 8),
      p('Tuz yodlangan 1 kg', 'dona', 4_000, 30, 8),
      p('Tomat pastasi 380 g', 'dona', 14_000, 20, 5),
      p('Mayonez 400 g', 'dona', 16_000, 20, 5),
    ],
  },
  {
    name: 'Go‘sht va kolbasa',
    products: [
      p('Mol go‘shti', 'kg', 110_000, 15, 3),
      p('Qo‘y go‘shti', 'kg', 125_000, 10, 2),
      p('Tovuq son', 'kg', 42_000, 20, 5),
      p('Tovuq filesi', 'kg', 58_000, 12, 3),
      p('Kolbasa «Doktorskaya»', 'kg', 85_000, 6, 2),
      p('Sosiska 1 kg', 'dona', 65_000, 10, 3),
      p('Qiyma mol go‘shti', 'kg', 105_000, 8, 2),
      p('Pelmen muzlatilgan 800 g', 'dona', 38_000, 12, 3),
      p('Konserva «Tushonka» 325 g', 'dona', 32_000, 15, 4),
      p('Baliq konservasi 240 g', 'dona', 18_000, 15, 4),
    ],
  },
  {
    name: 'Meva va sabzavot',
    products: [
      p('Kartoshka', 'kg', 6_000, 100, 20),
      p('Piyoz', 'kg', 5_000, 80, 15),
      p('Sabzi', 'kg', 5_000, 80, 15),
      p('Pomidor', 'kg', 14_000, 30, 8),
      p('Bodring', 'kg', 12_000, 25, 6),
      p('Olma', 'kg', 15_000, 40, 8),
      p('Banan', 'kg', 22_000, 25, 6),
      p('Limon', 'kg', 28_000, 10, 2),
      p('Sarimsoq', 'kg', 30_000, 5, 1),
      p('Ko‘kat (bog‘)', 'dona', 3_000, 30, 10),
    ],
  },
  {
    name: 'Shirinliklar',
    products: [
      p('Shokolad «Alpen Gold» 85 g', 'dona', 14_000, 30, 8),
      p('Shokolad «Snickers» 50 g', 'dona', 9_000, 40, 10),
      p('Konfet assorti', 'kg', 65_000, 8, 2),
      p('Vafli «Artek» 250 g', 'dona', 12_000, 20, 5),
      p('Saqich «Orbit»', 'dona', 6_000, 50, 10),
      p('Muzqaymoq stakan', 'dona', 6_000, 40, 10),
      p('Tort «Napoleon» 1 kg', 'dona', 95_000, 3, 1),
      p('Holva 350 g', 'dona', 18_000, 12, 3),
      p('Pista (qovurilgan) 100 g', 'dona', 22_000, 15, 4),
      p('Chips 90 g', 'dona', 13_000, 30, 8),
    ],
  },
  {
    name: 'Maishiy kimyo',
    products: [
      p('Kir yuvish kukuni 3 kg', 'dona', 65_000, 10, 3),
      p('Kir yuvish geli 1 l', 'dona', 45_000, 8, 2),
      p('Idish yuvish vositasi 500 ml', 'dona', 16_000, 20, 5),
      p('Oqartiruvchi «Belizna» 1 l', 'dona', 9_000, 15, 4),
      p('Pol yuvish vositasi 1 l', 'dona', 20_000, 10, 3),
      p('Hojatxona tozalagich 750 ml', 'dona', 22_000, 10, 3),
      p('Axlat paketi 30 dona', 'dona', 14_000, 20, 5),
      p('Gubka (5 dona)', 'dona', 8_000, 20, 5),
      p('Gugurt', 'dona', 1_000, 50, 10),
      p('Paket (savdo) katta', 'dona', 500, 500, 100),
    ],
  },
  {
    name: 'Gigiyena',
    products: [
      p('Sovun 90 g', 'dona', 6_000, 40, 10),
      p('Shampun 400 ml', 'dona', 42_000, 12, 3),
      p('Tish pastasi 100 ml', 'dona', 18_000, 20, 5),
      p('Tish cho‘tkasi', 'dona', 12_000, 15, 4),
      p('Hojatxona qog‘ozi (4 dona)', 'dona', 16_000, 25, 6),
      p('Salfetka 100 dona', 'dona', 7_000, 25, 6),
      p('Nam salfetka 72 dona', 'dona', 15_000, 15, 4),
      p('Bolalar tagligi (pampers) 4-o‘lcham', 'dona', 140_000, 6, 2),
      p('Paxta tayoqchalari', 'dona', 8_000, 15, 4),
      p('Dezodorant', 'dona', 38_000, 8, 2),
    ],
  },
];

export const DEMO_CUSTOMERS: readonly {
  readonly fullName: string;
  readonly phone: string;
  /** Credit limit in sum. */
  readonly creditLimitSom: number;
  readonly note: string;
}[] = [
  {
    fullName: 'Aliyev Bobur',
    phone: '+998901234501',
    creditLimitSom: 1_000_000,
    note: 'Qo‘shni, oylik kelganda to‘laydi',
  },
  {
    fullName: 'Karimova Dilnoza',
    phone: '+998901234502',
    creditLimitSom: 500_000,
    note: 'Har kuni non va sut oladi',
  },
  {
    fullName: 'Rahimov Sardor',
    phone: '+998901234503',
    creditLimitSom: 2_000_000,
    note: 'Choyxona egasi, ulgurji oladi',
  },
  {
    fullName: 'Toshpo‘latova Madina',
    phone: '+998901234504',
    creditLimitSom: 300_000,
    note: 'Nasiya muddati 15 kun',
  },
  {
    fullName: 'Ergashev Jasur',
    phone: '+998901234505',
    creditLimitSom: 700_000,
    note: 'Taksi haydovchisi',
  },
];

/** EAN-13 check digit for the first 12 digits. */
export function ean13CheckDigit(first12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i += 1) {
    const d = Number(first12[i]);
    sum += i % 2 === 0 ? d : d * 3;
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * In-store EAN-13 for the n-th demo product (n from 1): "200" + category (2 digits) + item
 * (2 digits) + "00000" + check digit. Prefix 200 is the range shops use for their own labels.
 */
export function demoBarcode(categoryNo: number, itemNo: number): string {
  const first12 = `200${String(categoryNo).padStart(2, '0')}${String(itemNo).padStart(2, '0')}00000`;
  return `${first12}${String(ean13CheckDigit(first12))}`;
}

/** Purchase cost is about 80% of the sale price (a typical shop margin), in tiyin. */
export function demoCostTiyin(priceSom: number, stock: number): bigint {
  return (BigInt(Math.round(priceSom * 0.8)) * 100n * BigInt(Math.round(stock * 1000))) / 1000n;
}

export interface DemoCatalogDeps {
  readonly catalogService: HubCatalogService;
  readonly stockService: HubStockService;
  readonly customerService: HubCustomerService;
}

/**
 * Loads the starter catalog. Only on a kassa with no products yet, so it can never mix sample
 * goods into a real shop's catalog.
 */
export async function loadDemoCatalog(
  deps: DemoCatalogDeps,
  actorUserId: UuidV7,
): Promise<LoadDemoCatalogResponse> {
  const existing = await deps.catalogService.listProducts({ limit: 1 });
  if (existing.total > 0) {
    throw new DomainError(
      'VALIDATION_ERROR',
      'Namuna katalog faqat boʻsh kassaga yuklanadi: katalogda tovarlar bor.',
    );
  }
  let products = 0;
  for (const [ci, category] of DEMO_CATALOG.entries()) {
    const { category: created } = await deps.catalogService.createCategory(
      CreateCategoryRequestSchema.parse({ name: category.name, sortOrder: ci }),
    );
    for (const [pi, item] of category.products.entries()) {
      const { product } = await deps.catalogService.createProduct(
        CreateProductRequestSchema.parse({
          categoryId: created.id,
          name: item.name,
          unit: item.unit,
          salePrice: String(item.priceSom * 100),
          minStock: String(item.minStock * 1000),
          barcodes: [{ barcode: demoBarcode(ci + 1, pi + 1) }],
        }),
        actorUserId,
      );
      await deps.stockService.recordInboundMove(
        {
          productId: product.id,
          reason: 'initial',
          qty: String(Math.round(item.stock * 1000)),
          totalCostValue: demoCostTiyin(item.priceSom, item.stock).toString(),
          note: 'Namuna katalog: boshlangʻich qoldiq',
        },
        actorUserId,
      );
      products += 1;
    }
  }
  for (const c of DEMO_CUSTOMERS) {
    await deps.customerService.createCustomer(
      CreateCustomerRequestSchema.parse({
        fullName: c.fullName,
        phone: c.phone,
        creditLimit: String(c.creditLimitSom * 100),
        note: c.note,
      }),
    );
  }
  return { categories: DEMO_CATALOG.length, products, customers: DEMO_CUSTOMERS.length };
}
