// Generate placeholder template art for every product, into public/templates/.
//
//   npx tsx scripts/generate-template-art.mts
//
// This is PLACEHOLDER art — procedural scenes, silhouettes and lighting, not
// product photography. It exists so the mockup engine composites real layer
// stacks (mask clips, gloss multiplies, shadows ground the product) instead
// of grey rectangles, in the demo and in development. Swap each file for real
// photography in the `templates` storage bucket without touching code: the
// paths come from the seed's mockup_layers, which is also where THIS script
// reads them — nothing here is hand-matched to a product.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createCanvas, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';
import demo from '../src/lib/studio/demoCatalogue.json';
import type { MockupLayer, NormRect } from '../src/lib/mockup/types';

const SIZE = 1024;

// Per-product scene hue so the grid doesn't look like one beige wall.
const HUES: Record<string, number> = {
  'phone-case': 210, mug: 30, tshirt: 260, 'tote-bag': 90, poster: 200,
  'canvas-print': 20, keychain: 330, 'sticker-sheet': 160, 'photo-stamps': 45,
  mousepad: 230, coaster: 15,
};

function px(r: NormRect) {
  return { x: r.x * SIZE, y: r.y * SIZE, w: r.w * SIZE, h: r.h * SIZE };
}

// The union of all artwork rects, inflated — the product body sits behind it.
function productBox(layers: MockupLayer[]): { x: number; y: number; w: number; h: number } {
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (const l of layers) {
    if (l.type === 'ARTWORK' || l.type === 'MESH_WARP') {
      minX = Math.min(minX, l.rect.x); minY = Math.min(minY, l.rect.y);
      maxX = Math.max(maxX, l.rect.x + l.rect.w); maxY = Math.max(maxY, l.rect.y + l.rect.h);
    }
  }
  const pad = 0.06;
  return px({ x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad });
}

function rounded(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function sceneBg(slug: string, layers: MockupLayer[]): Canvas {
  const hue = HUES[slug] ?? 200;
  const c = createCanvas(SIZE, SIZE);
  const ctx = c.getContext('2d');

  // Soft wall-and-surface scene: gradient wall, darker surface band, vignette.
  const wall = ctx.createLinearGradient(0, 0, 0, SIZE);
  wall.addColorStop(0, `hsl(${hue}, 22%, 92%)`);
  wall.addColorStop(0.72, `hsl(${hue}, 18%, 84%)`);
  wall.addColorStop(0.73, `hsl(${hue}, 14%, 72%)`);
  wall.addColorStop(1, `hsl(${hue}, 12%, 66%)`);
  ctx.fillStyle = wall;
  ctx.fillRect(0, 0, SIZE, SIZE);

  // The product body: a soft-shadowed rounded slab behind the print area.
  const box = productBox(layers);
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.28)';
  ctx.shadowBlur = 46;
  ctx.shadowOffsetY = 22;
  ctx.fillStyle = `hsl(${hue}, 8%, 97%)`;
  rounded(ctx, box.x, box.y, box.w, box.h, Math.min(box.w, box.h) * 0.08);
  ctx.fill();
  ctx.restore();

  // Vignette so corners recede.
  const vig = ctx.createRadialGradient(SIZE / 2, SIZE / 2, SIZE * 0.45, SIZE / 2, SIZE / 2, SIZE * 0.75);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,0.14)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, SIZE, SIZE);
  return c;
}

