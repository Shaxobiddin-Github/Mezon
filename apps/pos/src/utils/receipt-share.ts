import type { SaleDto } from '@mezon/contracts';
import { formatMilliToQtyString, formatTiyinToSom } from '@mezon/ui';

/**
 * C22: share and office-print a receipt. The text comes from the hub (the same layout the receipt
 * printer gets); here it becomes a picture (to send in Telegram) or a print page (any printer the
 * computer knows, Wi-Fi or USB). The A4 "nakladnoy" is built from the sale itself.
 */

/** Characters per row on the shared picture: 80 mm paper. */
export const RECEIPT_COLS = 48;

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Draws the receipt text on a white canvas (monospace, like paper) and returns a PNG data URL. */
export function receiptTextToPng(text: string, opts: { readonly scale?: number } = {}): string {
  const scale = opts.scale ?? 2;
  // the printer draws the QR itself; on a picture the placeholder row is dropped
  const lines = text
    .replace(/\r/g, '')
    .split('\n')
    .filter((l) => l.trim() !== '[QR]');
  const fontPx = 15;
  const lineH = 20;
  const pad = 24;
  const canvas = document.createElement('canvas');
  const ctx0 = canvas.getContext('2d');
  if (ctx0 === null) throw new Error('Canvas is not available');
  ctx0.font = `${String(fontPx)}px "Cascadia Mono", Consolas, "Courier New", monospace`;
  const charW = ctx0.measureText('M').width;
  const cols = Math.max(RECEIPT_COLS, ...lines.map((l) => l.length));
  const width = Math.ceil(cols * charW + pad * 2);
  const height = Math.ceil(lines.length * lineH + pad * 2);
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('Canvas is not available');
  ctx.scale(scale, scale);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#111827';
  ctx.font = `${String(fontPx)}px "Cascadia Mono", Consolas, "Courier New", monospace`;
  ctx.textBaseline = 'top';
  lines.forEach((line, i) => {
    ctx.fillText(line, pad, pad + i * lineH);
  });
  return canvas.toDataURL('image/png');
}

