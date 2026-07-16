// The compositor everything shares. The editor preview, the mockup grid, the
// share image and the print file ALL render through this file — that is why
// the customer's approval and the printed product are the same pixels. Do not
// add a second render path; it would drift, and the drift would only be
// discovered on a manufactured product.
//
// 2D canvas API only. No DOM. Capability comes in through RenderEnv, so this
// exact code runs in a browser worker (OffscreenCanvas) and in Node
// (@napi-rs/canvas) for print generation.

import type {
  DesignSpec,
  MeshGrid,
  MockupLayer,
  NormRect,
  RenderCanvas,
  RenderContext2D,
  RenderEnv,
  SourceImage,
} from './types';
import { affineFromTriangles, expandTriangle, SEAM_PAD, type Triangle, type Vec2 } from './warp';

function ctx2d(canvas: RenderCanvas): RenderContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable in this environment.');
  return ctx;
}

// ---------------------------------------------------------------------------
// prepareArtwork — the one function that turns (photo, DesignSpec) into
// pixels. generatePrintFile() calls this at print scale; the editor calls it
// at screen scale; the grid calls it at thumbnail scale. Same code, same
// pixels, different resolution.
// ---------------------------------------------------------------------------
export function prepareArtwork(
  env: RenderEnv,
  artwork: SourceImage,
  spec: DesignSpec,
  outW: number,
  outH: number,
): RenderCanvas {
  const w = Math.max(1, Math.round(outW));
  const h = Math.max(1, Math.round(outH));
  const canvas = env.createCanvas(w, h);
  const ctx = ctx2d(canvas);

  // Cover-fit: scale so the artwork fully covers the print area (cropping the
  // overflow), then apply the user's transform on top. Contain-fit would
  // print blank margins on a physical product.
  const baseScale = Math.max(w / artwork.width, h / artwork.height);
  const scale = baseScale * spec.transform.scale;

  ctx.save();
  ctx.translate(w / 2 + spec.transform.x * w, h / 2 + spec.transform.y * h);
  ctx.rotate((spec.transform.rotation * Math.PI) / 180);
  ctx.scale(scale, scale);
  ctx.drawImage(artwork, -artwork.width / 2, -artwork.height / 2);
  ctx.restore();

  applyFilters(ctx, w, h, spec);
  return canvas;
}

// Pixel-level filters rather than ctx.filter: the CSS filter string is not
// implemented consistently across 2D backends (notably absent in some
// OffscreenCanvas implementations), and a filter that silently no-ops in one
// environment breaks the preview===print guarantee this renderer exists for.
function applyFilters(ctx: RenderContext2D, w: number, h: number, spec: DesignSpec): void {
  const { brightness, contrast, saturation } = spec.filters;
  if (brightness === 1 && contrast === 1 && saturation === 1) return;

  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i]!;
    let g = d[i + 1]!;
    let b = d[i + 2]!;

    // Saturation first (it's defined relative to the source colour), then
    // brightness, then contrast — the order the editor's sliders present.
    if (saturation !== 1) {
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      r = luma + (r - luma) * saturation;
      g = luma + (g - luma) * saturation;
      b = luma + (b - luma) * saturation;
    }
    if (brightness !== 1) {
      r *= brightness;
      g *= brightness;
      b *= brightness;
    }
    if (contrast !== 1) {
      r = (r - 128) * contrast + 128;
      g = (g - 128) * contrast + 128;
      b = (b - 128) * contrast + 128;
    }

    d[i] = r < 0 ? 0 : r > 255 ? 255 : r;
    d[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
    d[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
  }
  ctx.putImageData(img, 0, 0);
}

// ---------------------------------------------------------------------------
// Mesh warp
// ---------------------------------------------------------------------------

function meshPoint(mesh: MeshGrid, col: number, row: number, w: number, h: number): Vec2 {
  const p = mesh.points[row * (mesh.cols + 1) + col];
  if (!p) {
    // A malformed template must throw, not render something subtly wrong —
    // the SQL suite validates point counts, but templates can also arrive
    // from the future admin builder.
    throw new Error(
      `Mesh point (${col},${row}) missing: expected ${(mesh.cols + 1) * (mesh.rows + 1)} points.`,
    );
  }
  return [p[0] * w, p[1] * h];
}

function drawMeshWarp(
  ctx: RenderContext2D,
  art: RenderCanvas,
  mesh: MeshGrid,
  outW: number,
  outH: number,
): void {
  const aw = art.width;
  const ah = art.height;

  for (let r = 0; r < mesh.rows; r++) {
    for (let c = 0; c < mesh.cols; c++) {
      // Uniform source grid over the prepared artwork.
      const sx0 = (c / mesh.cols) * aw;
      const sx1 = ((c + 1) / mesh.cols) * aw;
      const sy0 = (r / mesh.rows) * ah;
      const sy1 = ((r + 1) / mesh.rows) * ah;

      const d00 = meshPoint(mesh, c, r, outW, outH);
      const d10 = meshPoint(mesh, c + 1, r, outW, outH);
      const d01 = meshPoint(mesh, c, r + 1, outW, outH);
      const d11 = meshPoint(mesh, c + 1, r + 1, outW, outH);

      drawTriangle(ctx, art, [[sx0, sy0], [sx1, sy0], [sx0, sy1]], [d00, d10, d01]);
      drawTriangle(ctx, art, [[sx1, sy0], [sx1, sy1], [sx0, sy1]], [d10, d11, d01]);
    }
  }
}

