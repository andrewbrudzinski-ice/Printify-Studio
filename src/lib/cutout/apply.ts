// Fuse a refined cutout mask onto the photo's pixels: the output is the same
// RGBA image with the mask as its alpha channel. Pure and dimension-checked —
// a mask applied to the wrong image would silently produce a cutout of
// nothing in particular, and that ships.

import type { RefinedCutout } from './types';

export function applyCutoutAlpha(
  image: { data: Uint8ClampedArray; width: number; height: number },
  cutout: RefinedCutout,
): Uint8ClampedArray {
  if (image.width !== cutout.width || image.height !== cutout.height) {
    throw new Error(
      `Cutout mask is ${cutout.width}x${cutout.height} but the photo is ` +
        `${image.width}x${image.height} — they must be the same pixels.`,
    );
  }
  if (image.data.length !== cutout.alpha.length * 4) {
    throw new Error('Photo data length does not match its stated dimensions.');
  }

  const out = new Uint8ClampedArray(image.data);
  for (let i = 0; i < cutout.alpha.length; i++) {
    // Combine with the photo's own alpha (usually 255) rather than replacing
    // it: a photo that already had transparency keeps it.
    out[i * 4 + 3] = (out[i * 4 + 3]! * cutout.alpha[i]!) / 255;
  }
  return out;
}
