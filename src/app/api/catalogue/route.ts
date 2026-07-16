// GET /api/catalogue — templates + variants + mockup layers for the grid.
// Read through the RLS route client with no special key: anon sees active
// rows only, and can't see discounts or provider_mappings at all — retail
// prices only, never wholesale cost. That's the policy layer doing the work,
// not this route being careful.

import { NextResponse } from 'next/server';
import { supabaseRoute } from '@/lib/supabase/route';
import type { CatalogueTemplateDto } from '@/lib/studio/grid';

export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
    return NextResponse.json({ error: 'Catalogue is not configured.' }, { status: 503 });
  }

  const db = await supabaseRoute();
  const { data, error } = await db
    .from('product_templates')
    .select(
      'slug, name, description, config, mockup_layers, sort_order, product_variants ( sku, name, price, config, active )',
    )
    .order('sort_order');
  if (error) {
    return NextResponse.json({ error: 'Could not load the catalogue.' }, { status: 500 });
  }

  const templates: CatalogueTemplateDto[] = ((data ?? []) as Array<{
    slug: string;
    name: string;
    description: string;
    config: unknown;
    mockup_layers: CatalogueTemplateDto['mockupLayers'];
    product_variants: Array<{ sku: string; name: string; price: number; config: unknown; active: boolean }>;
  }>).map((t) => ({
    slug: t.slug,
    name: t.name,
    description: t.description,
    config: t.config,
    mockupLayers: t.mockup_layers,
    variants: t.product_variants
      .filter((v) => v.active)
      .map((v) => ({ sku: v.sku, name: v.name, price: v.price, config: v.config })),
  }));

  return NextResponse.json(
    { templates },
    // The catalogue changes when an admin edits it, not per-request.
    { headers: { 'Cache-Control': 's-maxage=60, stale-while-revalidate=300' } },
  );
}
