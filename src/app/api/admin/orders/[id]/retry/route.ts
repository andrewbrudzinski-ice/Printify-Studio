// POST /api/admin/orders/[id]/retry — the way out for a held order.
//
// Guarded twice: requireAdmin() (shared with every /api/admin/* route), and
// canRetry() — which refuses unpaid orders (would ship for free) and
// accepted ones (would ship twice). The retry itself is the same
// fulfilOrder() the webhook runs.

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin/auth';
import { supabaseService } from '@/lib/supabase/service';
import { canRetry } from '@/lib/fulfilment/rules';
import { fulfilOrder } from '@/lib/fulfilment/submit';
import { makeFulfilmentDeps } from '@/lib/fulfilment/wire';

export const runtime = 'nodejs';

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const gate = await requireAdmin();
  if (!gate.ok) return gate.response;

  const db = supabaseService();
  const { id } = await params;
  const { data: order } = await db
    .from('orders')
    .select('id, status, fulfilment_status')
    .eq('id', id)
    .maybeSingle();
  if (!order) {
    return NextResponse.json({ error: 'No such order.' }, { status: 404 });
  }

  const decision = canRetry(order);
  if (!decision.ok) {
    return NextResponse.json({ error: decision.reason }, { status: 409 });
  }

  const outcome = await fulfilOrder(makeFulfilmentDeps(), id);
  return NextResponse.json({ outcome });
}
