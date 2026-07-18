// Renderer tests against REAL pixels via @napi-rs/canvas — no mocks. Every
// probe samples a location that distinguishes the states it asserts on (a
// probe that reads the same before and after proves nothing when it passes
// and lies when it fails — that bit twice in the print tests).
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { prepareArtwork, renderMockup } from '../src/lib/mockup/renderer';
import { affineFromTriangles, expandTriangle } from '../src/lib/mockup/warp';
import { DEFAULT_SPEC } from '../src/lib/mockup/types';
import type {
  DesignSpec,
  MeshGrid,
  MockupLayer,
  RenderCanvas,
  RenderEnv,
} from '../src/lib/mockup/types';

let count = 0;
function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn()).then(() => {
    count += 1;
    console.log(`  ok  ${label}`);
  });
}

// --- Environment: real canvases, in-memory assets ---------------------------

const assets = new Map<string, RenderCanvas>();

const env: RenderEnv = {
  // One cast at the env boundary: @napi-rs/canvas satisfies the renderer's
  // structural interfaces but declares narrower unions for some properties.
  createCanvas: (w, h) => createCanvas(w, h) as unknown as RenderCanvas,
  loadAsset: async (src) => {
    const a = assets.get(src);
    if (!a) throw new Error(`asset failed to load: ${src}`);
    return a;
  },
};

function solid(w: number, h: number, css: string): RenderCanvas {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, w, h);
  return c as unknown as RenderCanvas;
}

// Top half one colour, bottom half another — orientation is observable.
function splitTopBottom(w: number, h: number, top: string, bottom: string): RenderCanvas {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, w, h / 2);
  ctx.fillStyle = bottom;
  ctx.fillRect(0, h / 2, w, h / 2);
  return c as unknown as RenderCanvas;
}

function splitLeftRight(w: number, h: number, left: string, right: string): RenderCanvas {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = left;
  ctx.fillRect(0, 0, w / 2, h);
  ctx.fillStyle = right;
  ctx.fillRect(w / 2, 0, w / 2, h);
  return c as unknown as RenderCanvas;
}

// White with a centred black square marker of a known size.
function marker(w: number, h: number, markerPx: number): RenderCanvas {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#000';
  ctx.fillRect((w - markerPx) / 2, (h - markerPx) / 2, markerPx, markerPx);
  return c as unknown as RenderCanvas;
}

function px(canvas: RenderCanvas, x: number, y: number): number[] {
  const d = canvas.getContext('2d')!.getImageData(Math.round(x), Math.round(y), 1, 1).data;
  return [d[0]!, d[1]!, d[2]!, d[3]!];
}

function near(actual: number[], expected: number[], tol = 8): void {
  for (let i = 0; i < expected.length; i++) {
    assert.ok(
      Math.abs(actual[i]! - expected[i]!) <= tol,
      `channel ${i}: got ${actual}, expected ~${expected}`,
    );
  }
}

// Length and centre of the dark run along a row — measures marker size/position.
function darkRun(canvas: RenderCanvas, y: number): { length: number; center: number } {
  const w = canvas.width;
  const d = canvas.getContext('2d')!.getImageData(0, Math.round(y), w, 1).data;
  let first = -1;
  let last = -1;
  for (let x = 0; x < w; x++) {
    // Opaque AND dark — a panned artwork exposes transparent canvas, which
    // must not read as marker.
    if (d[x * 4 + 3]! > 128 && d[x * 4]! < 100) {
      if (first < 0) first = x;
      last = x;
    }
  }
  return first < 0 ? { length: 0, center: -1 } : { length: last - first + 1, center: (first + last) / 2 };
}

function spec(overrides: Partial<DesignSpec['transform']> = {}, filters: Partial<DesignSpec['filters']> = {}): DesignSpec {
  return {
    version: 1,
    transform: { ...DEFAULT_SPEC.transform, ...overrides },
    filters: { ...DEFAULT_SPEC.filters, ...filters },
    cutout: false,
  };
}

function uniformMesh(rect: { x: number; y: number; w: number; h: number }, cols: number, rows: number, fx?: (t: number) => number): MeshGrid {
  const points: [number, number][] = [];
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const tx = fx ? fx(c / cols) : c / cols;
      points.push([rect.x + tx * rect.w, rect.y + (r / rows) * rect.h]);
    }
  }
  return { cols, rows, points };
}

assets.set('bg/red', solid(64, 64, '#f00'));
assets.set('bg/white', solid(64, 64, '#fff'));
assets.set('overlay/gray', solid(64, 64, 'rgb(128,128,128)'));

const CENTER_RECT = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };

// --- Warp math ---------------------------------------------------------------

