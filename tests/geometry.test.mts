// Print geometry against the REAL catalogue: bleed math, safe zones relative
// to trim (not the bled canvas), and per-product DPI gating.
import assert from 'node:assert/strict';
import {
  assertPrintable,
  bledSizeIn,
  canvasSizePx,
  effectiveDpi,
  isPrintQualityError,
  parsePrintGeometry,
  PrintQualityError,
  ratePrintQuality,
  safeBoxPx,
  trimBoxPx,
} from '../src/lib/print/geometry';
import { loadCatalogue } from './helpers/catalogue.mts';

let count = 0;
function check(label: string, fn: () => void): void {
  fn();
  count += 1;
  console.log(`  ok  ${label}`);
}

const catalogue = await loadCatalogue();
console.log(`catalogue loaded: ${catalogue.length} products from the real seed\n`);

check('every product in the catalogue parses into valid geometry', () => {
  assert.equal(catalogue.length, 11);
  for (const t of catalogue) {
    const g = parsePrintGeometry(t.config);
    assert.ok(g.widthIn > 0 && g.heightIn > 0, t.slug);
    assert.equal(g.minDpi, 100, `${t.slug}: the 100 DPI floor`);
  }
});

check('variant overrides merge over template geometry (poster sizes)', () => {
  const poster = catalogue.find((t) => t.slug === 'poster')!;
  const small = poster.variants.find((v) => v.sku === 'PSTR-12x18')!;
  const large = poster.variants.find((v) => v.sku === 'PSTR-18x24')!;
  const gSmall = parsePrintGeometry(poster.config, small.config);
  const gLarge = parsePrintGeometry(poster.config, large.config);
  assert.equal(gSmall.widthIn, 12);
  assert.equal(gLarge.widthIn, 18);
  assert.equal(gLarge.heightIn, 24);
  // Fields the variant doesn't override survive from the template.
  assert.equal(gLarge.bleedIn, parsePrintGeometry(poster.config).bleedIn);
  assert.equal(gLarge.minDpi, 100);
});

check('bleed math: the print canvas is trim + 2x bleed, exactly', () => {
  for (const t of catalogue) {
    const g = parsePrintGeometry(t.config);
    const b = bledSizeIn(g);
    assert.equal(b.w, g.widthIn + 2 * g.bleedIn, t.slug);
    assert.equal(b.h, g.heightIn + 2 * g.bleedIn, t.slug);
    const px = canvasSizePx(g, 300);
    assert.equal(px.w, Math.round(b.w * 300), t.slug);
  }
});

check('trim box sits inset by exactly the bleed on every product', () => {
  for (const t of catalogue) {
    const g = parsePrintGeometry(t.config);
    const trim = trimBoxPx(g, 300);
    const canvas = canvasSizePx(g, 300);
    assert.equal(trim.x, Math.round(g.bleedIn * 300), t.slug);
    assert.equal(trim.w, Math.round(g.widthIn * 300), t.slug);
    // Trim + bleed on both sides reassembles the canvas.
    assert.ok(Math.abs(trim.x * 2 + trim.w - canvas.w) <= 1, t.slug);
  }
});

check('safe zone is measured from the TRIM edge, not the bled canvas edge', () => {
  // The canvas-print has the biggest bleed (1.25in gallery wrap) — exactly
  // where measuring from the canvas edge would be most wrong.
  const t = catalogue.find((x) => x.slug === 'canvas-print')!;
  const g = parsePrintGeometry(t.config);
  const trim = trimBoxPx(g, 300);
  const safe = safeBoxPx(g, 300);
  assert.equal(safe.x - trim.x, Math.round(g.safeIn * 300), 'inset relative to trim');
  assert.equal(safe.x, Math.round((g.bleedIn + g.safeIn) * 300), 'bleed + safe from canvas edge');
  assert.equal(safe.w, Math.round((g.widthIn - 2 * g.safeIn) * 300));
});

check('safe inside trim inside canvas, on every product', () => {
  for (const t of catalogue) {
    const g = parsePrintGeometry(t.config);
    const canvas = canvasSizePx(g, 300);
    const trim = trimBoxPx(g, 300);
    const safe = safeBoxPx(g, 300);
    assert.ok(trim.x >= 0 && trim.x + trim.w <= canvas.w, `${t.slug}: trim in canvas`);
    assert.ok(safe.x >= trim.x && safe.x + safe.w <= trim.x + trim.w, `${t.slug}: safe in trim`);
    assert.ok(safe.y >= trim.y && safe.y + safe.h <= trim.y + trim.h, `${t.slug}: safe in trim (y)`);
  }
});