function drawTriangle(
  ctx: RenderContext2D,
  art: RenderCanvas,
  src: Triangle,
  dst: Triangle,
): void {
  const m = affineFromTriangles(src, dst);
  if (!m) return; // degenerate source cell — nothing to draw

  // Clip to the seam-padded destination triangle, then draw the whole artwork
  // through the affine map. Padding the clip (not the transform) means
  // adjacent triangles overlap by ~SEAM_PAD px and antialiased edge gaps
  // can't show the background through.
  const ex = expandTriangle(dst, SEAM_PAD);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(ex[0][0], ex[0][1]);
  ctx.lineTo(ex[1][0], ex[1][1]);
  ctx.lineTo(ex[2][0], ex[2][1]);
  ctx.closePath();
  ctx.clip();
  ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
  ctx.drawImage(art, 0, 0);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// renderMockup — walk a template's layer stack.
// ---------------------------------------------------------------------------

export interface RenderStats {
  // How many times the artwork was actually prepared. photo-stamps has 16
  // ARTWORK cells of the same artwork; preparing per cell instead of per size
  // once cost a 666ms editor frame. The test pins this at the API level.
  prepared: number;
}

export interface RenderResult {
  canvas: RenderCanvas;
  stats: RenderStats;
}

export async function renderMockup(opts: {
  env: RenderEnv;
  layers: MockupLayer[];
  artwork: SourceImage;
  spec: DesignSpec;
  width: number;
  height: number;
}): Promise<RenderResult> {
  const { env, layers, artwork, spec } = opts;
  const W = Math.max(1, Math.round(opts.width));
  const H = Math.max(1, Math.round(opts.height));

  const main = env.createCanvas(W, H);
  const mainCtx = ctx2d(main);

  // Artwork-ish layers accumulate on a group canvas so a MASK clips exactly
  // the artwork drawn since the last flush — never the scene behind it.
  // (Held in an object: these are assigned inside the helper closures below,
  // which TS's narrowing doesn't track for plain lets.)
  const grp: { canvas: RenderCanvas | null; ctx: RenderContext2D | null } = {
    canvas: null,
    ctx: null,
  };

  const stats: RenderStats = { prepared: 0 };
  // Memoized per render, keyed by pixel size: 16 stamp cells of one size
  // prepare once. Never cache across renders — the spec changes between them.
  const preparedBySize = new Map<string, RenderCanvas>();

  function getPrepared(wPx: number, hPx: number): RenderCanvas {
    const w = Math.max(1, Math.round(wPx));
    const h = Math.max(1, Math.round(hPx));
    const key = `${w}x${h}`;
    let art = preparedBySize.get(key);
    if (!art) {
      art = prepareArtwork(env, artwork, spec, w, h);
      stats.prepared += 1;
      preparedBySize.set(key, art);
    }
    return art;
  }

  function ensureGroup(): RenderContext2D {
    if (!grp.canvas || !grp.ctx) {
      grp.canvas = env.createCanvas(W, H);
      grp.ctx = ctx2d(grp.canvas);
    }
    return grp.ctx;
  }

  function flushGroup(): void {
    if (grp.canvas) {
      mainCtx.drawImage(grp.canvas, 0, 0);
      grp.canvas = null;
      grp.ctx = null;
    }
  }

  function px(rect: NormRect): { x: number; y: number; w: number; h: number } {
    return { x: rect.x * W, y: rect.y * H, w: rect.w * W, h: rect.h * H };
  }

  for (const layer of layers) {
    switch (layer.type) {
      case 'IMAGE': {
        flushGroup();
        const img = await env.loadAsset(layer.src);
        if (layer.rect) {
          const r = px(layer.rect);
          mainCtx.drawImage(img, r.x, r.y, r.w, r.h);
        } else {
          mainCtx.drawImage(img, 0, 0, W, H);
        }
        break;
      }

      case 'ARTWORK': {
        const g = ensureGroup();
        const r = px(layer.rect);
        const art = getPrepared(r.w, r.h);
        g.drawImage(art, r.x, r.y, r.w, r.h);
        break;
      }

      case 'MESH_WARP': {
        const g = ensureGroup();
        const r = px(layer.rect);
        const art = getPrepared(r.w, r.h);
        drawMeshWarp(g, art, layer.mesh, W, H);
        break;
      }

      case 'MASK': {
        // Clip the accumulated artwork to the die-cut shape. Without a group
        // there is nothing to mask — a template authoring error, but a benign
        // one.
        if (grp.ctx) {
          const img = await env.loadAsset(layer.src);
          grp.ctx.globalCompositeOperation = 'destination-in';
          grp.ctx.drawImage(img, 0, 0, W, H);
          grp.ctx.globalCompositeOperation = 'source-over';
        }
        break;
      }

      case 'SHADOW': {
        flushGroup();
        const img = await env.loadAsset(layer.src);
        mainCtx.globalCompositeOperation = 'multiply';
        mainCtx.drawImage(img, 0, 0, W, H);
        mainCtx.globalCompositeOperation = 'source-over';
        break;
      }

      case 'OVERLAY': {
        flushGroup();
        const img = await env.loadAsset(layer.src);
        mainCtx.globalCompositeOperation = layer.blend ?? 'multiply';
        mainCtx.drawImage(img, 0, 0, W, H);
        mainCtx.globalCompositeOperation = 'source-over';
        break;
      }
    }
  }

  flushGroup();
  return { canvas: main, stats };
}