await check('affine map: 2,000 random triangles, vertices map exactly', () => {
  let maxErr = 0;
  for (let n = 0; n < 2000; n++) {
    const t = (): [number, number] => [Math.random() * 1000 - 500, Math.random() * 1000 - 500];
    const src: [any, any, any] = [t(), t(), t()];
    const dst: [any, any, any] = [t(), t(), t()];
    const m = affineFromTriangles(src, dst);
    if (!m) continue; // randomly degenerate — skipped, as the renderer does
    for (let i = 0; i < 3; i++) {
      const [x, y] = src[i];
      const ex = m.a * x + m.c * y + m.e;
      const ey = m.b * x + m.d * y + m.f;
      maxErr = Math.max(maxErr, Math.abs(ex - dst[i][0]), Math.abs(ey - dst[i][1]));
    }
  }
  assert.ok(maxErr < 1e-6, `max vertex mapping error ${maxErr}`);
});

await check('degenerate source triangle yields null, not garbage', () => {
  const m = affineFromTriangles(
    [[0, 0], [1, 1], [2, 2]], // collinear
    [[0, 0], [1, 0], [0, 1]],
  );
  assert.equal(m, null);
});

await check('expandTriangle moves every edge outward by exactly pad — even slivers', () => {
  // Distance from each original edge's line to the corresponding expanded
  // edge's line must equal pad regardless of triangle shape. The sliver is
  // the case the centroid-based fix got wrong.
  const cases: [number, number][][] = [
    [[0, 0], [100, 0], [0, 100]], // ordinary
    [[0, 0], [200, 0], [100, 1.5]], // sliver: nearly-collinear apex
  ];
  for (const tri of cases) {
    const pad = 0.75;
    const ex = expandTriangle(tri as any, pad);
    for (let i = 0; i < 3; i++) {
      const A = tri[i]!;
      const B = tri[(i + 1) % 3]!;
      const E = ex[i]!; // expanded vertex lies on the offset of edge (i-1) and edge i
      // distance from expanded vertex to the ORIGINAL edge i's line:
      const dx = B[0] - A[0];
      const dy = B[1] - A[1];
      const len = Math.hypot(dx, dy);
      const dist = Math.abs((E[0] - A[0]) * dy - (E[1] - A[1]) * dx) / len;
      assert.ok(Math.abs(dist - pad) < 1e-6, `edge ${i}: offset ${dist}, expected ${pad}`);
    }
  }
});

// --- Layer order & placement --------------------------------------------------

await check('layer order: artwork covers the background inside its rect only', async () => {
  const { canvas } = await renderMockup({
    env,
    layers: [{ type: 'IMAGE', src: 'bg/red' }, { type: 'ARTWORK', rect: CENTER_RECT }],
    artwork: solid(64, 64, '#00f'),
    spec: DEFAULT_SPEC,
    width: 200,
    height: 200,
  });
  near(px(canvas, 100, 100), [0, 0, 255, 255]); // inside rect: artwork
  near(px(canvas, 10, 10), [255, 0, 0, 255]); // outside rect: background
});

await check('resolution independence: 200px and 1000px renders agree at proportional points', async () => {
  const artwork = splitTopBottom(80, 80, '#f00', '#00f');
  const render = (size: number) =>
    renderMockup({
      env,
      layers: [{ type: 'IMAGE', src: 'bg/white' }, { type: 'ARTWORK', rect: CENTER_RECT }],
      artwork,
      spec: DEFAULT_SPEC,
      width: size,
      height: size,
    });
  const small = (await render(200)).canvas;
  const large = (await render(1000)).canvas;
  // Probes sit clearly inside a colour region — never ON the red/blue seam,
  // whose antialiased blend legitimately differs between resolutions.
  for (const [fx, fy] of [[0.4, 0.35], [0.6, 0.65], [0.1, 0.1], [0.5, 0.42]] as const) {
    const a = px(small, fx * 200, fy * 200);
    const b = px(large, fx * 1000, fy * 1000);
    near(a, b, 10);
  }
});

// --- Transform ------------------------------------------------------------------

await check('zoom: marker size scales exactly with spec.transform.scale', async () => {
  // 100px artwork cover-fit into a 200px area = 2x base scale, so the 20px
  // marker renders 40px at scale 1 and 80px at scale 2. Exact, measurable.
  const art = marker(100, 100, 20);
  const at = async (scale: number) =>
    darkRun(
      (
        await renderMockup({
          env,
          layers: [{ type: 'ARTWORK', rect: { x: 0, y: 0, w: 1, h: 1 } }],
          artwork: art,
          spec: spec({ scale }),
          width: 200,
          height: 200,
        })
      ).canvas,
      100,
    );
  assert.ok(Math.abs((await at(1)).length - 40) <= 3, `scale 1: ${(await at(1)).length}px, expected 40`);
  assert.ok(Math.abs((await at(2)).length - 80) <= 3, `scale 2: ${(await at(2)).length}px, expected 80`);
});

