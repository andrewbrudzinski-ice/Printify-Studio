// Pure grid logic — everything about the mockup grid that doesn't need a
// browser lives here, where it's testable against the real catalogue.

import type { MockupLayer } from '../mockup/types';
import { parsePrintGeometry, ratePrintQuality, type QualityTier } from '../print/geometry';

// The catalogue as the client sees it (shaped by /api/catalogue). Prices are
// display-only here — checkout re-reads everything server-side.
export interface CatalogueVariantDto {
  sku: string;
  name: string;
  price: number;
  config: unknown;
}

export interface CatalogueTemplateDto {
  slug: string;
  name: string;
  description: string;
  config: unknown;
  mockupLayers: MockupLayer[];
  variants: CatalogueVariantDto[];
}

// Template art lives in the public `templates` bucket, uploaded by hand. When
// it hasn't been uploaded yet, the grid must still work: strip every layer
// that needs a bucket asset and keep the artwork geometry over a neutral
// base. "Grey rectangles" are the engine working with the art absent — not a
// bug, and not a reason to weaken the renderer's throw-on-missing-asset rule.
export function fallbackLayers(layers: MockupLayer[]): MockupLayer[] {
  return layers.filter((l) => l.type === 'ARTWORK' || l.type === 'MESH_WARP');
}

export interface TemplateQuality {
  dpi: number;
  tier: QualityTier;
}

// Per-product print-quality badges for the grid, straight from the same math
// the fulfilment gate uses — a photo badged printable can never be rejected
// later. Templates with malformed geometry are skipped rather than crashing
// the grid; the SQL suite keeps the seed valid, but templates can also arrive
// from the future admin builder.
export function qualityByTemplate(
  imageW: number,
  imageH: number,
  templates: ReadonlyArray<Pick<CatalogueTemplateDto, 'slug' | 'config'>>,
): Map<string, TemplateQuality> {
  const out = new Map<string, TemplateQuality>();
  for (const t of templates) {
    try {
      const g = parsePrintGeometry(t.config);
      out.set(t.slug, ratePrintQuality(imageW, imageH, g));
    } catch {
      // No geometry, no badge — the tile still renders.
    }
  }
  return out;
}
