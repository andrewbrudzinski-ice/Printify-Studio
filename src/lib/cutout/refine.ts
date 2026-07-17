// Mask refinement — where the print quality actually lives. Raw model alpha
// is never print-ready:
//
//   Haze    — low-alpha noise across the background. Invisible at 30% on a
//             bright screen; a visible grey film on a printed white keychain.
//   Speckle — stray kept pixels become tiny vinyl islands that peel off or
//             jam the die cutter.
//   Jaggies — a die-cutter follows the alpha boundary literally, so a
//             stair-stepped mask becomes a serrated physical edge.
//
// Every function is pure (returns a new array) and operates on Float32Array
// alpha in 0..1. All loops are written longhand: a nested helper closure in
// the flood fill was once allocated per connected component and blocked V8
// from optimising the hottest loop in the pipeline — 1101ms -> 77ms when
// rewritten with an explicit Int32Array stack.

import { CutoutQualityError, type MaskBox, type RawMask, type RefinedCutout } from './types';

// A pixel counts as "kept" above this alpha. Shared by the island pass, the
// gate and the bbox so they can never disagree about what's foreground.
const KEEP = 0.5;

// Zero out low-alpha noise. Alpha below the floor becomes exactly 0 — on a
// printed product there is no "2% visible", only ink or no ink.
export function removeHaze(alpha: Float32Array, threshold = 0.15): Float32Array {
  const out = new Float32Array(alpha.length);
  for (let i = 0; i < alpha.length; i++) {
    const a = alpha[i]!;
    out[i] = a < threshold ? 0 : a;
  }
  return out;
}

// Remove small disconnected islands, keeping every component at least
// `keepFraction` the size of the largest. 4-connectivity: two pixels touching
// only diagonally are separate components — which is also how a die cutter
// sees them.
export function removeIslands(
  alpha: Float32Array,
  width: number,
  height: number,
  keepFraction = 0.05,
): Float32Array {
  const n = width * height;
  if (alpha.length !== n) {
    throw new Error(`Mask length ${alpha.length} does not match ${width}x${height}.`);
  }

  const labels = new Int32Array(n);
  // Explicit stack, pre-sized to the worst case. Recursion here overflows on
  // a large connected region, and it must survive a full-frame component
  // (1.44M pixels) — pinned by test.
  const stack = new Int32Array(n);
  const sizes: number[] = [];
  let nextLabel = 0;

  for (let start = 0; start < n; start++) {
    if (labels[start] !== 0 || alpha[start]! <= KEEP) continue;
    nextLabel++;
    let size = 0;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = nextLabel;

    while (sp > 0) {
      const idx = stack[--sp]!;
      size++;
      const x = idx - Math.floor(idx / width) * width;

      if (x > 0) {
        const j = idx - 1;
        if (labels[j] === 0 && alpha[j]! > KEEP) {
          labels[j] = nextLabel;
          stack[sp++] = j;
        }
      }
      if (x + 1 < width) {
        const j = idx + 1;
        if (labels[j] === 0 && alpha[j]! > KEEP) {
          labels[j] = nextLabel;
          stack[sp++] = j;
        }
      }
      if (idx >= width) {
        const j = idx - width;
        if (labels[j] === 0 && alpha[j]! > KEEP) {
          labels[j] = nextLabel;
          stack[sp++] = j;
        }
      }
      if (idx + width < n) {
        const j = idx + width;
        if (labels[j] === 0 && alpha[j]! > KEEP) {
          labels[j] = nextLabel;
          stack[sp++] = j;
        }
      }
    }
    sizes.push(size);
  }

  // Largest component WITHOUT Math.max(...sizes): the spread pushes every
  // element as a call argument and blows the stack on a speckle-heavy mask.
  let largest = 0;
  for (let i = 0; i < sizes.length; i++) {
    if (sizes[i]! > largest) largest = sizes[i]!;
  }
  const minKeep = Math.max(1, Math.ceil(largest * keepFraction));

  const keepLabel = new Uint8Array(nextLabel + 1);
  for (let i = 0; i < sizes.length; i++) {
    keepLabel[i + 1] = sizes[i]! >= minKeep ? 1 : 0;
  }

  const out = new Float32Array(alpha);
  for (let i = 0; i < n; i++) {
    if (alpha[i]! > KEEP && keepLabel[labels[i]!] === 0) out[i] = 0;
  }
  return out;
}

