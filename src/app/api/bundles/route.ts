// GET /api/bundles — active bundle rules for cart display and bundle nudges.
// Public data (RLS: anon reads active rows); the same rules feed the same
// pricing engine on both sides, so the cart's "bundle savings" line and the
// charged amount cannot disagree.

import { NextResponse } from 'next/server';
import { supabaseRoute } from '@/lib/supabase/route';
import type { BundleRule } from '@/lib/pricing/types';

export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
    return NextResponse.json({ error: 'Bundles are not configured.' }, { status: 503 });
  }

  const db = await supabaseRoute();
  const { data, error } = await db
    .from('bundles')
    .select('id, skus, quantity, reward, priority')
    .eq('active', true);
  if (error) {
    return NextResponse.json({ error: 'Could not load bundles.' }, { status: 500 });
  }

  const bundles: BundleRule[] = ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    skus: row.skus as string[],
    quantity: Number(row.quantity),
    reward: row.reward as BundleRule['reward'],
    priority: Number(row.priority),
  }));

  return NextResponse.json(
    { bundles },
    { headers: { 'Cache-Control': 's-maxage=60, stale-while-revalidate=300' } },
  );
}
