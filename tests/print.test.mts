// Print generation through the REAL renderer at real print sizes. The test
// artwork is photographic-style (gradient + noise), not flat colour: a flat
// fixture once reported a 22.6MP PNG at 0.1MB and nearly set the wrong
// format for half the catalogue. Fixtures that don't resemble production
// data tell you what you want to hear.
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { generatePrintFile, printFormatFor, printPixelSize } from '../src/lib/print/generate';
import { isPrintQualityError, parsePrintGeometry } from '../src/lib/print/geometry';
import { DEFAULT_SPEC } from '../src/lib/mockup/types';
import type { DesignSpec, RenderCanvas, RenderEnv } from '../src/lib/mockup/types';
import { loadCatalogue } from './helpers/catalogue.mts';

let count = 0;
function check(label: string, fn: () => void): void {
  fn();
  count += 1;
  console.log(`  ok  ${label}`);
}

const env: RenderEnv = {
  createCanvas: (w, h) => createCanvas(w, h) as unknown as RenderCanvas,
  loadAsset: async (src) => {
    throw new Error(`print tests load no assets, requested: ${src}`);
  },
};

// Photographic-style artwork: a smooth gradient with per-pixel noise.
function photo(w: number, h: number): RenderCanvas {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      d[i] = (x / w) * 200 + Math.random() * 40;
      d[i + 1] = (y / h) * 200 + Math.random() * 40;
      d[i + 2] = 120 + Math.random() * 40;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c as unknown as RenderCanvas;
}

function alphaAt(canvas: RenderCanvas, x: number, y: number): number {
  return canvas.getContext('2d')!.getImageData(Math.round(x), Math.round(y), 1, 1).data[3]!;
}

function spec(overrides: Partial<DesignSpec['transform']> = {}): DesignSpec {
  return { ...DEFAULT_SPEC, transform: { ...DEFAULT_SPEC.transform, ...overrides } };
}

const catalogue = await loadCatalogue();
const geometryOf = (slug: string) =>
  parsePrintGeometry(catalogue.find((t) => t.slug === slug)!.config);

console.log(`catalogue loaded: ${catalogue.length} products\n`);

check('pixel budget: the 16x20 canvas print fits the serverless budget by dropping DPI', () => {
  const g = geometryOf('canvas-print'); // 16x20 + 1.25in bleed = 18.5x22.5in
  const { w, h, dpi } = printPixelSize(g);
  assert.ok(w * h <= 24_000_000, `${w}x${h} = ${w * h} pixels over budget`);
  assert.ok(dpi < 300, 'must have dropped below the 300 target');
  assert.ok(dpi >= 200, `dpi ${dpi} dropped further than the budget requires`);
  // Exact: floor(sqrt(24e6 / (18.5 * 22.5))) = 240.
  assert.equal(dpi, 240);
});

check('pixel budget: small products keep the full 300 DPI target', () => {
  for (const slug of ['mug', 'keychain', 'phone-case', 'coaster']) {
    const { dpi } = printPixelSize(geometryOf(slug));
    assert.equal(dpi, 300, slug);
  }
});

check('bleed coverage: artwork reaches all four corners of the bled canvas', () => {
  const g = geometryOf('mug');
  const art = photo(4000, 3000);
  const { canvas, widthPx, heightPx } = generatePrintFile(env, art, DEFAULT_SPEC, g);
  assert.equal(canvas.width, widthPx);
  assert.equal(canvas.height, heightPx);
  for (const [x, y] of [
    [1, 1],
    [widthPx - 2, 1],
    [1, heightPx - 2],
    [widthPx - 2, heightPx - 2],
  ] as const) {
    assert.equal(alphaAt(canvas, x, y), 255, `corner (${x},${y}) not covered`);
  }
});

check('spec fidelity at print scale: a marker renders at the exact predicted size', () => {
  // 1000px artwork with a 100px black marker, printed on the coaster
  // (4in + bleed = 4.125in): cover-fit scale = outPx/1000, so the marker must
  // measure exactly 0.1 * outPx at scale 1 and 0.2 * outPx at scale 2.
  const g = geometryOf('coaster');
  const artC = createCanvas(1000, 1000);
  const actx = artC.getContext('2d');
  actx.fillStyle = '#fff';
  actx.fillRect(0, 0, 1000, 1000);
  actx.fillStyle = '#000';
  actx.fillRect(450, 450, 100, 100);
  const art = artC as unknown as RenderCanvas;

  for (const s of [1, 2]) {
    const { canvas, widthPx } = generatePrintFile(env, art, spec({ scale: s }), g);
    const row = canvas.getContext('2d')!.getImageData(0, Math.round(canvas.height / 2), canvas.width, 1).data;
    let dark = 0;
    for (let x = 0; x < canvas.width; x++) if (row[x * 4]! < 100 && row[x * 4 + 3]! > 128) dark++;
    const expected = 0.1 * s * widthPx;
    assert.ok(
      Math.abs(dark - expected) <= 3,
      `scale ${s}: marker ${dark}px, expected ${expected}`,
    );
  }
});