// Soften the alpha boundary with a separable box blur so the die-cut path is
// smooth instead of stair-stepped. Radius 1 is one blur pixel each side —
// enough to anti-alias a cutter path without visibly shrinking the subject.
export function featherEdges(
  alpha: Float32Array,
  width: number,
  height: number,
  radius = 1,
): Float32Array {
  if (radius < 1) return new Float32Array(alpha);
  const window = radius * 2 + 1;

  // Horizontal pass.
  const horizontal = new Float32Array(alpha.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let x = -radius; x <= radius; x++) {
      sum += alpha[row + Math.min(width - 1, Math.max(0, x))]!;
    }
    for (let x = 0; x < width; x++) {
      horizontal[row + x] = sum / window;
      const exiting = Math.max(0, x - radius);
      const entering = Math.min(width - 1, x + radius + 1);
      sum += alpha[row + entering]! - alpha[row + exiting]!;
    }
  }

  // Vertical pass.
  const out = new Float32Array(alpha.length);
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) {
      sum += horizontal[Math.min(height - 1, Math.max(0, y)) * width + x]!;
    }
    for (let y = 0; y < height; y++) {
      out[y * width + x] = sum / window;
      const exiting = Math.max(0, y - radius);
      const entering = Math.min(height - 1, y + radius + 1);
      sum += horizontal[entering * width + x]! - horizontal[exiting * width + x]!;
    }
  }
  return out;
}

// Fraction of pixels kept.
export function coverage(alpha: Float32Array): number {
  let kept = 0;
  for (let i = 0; i < alpha.length; i++) {
    if (alpha[i]! > KEEP) kept++;
  }
  return alpha.length === 0 ? 0 : kept / alpha.length;
}

// Tight bounding box of kept pixels; null for an empty mask.
export function bboxOf(alpha: Float32Array, width: number, height: number): MaskBox | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (alpha[row + x]! > KEEP) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

// The quality gate. Rejecting is the feature: a bad cutout is worse than no
// cutout. Failures say what to do INSTEAD, not what went wrong internally.
const MIN_COVERAGE = 0.005;
const MAX_COVERAGE = 0.98;

export function assertCutoutQuality(cov: number): void {
  if (cov < MIN_COVERAGE) {
    throw new CutoutQualityError(
      "We couldn't find a subject in this photo. Try one with more contrast between the subject and the background.",
    );
  }
  if (cov > MAX_COVERAGE) {
    throw new CutoutQualityError(
      'The whole photo was kept, which would just print a rectangle. Try a photo where the subject stands out from the background.',
    );
  }
}

// The full pipeline: haze -> islands -> gate -> feather -> bbox. The gate
// runs on the cleaned mask BEFORE feathering (feathering is cosmetic; the
// gate is about content), and a gated failure throws before any bytes are
// produced.
export function refineMask(raw: RawMask): RefinedCutout {
  const { width, height } = raw;
  const dehazed = removeHaze(raw.alpha);
  const solid = removeIslands(dehazed, width, height);

  const cov = coverage(solid);
  assertCutoutQuality(cov);

  const feathered = featherEdges(solid, width, height);
  const bbox = bboxOf(feathered, width, height);
  if (!bbox) {
    // Feathering cannot empty a mask the gate passed; if it somehow did,
    // fail the same user-facing way rather than returning garbage.
    throw new CutoutQualityError(
      "We couldn't find a subject in this photo. Try one with more contrast between the subject and the background.",
    );
  }

  const bytes = new Uint8ClampedArray(feathered.length);
  for (let i = 0; i < feathered.length; i++) {
    bytes[i] = feathered[i]! * 255;
  }
  return { alpha: bytes, width, height, bbox, coverage: cov };
}
