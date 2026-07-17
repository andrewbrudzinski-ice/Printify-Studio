// POST /api/admin/orders/[id]/retry — the way out for a held order.
//
// Guarded twice: the caller must be an admin, and canRetry() must agree —
// it refuses unpaid orders (would ship for free) and accepted ones (would
// ship twice). The retry itself is the same fulfilOrder() the webhook runs.

import { NextResponse } from 'next/server';
import { supabaseRoute } from '@/lib/supabase/route';
import { supabaseService } from '@/lib/supabase/service';
import { canRetry } from '@/lib/fulfilment/rules';
import { fulfilOrder } from '@/lib/fulfilment/submit';
import { makeFulfilmentDeps } from '@/lib/fulfilment/wire';

export const runtime = 'nodejs';

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Admin actions are not configured.' }, { status: 503 });
  }

  const rls = await supabaseRoute();
  const {
    data: { user },
  } = await rls.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Sign in.' }, { status: 401 });
  }

  const db = supabaseService();
  const { data: profile } = await db.from('users').select('role').eq('id', user.id).maybeSingle();
  if ((profile as { role?: string } | null)?.role !== 'admin') {
    return NextResponse.json({ error: 'Admins only.' }, { status: 403 });
  }

  const { id } = await params;
  const { data: order } = await db
    .from('orders')
    .select('id, status, fulfilment_status')
    .eq('id', id)
    .maybeSingle();
  if (!order) {
    return NextResponse.json({ error: 'No such order.' }, { status: 404 });
  }

  const decision = canRetry(order as { status: string; fulfilment_status: string });
  if (!decision.ok) {
    return NextResponse.json({ error: decision.reason }, { status: 409 });
  }

  const outcome = await fulfilOrder(makeFulfilmentDeps(), id);
  return NextResponse.json({ outcome });
}
