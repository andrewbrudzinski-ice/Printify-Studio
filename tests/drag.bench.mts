// Drag-frame timings — informational, not a gate. A drag frame renders at
// half resolution (320px) exactly as the editor does; the budget that matters
// is 16ms (60Hz). Products over budget get flagged in the output, not failed:
// CI hardware variance would make a hard per-product assertion flaky.
import { createCanvas } from '@napi-rs/canvas';
import { renderMockup } from '../src/lib/mockup/renderer';
import { DEFAULT_SPEC } from '../src/lib/mockup/types';
import type { DesignSpec, MockupLayer, RenderCanvas, RenderEnv, SourceImage } from '../src/lib/mockup/types';
import { loadCatalogue } from './helpers/catalogue.mts';

const assets = new Map<string, SourceImage>();
const env: RenderEnv = {
  createCanvas: (w, h) => createCanvas(w, h) as unknown as RenderCanvas,
  loadAsset: async (src) => {
    let a = assets.get(src);
    if (!a) {
      const c = createCanvas(512, 512);
      const ctx = c.getContext('2d');
      ctx.fillStyle = src.includes('mask') ? '#fff' : '#b9c2cc';
      ctx.fillRect(0, 0, 512, 512);
      a = c as unknown as SourceImage;
      assets.set(src, a);
    }
    return a;
  },
};

const photoCanvas = createCanvas(2000, 1500);
{
  const ctx = photoCanvas.getContext('2d');
  ctx.fillStyle = '#7f8c8d';
  ctx.fillRect(0, 0, 2000, 1500);
}
const artwork = photoCanvas as unknown as SourceImage;

// A mid-drag spec: panned and zoomed, the state every frame re-renders from.
const dragSpec: DesignSpec = {
  version: 1,
  transform: { x: 0.12, y: -0.08, scale: 1.6, rotation: 0 },
  filters: { brightness: 1, contrast: 1, saturation: 1 },
  cutout: false,
};

const DRAG_SIZE = 320;
const BUDGET_MS = 16;
const FRAMES = 5;

const catalogue = await loadCatalogue();
console.log(`drag bench: ${catalogue.length} products, ${FRAMES} frames each at ${DRAG_SIZE}px\n`);

// Warm pass.
for (const t of catalogue) {
  await renderMockup({
    env,
    layers: t.mockup_layers as MockupLayer[],
    artwork,
    spec: dragSpec,
    width: DRAG_SIZE,
    height: DRAG_SIZE,
  });
}

const rows: Array<{ slug: string; ms: number }> = [];
for (const t of catalogue) {
  const layers = t.mockup_layers as MockupLayer[];
  const started = performance.now();
  for (let i = 0; i < FRAMES; i++) {
    await renderMockup({
      env,
      layers,
      artwork,
      spec: dragSpec,
      width: DRAG_SIZE,
      height: DRAG_SIZE,
    });
  }
  rows.push({ slug: t.slug, ms: (performance.now() - started) / FRAMES });
}

rows.sort((a, b) => b.ms - a.ms);
for (const r of rows) {
  const flag = r.ms > BUDGET_MS ? '  <-- over the 16ms/60Hz budget' : '';
  console.log(`  ${r.ms.toFixed(1).padStart(6)}ms/frame  ${r.slug}${flag}`);
}

const worst = rows[0]!;
console.log(
  `\n  worst: ${worst.slug} at ${worst.ms.toFixed(1)}ms/frame (budget ${BUDGET_MS}ms)`,
);
console.log('drag bench complete.');
