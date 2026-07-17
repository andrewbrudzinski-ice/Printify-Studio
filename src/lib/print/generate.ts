// Print file generation. The print file IS the preview: this calls the exact
// prepareArtwork() the editor and the mockup grid call, at print resolution,
// rather than reimplementing transforms at print scale. A second
// implementation would drift, and the drift would only be discovered on a
// manufactured product.

import { prepareArtwork } from '../mockup/renderer';
import type { DesignSpec, RenderCanvas, RenderEnv, SourceImage } from '../mockup/types';
import { assertPrintable, canvasSizePx, bledSizeIn, type PrintGeometry } from './geometry';

export interface PrintRenderOptions {
  // Preferred output resolution. 300 is the industry default for photo print.
  targetDpi?: number;
  // Hard pixel budget. A 16x20 canvas print with 1.25in bleed at 300 DPI is
  // 37.5MP — past what a serverless render budget tolerates. When the target
  // overflows the budget, the DPI drops to fit; detail above ~240 DPI is not
  // visible on canvas media, and a bounded render can't OOM the webhook.
  maxPixels?: number;
}

const DEFAULT_TARGET_DPI = 300;
const DEFAULT_MAX_PIXELS = 24_000_000;

export function printPixelSize(
  g: PrintGeometry,
  opts: PrintRenderOptions = {},
): { w: number; h: number; dpi: number } {
  const target = opts.targetDpi ?? DEFAULT_TARGET_DPI;
  const budget = opts.maxPixels ?? DEFAULT_MAX_PIXELS;
  const b = bledSizeIn(g);
  const budgetDpi = Math.floor(Math.sqrt(budget / (b.w * b.h)));
  const dpi = Math.min(target, budgetDpi);
  const { w, h } = canvasSizePx(g, dpi);
  return { w, h, dpi };
}

// Format is chosen per product, from data. JPEG q95 encodes a 22.6MP photo
// print in ~0.7s at ~11MB; PNG takes ~8s and ~28MB — unacceptable inside a
// webhook. But JPEG has no alpha, and a die-cut product without transparency
// is a rectangle. config.requiresCutout decides, so a new die-cut product
// gets the right format with no code change.
export function printFormatFor(config: { requiresCutout?: boolean }): 'png' | 'jpeg' {
  return config.requiresCutout ? 'png' : 'jpeg';
}

export interface PrintFileRender {
  canvas: RenderCanvas;
  widthPx: number;
  heightPx: number;
  dpi: number;
}

// Render the artwork for one order item at print scale. Throws
// PrintQualityError BEFORE rendering when the source can't meet the
// product's DPI floor — the caller holds the order instead of printing blur.
export function generatePrintFile(
  env: RenderEnv,
  artwork: SourceImage,
  spec: DesignSpec,
  g: PrintGeometry,
  opts: PrintRenderOptions = {},
): PrintFileRender {
  assertPrintable(artwork.width, artwork.height, g, spec.transform.scale);
  const { w, h, dpi } = printPixelSize(g, opts);
  const canvas = prepareArtwork(env, artwork, spec, w, h);
  return { canvas, widthPx: w, heightPx: h, dpi };
}
