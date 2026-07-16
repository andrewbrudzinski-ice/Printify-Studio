// RenderEnv for the browser (worker or main thread): OffscreenCanvas +
// a cached fetch-based asset loader against the public templates bucket.
//
// The loader THROWS on a missing/broken asset — never resolves with a
// placeholder. A layer that silently fails to load ships a product without
// that layer (the vanishing-stickers bug); a throw is caught by the caller,
// which can choose an explicit fallback (see the grid's grey-base path).

import type { RenderCanvas, RenderEnv, SourceImage } from './types';

export function createBrowserEnv(assetBaseUrl: string | null): RenderEnv {
  // Cache the PROMISE, not the bitmap: concurrent renders of 11 products
  // share one in-flight fetch per asset instead of racing 11.
  const cache = new Map<string, Promise<SourceImage>>();

  return {
    createCanvas(w, h) {
      return new OffscreenCanvas(Math.max(1, w), Math.max(1, h)) as unknown as RenderCanvas;
    },

    loadAsset(src) {
      let hit = cache.get(src);
      if (!hit) {
        hit = fetchAsset(assetBaseUrl, src);
        cache.set(src, hit);
        // A failed fetch must not poison the cache forever — a retry after a
        // flaky network should refetch.
        hit.catch(() => cache.delete(src));
      }
      return hit;
    },
  };
}

async function fetchAsset(base: string | null, src: string): Promise<SourceImage> {
  if (!base) {
    throw new Error(`asset failed to load: no asset base URL configured (${src})`);
  }
  const res = await fetch(`${base.replace(/\/$/, '')}/${src}`);
  if (!res.ok) {
    throw new Error(`asset failed to load: HTTP ${res.status} for ${src}`);
  }
  const bitmap = await createImageBitmap(await res.blob());
  return bitmap as unknown as SourceImage;
}

// Public-bucket base URL for template art, derived from the Supabase URL the
// client already has. Null when Supabase isn't configured — the grid then
// renders its grey-base fallback everywhere, which is the correct zero-env demo.
export function templateAssetBaseUrl(): string | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  return url ? `${url}/storage/v1/object/public/templates` : null;
}
