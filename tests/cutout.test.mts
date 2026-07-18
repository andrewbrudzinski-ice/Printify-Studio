// Mask refinement against real synthetic masks. Raw model alpha is never
// print-ready; each stage here exists because of a specific physical failure
// (grey film, vinyl islands, serrated die-cut edge) and each is pinned to
// exact pixels.
import assert from 'node:assert/strict';
import {
  assertCutoutQuality,
  bboxOf,
  coverage,
  featherEdges,
  refineMask,
  removeHaze,
  removeIslands,
} from '../src/lib/cutout/refine';
import { CutoutQualityError, isCutoutQualityError } from '../src/lib/cutout/types';

let count = 0;
function check(label: string, fn: () => void): void {
  fn();
  count += 1;
  console.log(`  ok  ${label}`);
}

// --- Mask builders -----------------------------------------------------------------

function mask(width: number, height: number, fill = 0): { alpha: Float32Array; width: number; height: number } {
  return { alpha: new Float32Array(width * height).fill(fill), width, height };
}

function paintRect(
  m: { alpha: Float32Array; width: number },
  x0: number,
  y0: number,
  w: number,
  h: number,
  value: number,
): void {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      m.alpha[y * m.width + x] = value;
    }
  }
}

const at = (m: { alpha: Float32Array; width: number }, x: number, y: number) =>
  m.alpha[y * m.width + x]!;

// --- Haze --------------------------------------------------------------------------

check('haze: low-alpha background noise becomes exactly 0 — ink or no ink', () => {
  const m = mask(50, 50);
  for (let i = 0; i < m.alpha.length; i++) m.alpha[i] = 0.05 + (i % 5) * 0.02; // 0.05..0.13
  paintRect(m, 10, 10, 20, 20, 0.9);
  const out = removeHaze(m.alpha);
  assert.equal(out[0], 0, 'haze pixel zeroed');
  assert.equal(out[49 * 50 + 49], 0, 'far corner zeroed');
  assert.equal(out[15 * 50 + 15], Math.fround(0.9), 'subject untouched');
});

check('haze: the threshold is a floor, not a rescale', () => {
  const m = mask(4, 1);
  m.alpha.set([0.14, 0.15, 0.2, 1.0]);
  const out = removeHaze(m.alpha, 0.15);
  assert.equal(out[0], 0, 'below threshold drops');
  assert.ok(Math.abs(out[1]! - 0.15) < 1e-6, 'at threshold survives unchanged');
  assert.ok(Math.abs(out[2]! - 0.2) < 1e-6);
  assert.equal(out[3], 1.0);
});

check('haze: pure, input untouched', () => {
  const m = mask(10, 10, 0.1);
  const before = m.alpha.slice();
  removeHaze(m.alpha);
  assert.deepEqual(m.alpha, before);
});

// --- Islands -----------------------------------------------------------------------

check('islands: speckles vanish, the subject survives', () => {
  const m = mask(100, 100);
  paintRect(m, 20, 20, 40, 40, 1); // the subject: 1600 px
  paintRect(m, 80, 10, 2, 2, 1); // speckle
  paintRect(m, 5, 90, 3, 3, 1); // speckle
  paintRect(m, 90, 90, 1, 1, 1); // single-pixel speckle
  const out = removeIslands(m.alpha, 100, 100);
  assert.equal(out[11 * 100 + 81], 0, 'speckle 1 removed');
  assert.equal(out[91 * 100 + 6], 0, 'speckle 2 removed');
  assert.equal(out[90 * 100 + 90], 0, 'speckle 3 removed');
  assert.equal(out[30 * 100 + 30], 1, 'subject intact');
});

check('islands: a second REAL component above the keep fraction survives', () => {
  const m = mask(100, 100);
  paintRect(m, 10, 10, 40, 40, 1); // 1600 px
  paintRect(m, 60, 60, 30, 30, 1); // 900 px = 56% of largest — a real subject
  const out = removeIslands(m.alpha, 100, 100);
  assert.equal(out[70 * 100 + 70], 1, 'second subject survives');
});

check('islands: 4-connectivity — a diagonal-only touch is a separate component', () => {
  const m = mask(50, 50);
  paintRect(m, 10, 10, 20, 20, 1); // subject
  // A 2x2 blob touching the subject ONLY at the corner (30,30)-(29,29).
  paintRect(m, 30, 30, 2, 2, 1);
  const out = removeIslands(m.alpha, 50, 50);
  assert.equal(out[30 * 50 + 30], 0, 'diagonal blob is its own (tiny) island — removed');
  assert.equal(out[29 * 50 + 29], 1, 'subject corner intact');
});