/** An HTML page that prints the receipt text on 80 mm paper (or centred on A4). */
export function receiptPrintHtml(title: string, text: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
@page { margin: 6mm; }
body { margin: 0; font: 12px/1.35 "Cascadia Mono", Consolas, "Courier New", monospace; color: #000; }
pre { margin: 0 auto; width: 72mm; white-space: pre-wrap; }
</style></head><body><pre>${escapeHtml(text)}</pre></body></html>`;
}

export interface NakladnoyInput {
  readonly sale: SaleDto;
  readonly shopTitle: string;
  readonly customerName: string | null;
  readonly dateText: string;
  readonly unitLabel: (unit: string) => string;
  readonly labels: {
    readonly title: string;
    readonly receipt: string;
    readonly date: string;
    readonly seller: string;
    readonly buyer: string;
    readonly no: string;
    readonly item: string;
    readonly qty: string;
    readonly price: string;
    readonly discount: string;
    readonly sum: string;
    readonly total: string;
    readonly paid: string;
    readonly debt: string;
    readonly handedOver: string;
    readonly received: string;
    readonly currency: string;
  };
}

/** A4 delivery note ("nakladnoy") for the buyer: goods, quantities, prices and two signatures. */
export function nakladnoyHtml(input: NakladnoyInput): string {
  const { sale, labels: L } = input;
  const som = (tiyin: string) => formatTiyinToSom(tiyin);
  const rows = sale.lines
    .map((l, i) => {
      const discount = BigInt(l.promoDiscount) + BigInt(l.allocatedOrderDiscount);
      return `<tr><td class="n">${String(i + 1)}</td><td>${escapeHtml(l.itemName)}</td>
<td class="r">${escapeHtml(formatMilliToQtyString(l.qty))} ${escapeHtml(input.unitLabel(l.unit))}</td>
<td class="r">${som(l.unitPriceSnapshot)}</td>
<td class="r">${discount > 0n ? som(discount.toString()) : '—'}</td>
<td class="r b">${som(l.finalTotal)}</td></tr>`;
    })
    .join('\n');
  const debt = BigInt(sale.debtAmount) > 0n;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(L.title)} ${escapeHtml(sale.receiptCode)}</title>
<style>
@page { size: A4; margin: 14mm; }
body { margin: 0; font: 12.5px/1.45 Inter, "Segoe UI", Arial, sans-serif; color: #111; }
h1 { font-size: 20px; margin: 0 0 4px; }
.meta { display: flex; justify-content: space-between; gap: 16px; margin: 10px 0 14px; }
.meta div { line-height: 1.6; }
table { width: 100%; border-collapse: collapse; }
th, td { border: 1px solid #9ca3af; padding: 6px 8px; vertical-align: top; }
th { background: #f3f4f6; text-align: left; font-weight: 600; }
.n { width: 28px; text-align: center; }
.r { text-align: right; white-space: nowrap; }
.b { font-weight: 700; }
.tot { margin-top: 10px; margin-left: auto; width: 46%; }
.tot td { border: none; padding: 3px 0; }
.sign { display: flex; justify-content: space-between; margin-top: 48px; gap: 40px; }
.sign div { flex: 1; border-top: 1px solid #111; padding-top: 6px; }
</style></head><body>
<h1>${escapeHtml(L.title)}</h1>
<div class="meta">
<div><b>${escapeHtml(L.seller)}:</b> ${escapeHtml(input.shopTitle)}<br>
<b>${escapeHtml(L.buyer)}:</b> ${input.customerName !== null ? escapeHtml(input.customerName) : '____________________'}</div>
<div class="r"><b>${escapeHtml(L.receipt)}:</b> ${escapeHtml(sale.receiptCode)}<br>
<b>${escapeHtml(L.date)}:</b> ${escapeHtml(input.dateText)}</div>
</div>
<table><thead><tr><th class="n">${escapeHtml(L.no)}</th><th>${escapeHtml(L.item)}</th><th class="r">${escapeHtml(L.qty)}</th>
<th class="r">${escapeHtml(L.price)}</th><th class="r">${escapeHtml(L.discount)}</th><th class="r">${escapeHtml(L.sum)}</th></tr></thead>
<tbody>${rows}</tbody></table>
<table class="tot">
<tr><td>${escapeHtml(L.total)}</td><td class="r b">${som(sale.totalFinal)} ${escapeHtml(L.currency)}</td></tr>
<tr><td>${escapeHtml(L.paid)}</td><td class="r">${som(sale.totalPaid)} ${escapeHtml(L.currency)}</td></tr>
${debt ? `<tr><td>${escapeHtml(L.debt)}</td><td class="r b">${som(sale.debtAmount)} ${escapeHtml(L.currency)}</td></tr>` : ''}
</table>
<div class="sign"><div>${escapeHtml(L.handedOver)}</div><div>${escapeHtml(L.received)}</div></div>
</body></html>`;
}

/** Prints an HTML page through the computer's own print dialog (a hidden frame). */
export function printHtml(html: string): void {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.position = 'fixed';
  frame.style.width = '0';
  frame.style.height = '0';
  frame.style.border = '0';
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  if (doc === null || win === null) {
    frame.remove();
    throw new Error('Print frame is not available');
  }
  doc.open();
  doc.write(html);
  doc.close();
  const done = () => setTimeout(() => frame.remove(), 1000);
  win.addEventListener('afterprint', done, { once: true });
  setTimeout(() => {
    win.focus();
    win.print();
    done();
  }, 150);
}

/**
 * Shares a PNG: the phone's share sheet (Telegram, WhatsApp…) through the app bridge, the browser
 * share sheet when it can share files, otherwise a download of the file.
 */
export async function sharePng(dataUrl: string, fileName: string, title: string): Promise<void> {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bridgeShare = window.mezonBridge?.shareImage;
  if (bridgeShare !== undefined) {
    await bridgeShare({ base64, fileName, title });
    return;
  }
  const blob = await (await fetch(dataUrl)).blob();
  const file = new File([blob], fileName, { type: 'image/png' });
  if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
    await navigator.share({ files: [file], title });
    return;
  }
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
