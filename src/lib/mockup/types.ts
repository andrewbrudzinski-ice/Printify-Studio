// The mockup engine's vocabulary. A mockup is an ordered stack of layers
// composited onto a canvas; product_templates.mockup_layers stores exactly
// this shape as jsonb. All geometry is normalised 0..1 so one template
// renders identically at 400px (grid thumbnail) and 2000px (share image).

export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// A destination mesh for warping artwork across a curved surface (mug wraps,
// tote folds). `points` is row-major, (cols+1) * (rows+1) entries, each a
// normalised [x, y] position on the output canvas. The artwork is divided
// into a uniform source grid and each cell is affine-mapped onto the
// corresponding destination cell.
export interface MeshGrid {
  cols: number;
  rows: number;
  points: [number, number][];
}

export type BlendMode = 'source-over' | 'multiply' | 'screen' | 'overlay';

export type MockupLayer =
  // Product base / scene photography. Full-canvas unless a rect is given.
  | { type: 'IMAGE'; src: string; rect?: NormRect }
  // The user's photo. This rect IS the print area.
  | { type: 'ARTWORK'; rect: NormRect }
  // Artwork bent across a grid.
  | { type: 'MESH_WARP'; rect: NormRect; mesh: MeshGrid }
  // Alpha-clip everything artwork-ish drawn since the last flush to a die-cut
  // shape (white/opaque = keep, transparent = drop).
  | { type: 'MASK'; src: string }
  // Soft shadow art, multiplied over the scene.
  | { type: 'SHADOW'; src: string }
  // Lighting / gloss / texture, composited with a blend mode.
  | { type: 'OVERLAY'; src: string; blend?: BlendMode };

// ---------------------------------------------------------------------------
// DesignSpec — the single source of truth for what gets rendered AND printed.
// The editor writes it, every preview re-renders from it, and the print file
// is generated from it by the same code. v1 covers transform + filters; text,
// stickers and die-cut outline extend this additively when the editor lands.
// ---------------------------------------------------------------------------

export interface DesignSpec {
  version: 1;
  transform: {
    // Pan, as a fraction of the print-area size (0.25 = a quarter width).
    x: number;
    y: number;
    // Multiplier over cover-fit. The editor clamps to >= 1: below 1 the
    // artwork no longer covers the print area and the physical product would
    // print blank margins.
    scale: number;
    // Degrees, clockwise.
    rotation: number;
  };
  filters: {
    brightness: number; // 1 = neutral
    contrast: number; // 1 = neutral
    saturation: number; // 1 = neutral, 0 = greyscale
  };
}

export const DEFAULT_SPEC: DesignSpec = {
  version: 1,
  transform: { x: 0, y: 0, scale: 1, rotation: 0 },
  filters: { brightness: 1, contrast: 1, saturation: 1 },
};

// ---------------------------------------------------------------------------
// The rendering environment. The renderer touches ONLY the 2D canvas API —
// that constraint is what lets the same code run in a browser worker
// (OffscreenCanvas) and in Node (@napi-rs/canvas) for print generation.
// Never reach for a DOM API inside the renderer; inject capability here.
//
// These are minimal structural interfaces both canvas implementations
// satisfy. Callers bridge their concrete canvas with a single cast at the
// env boundary.
// ---------------------------------------------------------------------------

// Anything drawImage can consume: a decoded image or another canvas.
export interface SourceImage {
  width: number;
  height: number;
}

export interface ImageDataLike {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

export interface RenderContext2D {
  globalCompositeOperation: string;
  globalAlpha: number;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(rad: number): void;
  scale(x: number, y: number): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  clip(): void;
  drawImage(image: SourceImage, dx: number, dy: number): void;
  drawImage(image: SourceImage, dx: number, dy: number, dw: number, dh: number): void;
  getImageData(sx: number, sy: number, sw: number, sh: number): ImageDataLike;
  putImageData(imagedata: ImageDataLike, dx: number, dy: number): void;
}

export interface RenderCanvas extends SourceImage {
  getContext(contextId: '2d'): RenderContext2D | null;
}

export interface RenderEnv {
  createCanvas(width: number, height: number): RenderCanvas;
  // MUST reject on a missing/broken asset — never resolve with a placeholder.
  // A sticker that silently fails to load ships a product without the sticker;
  // a thrown error is caught before anything is printed. Implementations
  // should cache: the same src is requested repeatedly across a grid render.
  loadAsset(src: string): Promise<SourceImage>;
}
