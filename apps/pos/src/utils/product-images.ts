import { useEffect, useState } from 'react';
import type { HubApiClient } from '../api/hub-client.js';

/** C21: largest photo the hub accepts (decoded bytes). */
export const MAX_PHOTO_BYTES = 150_000;
/** Longest side of an uploaded photo; tiles are small, so 480 px is plenty. */
export const PHOTO_MAX_SIDE = 480;

/** Session cache: product id -> { stamp, data URL }. Survives screen changes, not reloads. */
const cache = new Map<string, { readonly stamp: string; readonly url: string }>();

/** Forget one product's photo (after the owner changes or removes it). */
export function forgetProductImage(productId: string): void {
  cache.delete(productId);
}

/** Target size for a photo: the longest side at most `maxSide`, aspect kept, never upscaled. */
export function fitWithin(
  width: number,
  height: number,
  maxSide: number,
): { readonly width: number; readonly height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Decoded byte length of a base64 string (without decoding it). */
export function base64ByteLength(b64: string): number {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

/**
 * Turns a picked or camera photo into a small JPEG for the hub: scaled to 480 px, quality lowered
 * step by step until it fits 150 KB.
 */
export async function preparePhoto(
  file: Blob,
): Promise<{ readonly mime: 'image/jpeg'; readonly dataBase64: string; readonly dataUrl: string }> {
  const bitmap = await createImageBitmap(file);
  const size = fitWithin(bitmap.width, bitmap.height, PHOTO_MAX_SIDE);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('Canvas is not available');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size.width, size.height);
  ctx.drawImage(bitmap, 0, 0, size.width, size.height);
  bitmap.close();
  for (const quality of [0.85, 0.75, 0.65, 0.55, 0.45]) {
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    const dataBase64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    if (base64ByteLength(dataBase64) <= MAX_PHOTO_BYTES) {
      return { mime: 'image/jpeg', dataBase64, dataUrl };
    }
  }
  throw new Error('PHOTO_TOO_LARGE');
}

/**
 * Photos of the given products as data URLs (missing = no photo). Asks the hub which products have
 * a photo and fetches only new or changed ones.
 */
export function useProductImages(
  api: HubApiClient,
  productIds: readonly string[],
  refreshKey = 0,
): ReadonlyMap<string, string> {
  const key = productIds.join(',');
  const [urls, setUrls] = useState<ReadonlyMap<string, string>>(new Map());

  useEffect(() => {
    if (key.length === 0) {
      setUrls(new Map());
      return;
    }
    let alive = true;
    const ids = key.split(',');
    void (async () => {
      try {
        const { images } = await api.listImageStamps(ids);
        const out = new Map<string, string>();
        const missing: { readonly productId: string; readonly stamp: string }[] = [];
        for (const img of images) {
          const hit = cache.get(img.productId);
          if (hit !== undefined && hit.stamp === img.updatedAtMs) out.set(img.productId, hit.url);
          else missing.push({ productId: img.productId, stamp: img.updatedAtMs });
        }
        if (alive) setUrls(new Map(out));
        for (const m of missing) {
          if (!alive) return;
          try {
            const data = await api.getProductImageData(m.productId);
            const url = `data:${data.mime};base64,${data.dataBase64}`;
            cache.set(m.productId, { stamp: data.updatedAtMs, url });
            out.set(m.productId, url);
            if (alive) setUrls(new Map(out));
          } catch {
            // a photo that cannot be read just stays a letter tile
          }
        }
      } catch {
        // offline or old hub: letter tiles
      }
    })();
    return () => {
      alive = false;
    };
  }, [api, key, refreshKey]);

  return urls;
}
