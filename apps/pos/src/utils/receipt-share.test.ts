import type { SaleDto } from '@mezon/contracts';
import { describe, expect, it } from 'vitest';
import { nakladnoyHtml, receiptPrintHtml } from './receipt-share.js';

const labels = {
  title: 'Yuk xati',
  receipt: 'Chek',
  date: 'Sana',
  seller: 'Sotuvchi',
  buyer: 'Xaridor',
  no: '№',
  item: 'Tovar',
  qty: 'Miqdor',
  price: 'Narx',
  discount: 'Chegirma',
  sum: 'Summa',
  total: 'Jami',
  paid: 'Toʻlandi',
  debt: 'Qarzga',
  handedOver: 'Topshirdi',
  received: 'Qabul qildi',
  currency: "so'm",
};

const sale = {
  receiptCode: 'AB-000007',
  totalFinal: '7800000',
  totalPaid: '0',
  debtAmount: '7800000',
  lines: [
    {
      itemName: 'Coca-Cola <1,5 l>',
      qty: '6000',
      unit: 'dona',
      unitPriceSnapshot: '1400000',
      promoDiscount: '600000',
      allocatedOrderDiscount: '0',
      finalTotal: '7800000',
    },
  ],
} as unknown as SaleDto;

describe('C22 receipt documents', () => {
  it('the A4 note lists goods, totals, debt and both signatures, with names escaped', () => {
    const html = nakladnoyHtml({
      sale,
      shopTitle: 'Polat & Co',
      customerName: 'Aliyev Bobur',
      dateText: '2026-11-27 13:00',
      unitLabel: () => 'dona',
      labels,
    });
    expect(html).toContain('size: A4');
    expect(html).toContain('Coca-Cola &lt;1,5 l&gt;');
    expect(html).toContain('Polat &amp; Co');
    expect(html).toContain('Aliyev Bobur');
    expect(html).toContain('78 000');
    expect(html).toContain('6 000'); // the discount column
    expect(html).toContain('Qarzga');
    expect(html).toContain('Topshirdi');
    expect(html).toContain('Qabul qildi');
  });

  it('without a buyer there is a blank line to write the name; no debt row when paid', () => {
    const html = nakladnoyHtml({
      sale: { ...sale, debtAmount: '0', totalPaid: '7800000' },
      shopTitle: 'Polat',
      customerName: null,
      dateText: 'x',
      unitLabel: () => 'dona',
      labels,
    });
    expect(html).toContain('____');
    expect(html).not.toContain('Qarzga');
  });

  it('the office print page keeps the receipt text verbatim', () => {
    const html = receiptPrintHtml('Chek', "JAMI TO'LOV: 14 000 <so'm>");
    expect(html).toContain("JAMI TO'LOV: 14 000 &lt;so'm&gt;");
    expect(html).toContain('72mm');
  });
});