check('print render and a mockup-scale render are the same pixels, resampled', () => {
  // The whole point of one renderer: sample the print canvas and a 400px
  // preview at proportional points — same artwork, same spec, same result.
  // Large enough to clear the mousepad's DPI floor at 1.3x zoom — the gate
  // (rightly) rejects an 800x600 source here.
  const g = geometryOf('mousepad');
  const artC = createCanvas(2000, 1500);
  const actx = artC.getContext('2d');
  const grad = ['#c0392b', '#2980b9', '#27ae60', '#f39c12'];
  for (let i = 0; i < 4; i++) {
    actx.fillStyle = grad[i]!;
    actx.fillRect((i % 2) * 1000, Math.floor(i / 2) * 750, 1000, 750);
  }
  const art = artC as unknown as RenderCanvas;
  const testSpec = spec({ rotation: 15, scale: 1.3 });

  const print = generatePrintFile(env, art, testSpec, g);
  const preview = generatePrintFile(env, art, testSpec, g, { maxPixels: 400 * 400 });

  const pctx = print.canvas.getContext('2d')!;
  const vctx = preview.canvas.getContext('2d')!;
  for (const [fx, fy] of [[0.3, 0.3], [0.7, 0.4], [0.5, 0.7]] as const) {
    const a = pctx.getImageData(Math.round(fx * print.widthPx), Math.round(fy * print.heightPx), 1, 1).data;
    const b = vctx.getImageData(Math.round(fx * preview.widthPx), Math.round(fy * preview.heightPx), 1, 1).data;
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(a[i]! - b[i]!) <= 12, `(${fx},${fy}) ch${i}: print ${a[i]} vs preview ${b[i]}`);
    }
  }
});

check('bad art holds the order: below the floor throws BEFORE rendering', () => {
  const g = geometryOf('canvas-print');
  try {
    generatePrintFile(env, photo(640, 480), DEFAULT_SPEC, g);
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(isPrintQualityError(e), 'must be the quality error');
    assert.match((e as Error).message, /higher-resolution/);
  }
});

check('zoom that breaks the floor is caught with the same gate', () => {
  const g = geometryOf('poster');
  generatePrintFile(env, photo(1300, 2000), DEFAULT_SPEC, g); // fine at scale 1
  assert.throws(
    () => generatePrintFile(env, photo(1300, 2000), spec({ scale: 2 }), g),
    (e: unknown) => isPrintQualityError(e),
  );
});

check('format follows requiresCutout, per product, from data', () => {
  let png = 0;
  let jpeg = 0;
  for (const t of catalogue) {
    const cfg = t.config as { requiresCutout?: boolean };
    const format = printFormatFor(cfg);
    if (cfg.requiresCutout) {
      assert.equal(format, 'png', `${t.slug}: die-cut needs alpha`);
      png++;
    } else {
      assert.equal(format, 'jpeg', `${t.slug}: photo print ships JPEG`);
      jpeg++;
    }
  }
  assert.equal(png, 2, 'keychain + sticker-sheet');
  assert.equal(jpeg, 9);
});

check('a real 22.6MP-class render completes and covers the full canvas', () => {
  const g = geometryOf('canvas-print');
  const started = Date.now();
  const { canvas, widthPx, heightPx, dpi } = generatePrintFile(env, photo(4000, 3000), DEFAULT_SPEC, g);
  const ms = Date.now() - started;
  assert.equal(widthPx * heightPx <= 24_000_000, true);
  assert.equal(dpi, 240);
  // Centre and an off-centre point are opaque photo content.
  assert.equal(alphaAt(canvas, widthPx / 2, heightPx / 2), 255);
  assert.equal(alphaAt(canvas, widthPx * 0.9, heightPx * 0.1), 255);
  console.log(`      (${widthPx}x${heightPx} @ ${dpi} DPI rendered in ${ms}ms)`);
});

console.log(`\n${count} checks passed through the real renderer at print scale.`);
