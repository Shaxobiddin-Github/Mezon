/**
 * C19: helpers for the phone's continuous camera scan.
 *
 * The camera reports the same code on every frame while it stays in view, so a code counts once
 * per "appearance": it is accepted again only after it was out of view for `holdMs`. Holding a
 * code in front of the camera never adds it twice; taking it away and showing it again does.
 */
export function createScanGate(holdMs = 1200): (code: string, nowMs: number) => boolean {
  const lastSeen = new Map<string, number>();
  return (code, nowMs) => {
    const seen = lastSeen.get(code);
    lastSeen.set(code, nowMs);
    for (const [other, at] of lastSeen) {
      if (nowMs - at > holdMs * 10) lastSeen.delete(other);
    }
    return seen === undefined || nowMs - seen > holdMs;
  };
}

/** What one scan did: shown in the phone's scan panel. */
export type ScanResult =
  | { readonly ok: true; readonly name: string }
  | {
      readonly ok: false;
      readonly code: string;
      /** The code is not in the catalog (it can be linked to a product). */
      readonly notFound: boolean;
      readonly message: string;
    };

interface QtyLine {
  readonly id: string;
  readonly qty: string;
}

/** The cart line a scan added or increased: a new line id, or one whose quantity changed. */
export function findTouchedLine<L extends QtyLine>(
  before: readonly QtyLine[],
  after: readonly L[],
): L | null {
  const prevQty = new Map(before.map((l) => [l.id, l.qty]));
  for (const line of after) {
    const qty = prevQty.get(line.id);
    if (qty === undefined || qty !== line.qty) return line;
  }
  return null;
}