check('islands: a 1.44M-pixel full-frame component does not blow the stack', () => {
  const m = mask(1200, 1200, 1); // one giant component, worst case for recursion
  const started = Date.now();
  const out = removeIslands(m.alpha, 1200, 1200);
  const ms = Date.now() - started;
  assert.equal(out[0], 1);
  assert.equal(out[1199 * 1200 + 1199], 1);
  console.log(`      (1.44M-pixel flood fill in ${ms}ms)`);
});

check('islands: thousands of components do not blow the largest-size scan', () => {
  // The Math.max(...sizes) failure mode: many components = many call args.
  const m = mask(400, 400);
  for (let y = 0; y < 400; y += 2) {
    for (let x = 0; x < 400; x += 2) {
      m.alpha[y * 400 + x] = 1; // 40,000 isolated single-pixel components
    }
  }
  paintRect(m, 100, 100, 50, 50, 1);
  const out = removeIslands(m.alpha, 400, 400);
  assert.equal(out[120 * 400 + 120], 1, 'the blob survives');
  assert.equal(out[0], 0, 'speckle grid removed');
});

check('islands: mismatched dimensions throw instead of reading garbage', () => {
  assert.throws(() => removeIslands(new Float32Array(10), 100, 100), /does not match/);
});

// --- Feathering ----------------------------------------------------------------------

check('feathering: a hard edge gains intermediate alpha; interior and far field are stable', () => {
  const m = mask(60, 60);
  paintRect(m, 20, 20, 20, 20, 1);
  const out = featherEdges(m.alpha, 60, 60, 1);
  const edge = out[30 * 60 + 19]!; // just outside the old hard edge
  assert.ok(edge > 0 && edge < 1, `edge pixel should be partial, got ${edge}`);
  assert.ok(out[30 * 60 + 30]! > 0.99, 'deep interior stays solid');
  assert.equal(out[5 * 60 + 5], 0, 'far background untouched');
});

check('feathering: energy is preserved, not eroded (box blur, not shrink)', () => {
  const m = mask(60, 60);
  paintRect(m, 20, 20, 20, 20, 1);
  const before = m.alpha.reduce((a, b) => a + b, 0);
  const out = featherEdges(m.alpha, 60, 60, 1);
  const after = out.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(before - after) / before < 0.02, 'total alpha within 2%');
});

check('feathering: radius 0 is an exact no-op copy', () => {
  const m = mask(20, 20);
  paintRect(m, 5, 5, 8, 8, 0.8);
  const out = featherEdges(m.alpha, 20, 20, 0);
  assert.deepEqual(out, m.alpha);
  assert.notEqual(out, m.alpha, 'still a copy, not the same array');
});

// --- bbox & coverage --------------------------------------------------------------------

check('bbox is exact for a known rectangle', () => {
  const m = mask(100, 80);
  paintRect(m, 12, 30, 25, 14, 1);
  assert.deepEqual(bboxOf(m.alpha, 100, 80), { x: 12, y: 30, w: 25, h: 14 });
});

check('bbox of an empty mask is null, not a zero-size lie', () => {
  const m = mask(50, 50);
  assert.equal(bboxOf(m.alpha, 50, 50), null);
});

check('coverage counts kept pixels only', () => {
  const m = mask(10, 10);
  paintRect(m, 0, 0, 5, 10, 1); // half kept
  paintRect(m, 5, 0, 5, 10, 0.3); // below KEEP — not counted
  assert.equal(coverage(m.alpha), 0.5);
});

// --- The quality gate ----------------------------------------------------------------------

check('gate: found-nothing rejects with advice, not internals', () => {
  try {
    assertCutoutQuality(0.001);
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(isCutoutQualityError(e));
    assert.match((e as Error).message, /more contrast/);
  }
});

check('gate: kept-everything rejects — that would print a rectangle', () => {
  try {
    assertCutoutQuality(0.995);
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(isCutoutQualityError(e));
    assert.match((e as Error).message, /rectangle/);
  }
});

check('gate: a normal subject passes', () => {
  assertCutoutQuality(0.3); // no throw
});

