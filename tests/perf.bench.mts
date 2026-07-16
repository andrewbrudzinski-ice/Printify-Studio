// Grid render timings against the real seed catalogue — informational, not a
// gate. The only hard assertion is the product promise itself: the full grid
// under 10 seconds, which should hold with enormous headroom.
//
// Template art is synthetic (a generated canvas per asset path) so the FULL
// layer stack executes — masks clip, overlays blend, meshes warp — without
// real photography in the repo.
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { renderMockup } from '../src/lib/mockup/renderer';
import { DEFAULT_SPEC } from '../src/lib/mockup/types';
import type { MockupLayer, RenderCanvas, RenderEnv, SourceImage } from '../src/lib/mockup/types';
import { loadCatalogue } from './helpers/catalogue.mts';

function syntheticAsset(src: string): RenderCanvas {
  // Deterministic per-path colour; masks must be opaque to keep pixels.
  const c = createCanvas(512, 512);
  const ctx = c.getContext('2d');
  let hash = 0;
  for (const ch of src) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  ctx.fillStyle = src.includes('mask')
    ? '#ffffff'
    : `rgb(${150 + (hash % 80)}, ${150 + ((hash >> 8) % 80)}, ${150 + ((hash >> 16) % 80)})`;
  ctx.fillRect(0, 0, 512, 512);
  return c as unknown as RenderCanvas;
}

const assets = new Map<string, SourceImage>();
const env: RenderEnv = {
  createCanvas: (w, h) => createCanvas(w, h) as unknown as RenderCanvas,
  loadAsset: async (src) => {
    let a = assets.get(src);
    if (!a) {
      a = syntheticAsset(src) as unknown as SourceImage;
      assets.set(src, a);
    }
    return a;
  },
};

function photo(w: number, h: number): SourceImage {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, '#c0392b');
  grad.addColorStop(0.5, '#2980b9');
  grad.addColorStop(1, '#f39c12');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  return c as unknown as SourceImage;
}

const catalogue = await loadCatalogue();
const artwork = photo(2000, 1500);
const TILE = 400;

console.log(`grid bench: ${catalogue.length} products at ${TILE}px\n`);

// Warm once (JIT + asset generation) so the numbers reflect steady state.
for (const t of catalogue) {
  await renderMockup({
    env,
    layers: t.mockup_layers as MockupLayer[],
    artwork,
    spec: DEFAULT_SPEC,
    width: TILE,
    height: TILE,
  });
}

let total = 0;
const rows: Array<{ slug: string; ms: number; layers: number }> = [];
for (const t of catalogue) {
  const layers = t.mockup_layers as MockupLayer[];
  const started = performance.now();
  await renderMockup({ env, layers, artwork, spec: DEFAULT_SPEC, width: TILE, height: TILE });
  const ms = performance.now() - started;
  total += ms;
  rows.push({ slug: t.slug, ms, layers: layers.length });
}

rows.sort((a, b) => b.ms - a.ms);
for (const r of rows) {
  console.log(`  ${r.ms.toFixed(1).padStart(6)}ms  ${r.slug} (${r.layers} layers)`);
}
console.log(`\n  total: ${total.toFixed(0)}ms for the full grid`);
console.log(`  headroom: ~${Math.round(10_000 / Math.max(1, total))}x under the 10s promise`);

assert.ok(total < 10_000, `full grid took ${total.toFixed(0)}ms — the 10s promise is broken`);
console.log('\ngrid bench complete.');
