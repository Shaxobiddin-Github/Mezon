export function formatTiyin(tiyinStr: string | null | undefined): string {
  if (!tiyinStr) return '0 soʻm';
  try {
    const tiyin = BigInt(tiyinStr);
    const som = tiyin / 100n;
    const remainder = tiyin % 100n;
    const absRemainder = remainder < 0n ? -remainder : remainder;

    const parts = som.toLocaleString('uz-UZ');
    if (absRemainder === 0n) {
      return `${parts} soʻm`;
    }
    return `${parts}.${absRemainder.toString().padStart(2, '0')} soʻm`;
  } catch {
    return `${tiyinStr} soʻm`;
  }
}

export function formatDateTime(msStr: string | null | undefined): string {
  if (!msStr) return '—';
  try {
    const d = new Date(Number(msStr));
    return d.toLocaleString('uz-UZ', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return msStr;
  }
}