await check('pan: x=0.25 moves the marker a quarter of the print area', async () => {
  const art = marker(100, 100, 20);
  const { canvas } = await renderMockup({
    env,
    layers: [{ type: 'ARTWORK', rect: { x: 0, y: 0, w: 1, h: 1 } }],
    artwork: art,
    spec: spec({ x: 0.25 }),
    width: 200,
    height: 200,
  });
  const run = darkRun(canvas, 100);
  assert.ok(Math.abs(run.center - 150) <= 2, `marker centre ${run.center}, expected 150`);
});

await check('rotation 90°: the top of the artwork faces right', async () => {
  const { canvas } = await renderMockup({
    env,
    layers: [{ type: 'ARTWORK', rect: { x: 0, y: 0, w: 1, h: 1 } }],
    artwork: splitTopBottom(100, 100, '#f00', '#00f'),
    spec: spec({ rotation: 90 }),
    width: 200,
    height: 200,
  });
  near(px(canvas, 160, 100), [255, 0, 0, 255]); // right = old top (red)
  near(px(canvas, 40, 100), [0, 0, 255, 255]); // left = old bottom (blue)
});

// --- Filters ---------------------------------------------------------------------

await check('brightness 0.5 halves a white artwork', () => {
  const art = prepareArtwork(env, solid(50, 50, '#fff'), spec({}, { brightness: 0.5 }), 50, 50);
  near(px(art, 25, 25), [128, 128, 128, 255], 3);
});

await check('contrast 2 pushes mid-grey away from the pivot', () => {
  // (100 - 128) * 2 + 128 = 72
  const art = prepareArtwork(env, solid(50, 50, 'rgb(100,100,100)'), spec({}, { contrast: 2 }), 50, 50);
  near(px(art, 25, 25), [72, 72, 72, 255], 3);
});

await check('saturation 0 turns pure red into its luma grey', () => {
  // Rec.601 luma of pure red = 0.299 * 255 ≈ 76
  const art = prepareArtwork(env, solid(50, 50, '#f00'), spec({}, { saturation: 0 }), 50, 50);
  near(px(art, 25, 25), [76, 76, 76, 255], 3);
});

await check('neutral filters leave pixels bit-identical (fast path)', () => {
  const art = prepareArtwork(env, solid(50, 50, 'rgb(13,77,211)'), DEFAULT_SPEC, 50, 50);
  near(px(art, 25, 25), [13, 77, 211, 255], 0);
});

// --- Masks & blends ---------------------------------------------------------------

await check('MASK clips the artwork, not the scene behind it', async () => {
  // Mask: opaque left half, transparent right half.
  const mask = createCanvas(200, 200);
  const mctx = mask.getContext('2d');
  mctx.fillStyle = '#fff';
  mctx.fillRect(0, 0, 100, 200);
  assets.set('mask/left', mask as unknown as RenderCanvas);

  const { canvas } = await renderMockup({
    env,
    layers: [
      { type: 'IMAGE', src: 'bg/red' },
      { type: 'ARTWORK', rect: { x: 0, y: 0, w: 1, h: 1 } },
      { type: 'MASK', src: 'mask/left' },
    ],
    artwork: solid(64, 64, '#00f'),
    spec: DEFAULT_SPEC,
    width: 200,
    height: 200,
  });
  near(px(canvas, 50, 100), [0, 0, 255, 255]); // kept: artwork
  near(px(canvas, 150, 100), [255, 0, 0, 255]); // clipped: red scene shows through
});

await check('OVERLAY multiplies over everything below it', async () => {
  const { canvas } = await renderMockup({
    env,
    layers: [
      { type: 'IMAGE', src: 'bg/red' },
      { type: 'ARTWORK', rect: CENTER_RECT },
      { type: 'OVERLAY', src: 'overlay/gray' },
    ],
    artwork: solid(64, 64, '#fff'),
    spec: DEFAULT_SPEC,
    width: 200,
    height: 200,
  });
  near(px(canvas, 100, 100), [128, 128, 128, 255], 4); // white * gray = gray
  near(px(canvas, 10, 10), [128, 0, 0, 255], 4); // red * gray = half red
});

// --- Mesh warp ---------------------------------------------------------------------

