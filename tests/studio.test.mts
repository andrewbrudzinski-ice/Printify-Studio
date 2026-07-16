// The grid's pure logic against the real seed catalogue: the grey-rectangle
// fallback and the per-product quality badges.
import assert from 'node:assert/strict';
import { fallbackLayers, qualityByTemplate } from '../src/lib/studio/grid';
import type { MockupLayer } from '../src/lib/mockup/types';
import { loadCatalogue } from './helpers/catalogue.mts';

let count = 0;
function check(label: string, fn: () => void): void {
  fn();
  count += 1;
  console.log(`  ok  ${label}`);
}

const catalogue = await loadCatalogue();
console.log(`catalogue loaded: ${catalogue.length} products\n`);

check('fallback keeps only asset-free layers — the grid works with zero template art', () => {
  for (const t of catalogue) {
    const fallback = fallbackLayers(t.mockup_layers as MockupLayer[]);
    assert.ok(fallback.length > 0, `${t.slug}: fallback renders nothing`);
    for (const layer of fallback) {
      assert.ok(
        layer.type === 'ARTWORK' || layer.type === 'MESH_WARP',
        `${t.slug}: fallback kept a ${layer.type} layer that needs a bucket asset`,
      );
    }
  }
});

check('fallback preserves the full artwork geometry (photo-stamps keeps all 16 cells)', () => {
  const stamps = catalogue.find((t) => t.slug === 'photo-stamps')!;
  assert.equal(fallbackLayers(stamps.mockup_layers as MockupLayer[]).length, 16);
  const mug = catalogue.find((t) => t.slug === 'mug')!;
  const mugFallback = fallbackLayers(mug.mockup_layers as MockupLayer[]);
  assert.equal(mugFallback.length, 1);
  assert.equal(mugFallback[0]!.type, 'MESH_WARP', 'the mug keeps its mesh, not a flat rect');
});

check('a 12MP photo badges printable on every product', () => {
  const q = qualityByTemplate(4000, 3000, catalogue);
  assert.equal(q.size, 11);
  for (const [slug, { tier, dpi }] of q) {
    assert.notEqual(tier, 'low', `${slug} at ${dpi} DPI`);
    assert.ok(Number.isInteger(dpi), `${slug}: dpi must be an integer`);
  }
});

check('a 640x480 thumbnail badges low exactly where fulfilment would hold it', () => {
  const q = qualityByTemplate(640, 480, catalogue);
  assert.equal(q.get('canvas-print')!.tier, 'low');
  assert.equal(q.get('poster')!.tier, 'low');
  assert.notEqual(q.get('keychain')!.tier, 'low', 'a 2in keychain prints fine from 640px');
});

check('a template with malformed geometry is skipped, not fatal to the grid', () => {
  const q = qualityByTemplate(4000, 3000, [
    { slug: 'good', config: { print: { widthIn: 4, heightIn: 4, minDpi: 100 } } },
    { slug: 'broken', config: { nope: true } },
  ]);
  assert.equal(q.has('good'), true);
  assert.equal(q.has('broken'), false);
});

console.log(`\n${count} checks passed against the real catalogue.`);
