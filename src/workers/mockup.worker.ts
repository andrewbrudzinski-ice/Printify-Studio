// The mockup render worker. Receives the customer's photo once, then renders
// products one message at a time so the grid streams in — the first tile
// appears without waiting for the eleventh.
//
// This file runs the exact same renderMockup() as the print pipeline; the
// only browser-specific parts are OffscreenCanvas and createImageBitmap,
// injected via browserEnv. Keep it that way — logic added here instead of
// the renderer would fork the render path.

import { renderMockup } from '../lib/mockup/renderer';
import { createBrowserEnv } from '../lib/mockup/browserEnv';
import { fallbackLayers } from '../lib/studio/grid';
import type { DesignSpec, MockupLayer, RenderEnv, SourceImage } from '../lib/mockup/types';

export interface InitMessage {
  type: 'init';
  photo: ArrayBuffer;
  mime: string;
  assetBaseUrl: string | null;
}

export interface RenderMessage {
  type: 'render';
  slug: string;
  layers: MockupLayer[];
  spec: DesignSpec;
  size: number;
}

export type WorkerRequest = InitMessage | RenderMessage;

export interface TileResult {
  type: 'tile';
  slug: string;
  bitmap: ImageBitmap;
  // True when template art was missing and the artwork-only fallback rendered
  // instead — the "grey rectangle" mode.
  degraded: boolean;
}

export interface TileError {
  type: 'error';
  slug: string;
  message: string;
}

const scope = globalThis as unknown as {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(msg: TileResult | TileError, transfer?: Transferable[]): void;
};

let env: RenderEnv | null = null;
let artwork: SourceImage | null = null;

scope.onmessage = async (e) => {
  const msg = e.data;

  if (msg.type === 'init') {
    env = createBrowserEnv(msg.assetBaseUrl);
    const bitmap = await createImageBitmap(new Blob([msg.photo], { type: msg.mime }));
    artwork = bitmap as unknown as SourceImage;
    return;
  }

  if (msg.type === 'render') {
    if (!env || !artwork) {
      scope.postMessage({ type: 'error', slug: msg.slug, message: 'Worker not initialised.' });
      return;
    }
    try {
      let degraded = false;
      let result;
      try {
        result = await renderMockup({
          env,
          layers: msg.layers,
          artwork,
          spec: msg.spec,
          width: msg.size,
          height: msg.size,
        });
      } catch {
        // Template art missing (or unreachable): render the artwork geometry
        // alone. The tile shows the photo in the product's print area over a
        // neutral background — engine working, art absent.
        degraded = true;
        result = await renderMockup({
          env,
          layers: fallbackLayers(msg.layers),
          artwork,
          spec: msg.spec,
          width: msg.size,
          height: msg.size,
        });
      }
      const bitmap = (result.canvas as unknown as OffscreenCanvas).transferToImageBitmap();
      scope.postMessage({ type: 'tile', slug: msg.slug, bitmap, degraded }, [bitmap]);
    } catch (err) {
      scope.postMessage({
        type: 'error',
        slug: msg.slug,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
};