check('the quality error is detected by name, never instanceof', () => {
  assert.equal(isCutoutQualityError(new CutoutQualityError('x')), true);
  const foreign = Object.assign(new Error('x'), { name: 'CutoutQualityError' });
  assert.equal(isCutoutQualityError(foreign), true, 'cross-module instance still detected');
  assert.equal(isCutoutQualityError(new Error('x')), false);
  assert.equal(isCutoutQualityError(null), false);
});

// --- End to end -------------------------------------------------------------------------------

check('refineMask: a hazy, speckled subject comes out clean, boxed, and byte-ready', () => {
  const m = mask(200, 200);
  for (let i = 0; i < m.alpha.length; i++) m.alpha[i] = 0.08; // haze everywhere
  paintRect(m, 50, 60, 80, 90, 0.95); // the subject
  paintRect(m, 180, 10, 2, 2, 0.9); // speckle
  paintRect(m, 5, 180, 3, 2, 0.85); // speckle

  const result = refineMask(m);

  assert.ok(result.alpha instanceof Uint8ClampedArray);
  assert.equal(result.alpha[10 * 200 + 181], 0, 'speckle gone in the output bytes');
  assert.equal(result.alpha[0], 0, 'haze gone');
  assert.ok(result.alpha[100 * 200 + 90]! > 240, 'subject solid');
  // Feathering can spread the bbox by the blur radius, no more.
  assert.ok(Math.abs(result.bbox.x - 50) <= 1 && Math.abs(result.bbox.y - 60) <= 1, 'bbox tracks the subject');
  assert.ok(Math.abs(result.bbox.w - 80) <= 2 && Math.abs(result.bbox.h - 90) <= 2);
  assert.ok(result.coverage > 0.15 && result.coverage < 0.25, `coverage ${result.coverage}`);
});

check('refineMask: pure haze refines to "found nothing", thrown as the quality error', () => {
  const m = mask(100, 100, 0.1);
  try {
    refineMask(m);
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(isCutoutQualityError(e));
    assert.match((e as Error).message, /more contrast/);
  }
});

check('refineMask: an all-foreground mask is rejected as a would-be rectangle', () => {
  const m = mask(100, 100, 0.95);
  assert.throws(() => refineMask(m), (e: unknown) => isCutoutQualityError(e));
});

// --- Fusing the mask onto the photo -------------------------------------------

check('applyCutoutAlpha: mask becomes the alpha channel, colours untouched', async () => {
  const { applyCutoutAlpha } = await import('../src/lib/cutout/apply');
  const w = 4;
  const h = 1;
  const image = { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  for (let i = 0; i < w; i++) {
    image.data.set([10 * (i + 1), 20, 30, 255], i * 4);
  }
  const cut = {
    alpha: new Uint8ClampedArray([255, 128, 0, 255]),
    width: w,
    height: h,
    bbox: { x: 0, y: 0, w, h },
    coverage: 0.75,
  };
  const out = applyCutoutAlpha(image, cut);
  assert.deepEqual([...out.slice(0, 4)], [10, 20, 30, 255], 'kept pixel');
  assert.equal(out[7], 128, 'partial edge alpha carried through');
  assert.equal(out[11], 0, 'dropped pixel fully transparent');
  assert.equal(out[4], 20, 'colour channels untouched');
  assert.equal(image.data[11], 255, 'input not mutated');
});

check('applyCutoutAlpha: combines with existing photo alpha instead of replacing it', async () => {
  const { applyCutoutAlpha } = await import('../src/lib/cutout/apply');
  const image = { data: new Uint8ClampedArray([0, 0, 0, 128]), width: 1, height: 1 };
  const cut = {
    alpha: new Uint8ClampedArray([255]),
    width: 1,
    height: 1,
    bbox: { x: 0, y: 0, w: 1, h: 1 },
    coverage: 1,
  };
  const out = applyCutoutAlpha(image, cut);
  assert.equal(out[3], 128, 'a half-transparent source pixel stays half-transparent');
});

check('applyCutoutAlpha: dimension mismatch throws — never a cutout of the wrong pixels', async () => {
  const { applyCutoutAlpha } = await import('../src/lib/cutout/apply');
  const image = { data: new Uint8ClampedArray(16), width: 2, height: 2 };
  const cut = {
    alpha: new Uint8ClampedArray(9),
    width: 3,
    height: 3,
    bbox: { x: 0, y: 0, w: 3, h: 3 },
    coverage: 1,
  };
  assert.throws(() => applyCutoutAlpha(image, cut), /same pixels/);
});

console.log(`\n${count} checks passed against real synthetic masks.`);
