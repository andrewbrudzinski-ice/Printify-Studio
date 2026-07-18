// The client-side cutout flow, end to end: decode the photo, run the model
// provider, refine the raw mask (haze/islands/feather/quality gate), fuse the
// alpha onto the pixels, and produce a PNG the rest of the funnel treats as
// just another image.
//
// Browser-only (canvas + createImageBitmap). The model call inside the
// provider is the one UNVERIFIED link (see ormbg.ts); everything after it is
// the tested refinement pipeline.

import type { CutoutProvider } from './types';
import { refineMask } from './refine';
import { applyCutoutAlpha } from './apply';

export interface CutoutRun {
  blob: Blob; // PNG with alpha
  width: number;
  height: number;
}

// Photos are downscaled for inference and cutting: segmentation models see
// ~1024px internally anyway, and a full-resolution alpha fuse would spend
// seconds for edge quality the die cutter can't use.
const MAX_CUTOUT_DIMENSION = 2048;

export async function runCutout(provider: CutoutProvider, photo: Blob): Promise<CutoutRun> {
  const bitmap = await createImageBitmap(photo);
  const scale = Math.min(1, MAX_CUTOUT_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable.');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const imageData = ctx.getImageData(0, 0, width, height);

  const raw = await provider.removeBackground({ data: imageData.data, width, height });
  const refined = refineMask(raw); // throws CutoutQualityError with advice
  const cut = applyCutoutAlpha({ data: imageData.data, width, height }, refined);

  // Copy into a fresh (ArrayBuffer-backed) array: ImageData's constructor
  // type rejects potentially-SharedArrayBuffer-backed views.
  ctx.putImageData(new ImageData(new Uint8ClampedArray(cut), width, height), 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return { blob, width, height };
}