// Alpha silhouette: keep pixels inside the (inflated) product shape.
function maskFor(slug: string, layers: MockupLayer[]): Canvas {
  const c = createCanvas(SIZE, SIZE);
  const ctx = c.getContext('2d');
  const box = productBox(layers);
  ctx.fillStyle = '#fff';
  if (slug === 'coaster' || slug === 'keychain') {
    ctx.beginPath();
    ctx.ellipse(box.x + box.w / 2, box.y + box.h / 2, box.w / 2, box.h / 2, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    rounded(ctx, box.x, box.y, box.w, box.h, Math.min(box.w, box.h) * (slug === 'phone-case' ? 0.16 : 0.05));
    ctx.fill();
  }
  return c;
}

// Multiply overlays start white (neutral); screen overlays start black.
function lightingOverlay(kind: 'multiply' | 'screen'): Canvas {
  const c = createCanvas(SIZE, SIZE);
  const ctx = c.getContext('2d');
  if (kind === 'multiply') {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, SIZE, SIZE);
    // A diagonal soft shade: light from the upper left.
    const g = ctx.createLinearGradient(0, 0, SIZE, SIZE);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.65, 'rgba(190,190,200,0.10)');
    g.addColorStop(1, 'rgba(120,120,140,0.22)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, SIZE, SIZE);
  } else {
    // screen: black is neutral; a soft white streak reads as gloss.
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, SIZE, SIZE);
    const g = ctx.createLinearGradient(SIZE * 0.15, 0, SIZE * 0.6, SIZE);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.16)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.05)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, SIZE, SIZE);
  }
  return c;
}

// SHADOW layers multiply over the scene: white-neutral with a soft dark pool.
function shadowFor(layers: MockupLayer[]): Canvas {
  const c = createCanvas(SIZE, SIZE);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, SIZE, SIZE);
  const box = productBox(layers);
  const g = ctx.createRadialGradient(
    box.x + box.w / 2, box.y + box.h + 14, 8,
    box.x + box.w / 2, box.y + box.h + 14, box.w * 0.65,
  );
  g.addColorStop(0, 'rgba(70,70,80,0.35)');
  g.addColorStop(1, 'rgba(70,70,80,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, SIZE, SIZE);
  return c;
}

// The phone camera block, placed over the case's top-left.
function cameraFor(layers: MockupLayer[]): Canvas {
  const c = createCanvas(SIZE, SIZE);
  const ctx = c.getContext('2d');
  const box = productBox(layers);
  const w = box.w * 0.34;
  const h = w * 1.05;
  const x = box.x + box.w * 0.06;
  const y = box.y + box.h * 0.035;
  ctx.fillStyle = 'rgba(30,32,38,0.96)';
  rounded(ctx, x, y, w, h, w * 0.28);
  ctx.fill();
  for (const [lx, ly] of [
    [x + w * 0.3, y + h * 0.28], [x + w * 0.3, y + h * 0.72], [x + w * 0.7, y + h * 0.5],
  ] as const) {
    ctx.fillStyle = '#11131a';
    ctx.beginPath(); ctx.arc(lx, ly, w * 0.14, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(130,160,220,0.5)';
    ctx.beginPath(); ctx.arc(lx - w * 0.03, ly - w * 0.03, w * 0.05, 0, Math.PI * 2); ctx.fill();
  }
  return c;
}

let files = 0;
for (const t of demo.templates) {
  const layers = t.mockupLayers as MockupLayer[];
  const srcs = new Set<string>();
  for (const l of layers) if ('src' in l && l.src) srcs.add(l.src);

  for (const src of srcs) {
    const layer = layers.find((l) => 'src' in l && (l as { src?: string }).src === src)!;
    let canvas: Canvas;
    if (layer.type === 'MASK') canvas = maskFor(t.slug, layers);
    else if (layer.type === 'SHADOW') canvas = shadowFor(layers);
    else if (layer.type === 'OVERLAY')
      canvas = lightingOverlay((layer as { blend?: string }).blend === 'screen' ? 'screen' : 'multiply');
    else if (src.includes('camera')) canvas = cameraFor(layers);
    else canvas = sceneBg(t.slug, layers);

    const out = `public/templates/${src}`;
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(
      out,
      src.endsWith('.jpg') ? canvas.toBuffer('image/jpeg', 88) : canvas.toBuffer('image/png'),
    );
    files++;
  }
}
console.log(`template art generated: ${files} files under public/templates/`);
