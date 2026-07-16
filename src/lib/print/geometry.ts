// Print geometry: bleed, trim, safe zones and DPI gating. Pure math over the
// per-product `config.print` jsonb — nothing here knows what a keychain is.
//
// Vocabulary (all inches until converted):
//   trim  — the finished physical size after cutting (widthIn x heightIn)
//   bleed — extra printed margin OUTSIDE the trim so a slightly-off cut never
//           shows unprinted stock. The print canvas is trim + 2*bleed.
//   safe  — inset INSIDE the trim where critical content belongs.
//
// The safe zone is measured from the TRIM edge, not the bled canvas edge.
// Measuring from the canvas edge silently shrinks the margin by the bleed —
// content creeps toward the cut line and the error only shows on a physical
// product. tests/geometry.test.mts pins the relationship exactly.

export interface PrintGeometry {
  widthIn: number;
  heightIn: number;
  bleedIn: number;
  safeIn: number;
  minDpi: number;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Parse a template's config jsonb (optionally merged with a variant override,
// e.g. poster sizes) into validated geometry. Throws on malformed config: a
// template with broken geometry must fail loudly at read time, not produce a
// wrongly-sized print file after payment.
export function parsePrintGeometry(
  templateConfig: unknown,
  variantConfig?: unknown,
): PrintGeometry {
  const base = printSection(templateConfig);
  const override = variantConfig ? printSection(variantConfig, true) : {};
  const merged = { ...base, ...override };

  const widthIn = num(merged, 'widthIn');
  const heightIn = num(merged, 'heightIn');
  if (!(widthIn > 0) || !(heightIn > 0)) {
    throw new Error(`Print geometry has non-positive dimensions: ${widthIn}x${heightIn}`);
  }
  const bleedIn = numOr(merged, 'bleedIn', 0);
  const safeIn = numOr(merged, 'safeIn', 0);
  const minDpi = numOr(merged, 'minDpi', 100);
  if (bleedIn < 0 || safeIn < 0 || !(minDpi > 0)) {
    throw new Error('Print geometry has negative bleed/safe or non-positive minDpi.');
  }
  if (2 * safeIn >= Math.min(widthIn, heightIn)) {
    throw new Error('Safe inset consumes the whole trim area.');
  }
  return { widthIn, heightIn, bleedIn, safeIn, minDpi };
}

function printSection(config: unknown, partial = false): Record<string, unknown> {
  if (typeof config !== 'object' || config === null) {
    throw new Error('Template config is not an object.');
  }
  const print = (config as Record<string, unknown>)['print'];
  if (print === undefined && partial) return {};
  if (typeof print !== 'object' || print === null) {
    throw new Error('Template config is missing its print section.');
  }
  return print as Record<string, unknown>;
}

function num(o: Record<string, unknown>, key: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`Print geometry field "${key}" is missing or not a number.`);
  }
  return v;
}

function numOr(o: Record<string, unknown>, key: string, fallback: number): number {
  const v = o[key];
  if (v === undefined) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`Print geometry field "${key}" is not a number.`);
  }
  return v;
}

// Full printed size including bleed, in inches.
export function bledSizeIn(g: PrintGeometry): { w: number; h: number } {
  return { w: g.widthIn + 2 * g.bleedIn, h: g.heightIn + 2 * g.bleedIn };
}

export function canvasSizePx(g: PrintGeometry, dpi: number): { w: number; h: number } {
  const b = bledSizeIn(g);
  return { w: Math.round(b.w * dpi), h: Math.round(b.h * dpi) };
}

// Where the cut lands, in canvas pixels.
export function trimBoxPx(g: PrintGeometry, dpi: number): Box {
  return {
    x: Math.round(g.bleedIn * dpi),
    y: Math.round(g.bleedIn * dpi),
    w: Math.round(g.widthIn * dpi),
    h: Math.round(g.heightIn * dpi),
  };
}

// Critical-content boundary, inset from the TRIM edge by safeIn.
export function safeBoxPx(g: PrintGeometry, dpi: number): Box {
  return {
    x: Math.round((g.bleedIn + g.safeIn) * dpi),
    y: Math.round((g.bleedIn + g.safeIn) * dpi),
    w: Math.round((g.widthIn - 2 * g.safeIn) * dpi),
    h: Math.round((g.heightIn - 2 * g.safeIn) * dpi),
  };
}

// Effective DPI of a photo printed on this product: source pixels per printed
// inch after cover-fit and the user's zoom. Independent of the render DPI —
// upscaling the canvas doesn't add detail. Zoom divides straight in: 2x zoom
// halves the pixels covering each inch.
export function effectiveDpi(
  imageW: number,
  imageH: number,
  g: PrintGeometry,
  scale = 1,
): number {
  const b = bledSizeIn(g);
  return Math.min(imageW / b.w, imageH / b.h) / scale;
}

// ---------------------------------------------------------------------------
// The DPI gate. Below minDpi the physical product is visibly blurry; the
// order is held (fulfilment_status='error', money kept safe) rather than
// manufactured. A held order is recoverable; a printed blurry canvas is not.
// ---------------------------------------------------------------------------

export class PrintQualityError extends Error {
  readonly dpi: number;
  readonly minDpi: number;
  constructor(message: string, dpi: number, minDpi: number) {
    super(message);
    this.name = 'PrintQualityError';
    this.dpi = dpi;
    this.minDpi = minDpi;
  }
}

// Detect by name, never `instanceof`: a module instantiated twice (split
// chunks, server/client boundaries, some test runners) makes instanceof
// return false on an error with a correct prototype chain and a correct
// .name. The name check is duller and survives all of it.
export function isPrintQualityError(e: unknown): e is PrintQualityError {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { name?: unknown }).name === 'PrintQualityError'
  );
}

export function assertPrintable(
  imageW: number,
  imageH: number,
  g: PrintGeometry,
  scale = 1,
): void {
  const dpi = effectiveDpi(imageW, imageH, g, scale);
  if (dpi < g.minDpi) {
    // User-facing: say what to do next, not what went wrong internally.
    throw new PrintQualityError(
      `This photo is too small to print sharply at this size` +
        `${scale > 1 ? ' and zoom' : ''}. ` +
        `Use a higher-resolution photo${scale > 1 ? ' or zoom out' : ''}.`,
      dpi,
      g.minDpi,
    );
  }
}

// Upload-grid quality badge, per product. Same math as the gate so a photo
// badged printable can never be rejected at fulfilment.
export type QualityTier = 'great' | 'good' | 'low';

export function ratePrintQuality(
  imageW: number,
  imageH: number,
  g: PrintGeometry,
): { dpi: number; tier: QualityTier } {
  const dpi = effectiveDpi(imageW, imageH, g);
  const tier: QualityTier = dpi >= g.minDpi * 1.5 ? 'great' : dpi >= g.minDpi ? 'good' : 'low';
  return { dpi: Math.round(dpi), tier };
}