check('effective DPI is independent of render DPI and divides by zoom', () => {
  const g = parsePrintGeometry(catalogue.find((x) => x.slug === 'mug')!.config);
  const at1 = effectiveDpi(4000, 3000, g, 1);
  const at2 = effectiveDpi(4000, 3000, g, 2);
  assert.ok(Math.abs(at1 / at2 - 2) < 1e-9, 'zoom 2x halves effective DPI');
  // No render-DPI parameter exists to vary — the math uses only source pixels
  // and physical inches. Cross-check one value by hand: bled mug is
  // 8.75in x 3.75in; 4000px/8.75in ≈ 457, 3000px/3.75in = 800; min is 457.
  assert.ok(Math.abs(at1 - 4000 / 8.75) < 1e-9);
});

check('per-product DPI gate: a 12MP photo passes everything at scale 1', () => {
  for (const t of catalogue) {
    const g = parsePrintGeometry(t.config);
    assertPrintable(4000, 3000, g, 1); // throws on failure
  }
});

check('per-product DPI gate: a 640x480 thumbnail fails large formats, passes small ones', () => {
  const fails: string[] = [];
  for (const t of catalogue) {
    const g = parsePrintGeometry(t.config);
    try {
      assertPrintable(640, 480, g, 1);
    } catch (e) {
      assert.ok(isPrintQualityError(e), `${t.slug}: wrong error type`);
      fails.push(t.slug);
    }
  }
  // The wall-art formats must reject a thumbnail; the tiny keychain accepts it.
  assert.ok(fails.includes('canvas-print'), 'canvas-print must reject 640x480');
  assert.ok(fails.includes('poster'), 'poster must reject 640x480');
  assert.ok(!fails.includes('keychain'), 'keychain (2in) prints fine from 640x480');
});

check('zoom can push a passing photo below the floor — the gate accounts for it', () => {
  const g = parsePrintGeometry(catalogue.find((x) => x.slug === 'poster')!.config);
  // 12.25in bled width at 1300px ≈ 106 DPI: passes at scale 1, fails at 2.
  assertPrintable(1300, 2000, g, 1);
  assert.throws(() => assertPrintable(1300, 2000, g, 2), (e: unknown) => isPrintQualityError(e));
});

check('the quality error is detected by name, never instanceof', () => {
  const real = new PrintQualityError('too small', 42, 100);
  assert.equal(isPrintQualityError(real), true);
  // An error crossing a duplicated-module boundary: right shape, foreign class.
  const foreign = Object.assign(new Error('too small'), {
    name: 'PrintQualityError',
    dpi: 42,
    minDpi: 100,
  });
  assert.equal(isPrintQualityError(foreign), true, 'foreign instance must still be detected');
  assert.equal(isPrintQualityError(new Error('other')), false);
  assert.equal(isPrintQualityError(null), false);
});

check('the gate message says what to do next, and carries the numbers', () => {
  const g = parsePrintGeometry(catalogue.find((x) => x.slug === 'canvas-print')!.config);
  try {
    assertPrintable(640, 480, g, 2);
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(isPrintQualityError(e));
    assert.match((e as Error).message, /higher-resolution photo/);
    assert.match((e as Error).message, /zoom out/);
    assert.ok((e as PrintQualityError).dpi < (e as PrintQualityError).minDpi);
  }
});

check('quality badges agree with the gate: "good" can never be rejected', () => {
  for (const t of catalogue) {
    const g = parsePrintGeometry(t.config);
    for (const [w, h] of [[640, 480], [1600, 1200], [4000, 3000]] as const) {
      const { tier } = ratePrintQuality(w, h, g);
      if (tier !== 'low') {
        assertPrintable(w, h, g, 1); // must not throw
      }
    }
  }
});

check('malformed geometry throws at parse time, not at print time', () => {
  assert.throws(() => parsePrintGeometry({}), /missing its print section/);
  assert.throws(() => parsePrintGeometry({ print: { widthIn: 8 } }), /heightIn/);
  assert.throws(() => parsePrintGeometry({ print: { widthIn: -1, heightIn: 2 } }), /non-positive/);
  assert.throws(
    () => parsePrintGeometry({ print: { widthIn: 2, heightIn: 2, safeIn: 1 } }),
    /Safe inset consumes/,
  );
});

console.log(`\n${count} checks passed against the real catalogue.`);
