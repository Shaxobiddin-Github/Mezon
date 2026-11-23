/**
 * Kassa screen size (C17). Three steps; the CSS scales the whole kassa for each one
 * (see `[data-ui-size]` in App.css). Saved in this device's browser storage only: a 10" tablet
 * and a 22" touch monitor in one shop need different sizes.
 */
export const UI_SIZES = ['normal', 'large', 'xlarge'] as const;
export type UiSize = (typeof UI_SIZES)[number];

const STORAGE_KEY = 'mezon.pos.uiSize';

export function isUiSize(value: unknown): value is UiSize {
  return typeof value === 'string' && (UI_SIZES as readonly string[]).includes(value);
}

export function nextUiSize(current: UiSize): UiSize {
  const i = UI_SIZES.indexOf(current);
  return UI_SIZES[(i + 1) % UI_SIZES.length] ?? 'normal';
}

export function readUiSize(): UiSize {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return isUiSize(raw) ? raw : 'normal';
  } catch {
    return 'normal';
  }
}

export function writeUiSize(size: UiSize): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, size);
  } catch {
    // Private window or blocked storage: the size simply is not remembered.
  }
}
