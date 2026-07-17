// GET /api/admin/orders — the order book for the admin dashboard. Newest
// first, optionally filtered to attention-needed states
// (?filter=needs-attention keeps paid orders that are held or unsubmitted).

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin/auth';
import { supabaseService } from '@/lib/supabase/service';
import type { AdminOrderRow } from '@/lib/admin/orders';

export const runtime = 'nodejs';

export async function GET(req: Request): Promise<NextResponse> {
  const gate = await requireAdmin();
  if (!gate.ok) return gate.response;

  const db = supabaseService();
  const { data, error } = await db
    .from('orders')
    .select(
      'id, email, status, fulfilment_status, total, created_at, provider_response, order_items ( id )',
    )
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) {
    return NextResponse.json({ error: 'Could not load orders.' }, { status: 500 });
  }

  let orders: AdminOrderRow[] = (data ?? []).map((row) => ({
    id: row.id,
    email: row.email,
    status: row.status,
    fulfilment_status: row.fulfilment_status,
    total: row.total,
    created_at: row.created_at,
    provider_response: row.provider_response,
    item_count: row.order_items.length,
  }));

  const filter = new URL(req.url).searchParams.get('filter');
  if (filter === 'needs-attention') {
    orders = orders.filter(
      (o) =>
        o.status === 'paid' &&
        (o.fulfilment_status === 'error' || o.fulfilment_status === 'unsubmitted'),
    );
  }

  return NextResponse.json({ orders });
}