await check('mesh identity: a uniform mesh renders the same pixels as a plain ARTWORK', async () => {
  const artwork = splitTopBottom(80, 80, '#f00', '#00f');
  const plain = (
    await renderMockup({
      env,
      layers: [{ type: 'IMAGE', src: 'bg/white' }, { type: 'ARTWORK', rect: CENTER_RECT }],
      artwork,
      spec: DEFAULT_SPEC,
      width: 400,
      height: 400,
    })
  ).canvas;
  const meshed = (
    await renderMockup({
      env,
      layers: [
        { type: 'IMAGE', src: 'bg/white' },
        { type: 'MESH_WARP', rect: CENTER_RECT, mesh: uniformMesh(CENTER_RECT, 4, 2) },
      ],
      artwork,
      spec: DEFAULT_SPEC,
      width: 400,
      height: 400,
    })
  ).canvas;
  for (const [x, y] of [[150, 130], [150, 270], [250, 150], [250, 250], [200, 200]] as const) {
    near(px(plain, x, y), px(meshed, x, y), 10);
  }
});

await check('mesh mirror: mirrored x points flip the artwork left-right', async () => {
  const artwork = splitLeftRight(80, 80, '#f00', '#00f');
  const mirrored = uniformMesh(CENTER_RECT, 4, 2, (t) => 1 - t);
  const { canvas } = await renderMockup({
    env,
    layers: [
      { type: 'IMAGE', src: 'bg/white' },
      { type: 'MESH_WARP', rect: CENTER_RECT, mesh: mirrored },
    ],
    artwork,
    spec: DEFAULT_SPEC,
    width: 400,
    height: 400,
  });
  near(px(canvas, 140, 200), [0, 0, 255, 255]); // left shows the artwork's RIGHT half
  near(px(canvas, 260, 200), [255, 0, 0, 255]);
});

await check('no seams: solid artwork on a dense sliver mesh leaves no background hairlines', async () => {
  // Cosine-spaced columns mimic a cylinder silhouette: the outermost cells
  // are slivers — exactly the shape that beat the centroid-based seam fix.
  const rect = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
  const sliverMesh = uniformMesh(rect, 16, 8, (t) => (1 - Math.cos(Math.PI * t)) / 2);
  const { canvas } = await renderMockup({
    env,
    layers: [
      { type: 'IMAGE', src: 'bg/white' },
      { type: 'MESH_WARP', rect, mesh: sliverMesh },
    ],
    artwork: solid(64, 64, '#00f'),
    spec: DEFAULT_SPEC,
    width: 400,
    height: 400,
  });
  // Count non-blue pixels strictly inside the mesh region.
  const ctx = canvas.getContext('2d')!;
  const inset = 3;
  const x0 = Math.ceil(rect.x * 400) + inset;
  const y0 = Math.ceil(rect.y * 400) + inset;
  const w = Math.floor(rect.w * 400) - inset * 2;
  const h = Math.floor(rect.h * 400) - inset * 2;
  const d = ctx.getImageData(x0, y0, w, h).data;
  let hairline = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i]! > 40 || d[i + 1]! > 40 || d[i + 2]! < 215) hairline++;
  }
  assert.ok(hairline < 50, `${hairline} background hairline pixels inside the mesh`);
});

// --- The lessons that must not regress -----------------------------------------------

await check('a broken asset URL rejects the render — never silent wrong output', async () => {
  await assert.rejects(
    renderMockup({
      env,
      layers: [{ type: 'IMAGE', src: 'missing/nowhere.jpg' }],
      artwork: solid(10, 10, '#000'),
      spec: DEFAULT_SPEC,
      width: 50,
      height: 50,
    }),
    /asset failed to load/,
  );
});

await check('16 same-size ARTWORK cells prepare the artwork once, not 16 times', async () => {
  const layers: MockupLayer[] = [{ type: 'IMAGE', src: 'bg/white' }];
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      layers.push({ type: 'ARTWORK', rect: { x: 0.06 + c * 0.23, y: 0.06 + r * 0.23, w: 0.2, h: 0.2 } });
    }
  }
  // One odd-sized cell must trigger exactly one extra prepare.
  layers.push({ type: 'ARTWORK', rect: { x: 0.3, y: 0.3, w: 0.4, h: 0.3 } });
  const { stats } = await renderMockup({
    env,
    layers,
    artwork: solid(64, 64, '#0a0'),
    spec: DEFAULT_SPEC,
    width: 200,
    height: 200,
  });
  assert.equal(stats.prepared, 2);
});

await check('a malformed mesh throws instead of rendering something subtly wrong', async () => {
  const bad: MeshGrid = { cols: 4, rows: 2, points: [[0, 0]] }; // wrong count
  await assert.rejects(
    renderMockup({
      env,
      layers: [{ type: 'MESH_WARP', rect: CENTER_RECT, mesh: bad }],
      artwork: solid(10, 10, '#000'),
      spec: DEFAULT_SPEC,
      width: 100,
      height: 100,
    }),
    /Mesh point .* missing/,
  );
});

console.log(`\n${count} checks passed against real pixels.`);
