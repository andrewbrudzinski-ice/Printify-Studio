// POST /api/discount/validate — the cart's discount preview. Rate-limited so
// the discounts table can't be enumerated, and the response never says WHY a
// code is invalid.

import { NextResponse } from 'next/server';
import { supabaseService } from '@/lib/supabase/service';
import { loadActiveDiscount } from '@/lib/checkout/discount';
import { createRateLimiter } from '@/lib/rateLimit';

export const runtime = 'nodejs';

// Module-level: shared across requests within this instance. In-memory is a
// documented known gap — multiple regions multiply the limit silently.
const limiter = createRateLimiter({ limit: 10, windowMs: 60_000 });

export async function POST(req: Request): Promise<NextResponse> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Discounts are not configured.' }, { status: 503 });
  }

  const ip = (req.headers.get('x-forwarded-for') ?? 'unknown').split(',')[0]!.trim();
  if (!limiter.allow(ip)) {
    return NextResponse.json(
      { error: 'Too many attempts — wait a minute and try again.' },
      { status: 429 },
    );
  }

  let code: string;
  try {
    const body = (await req.json()) as { code?: string };
    code = String(body.code ?? '').trim();
  } catch {
    return NextResponse.json({ error: 'Send a JSON body.' }, { status: 400 });
  }
  if (!code || code.length > 64) {
    return NextResponse.json({ valid: false });
  }

  const discount = await loadActiveDiscount(supabaseService(), code);
  return discount
    ? NextResponse.json({ valid: true, code: discount.code, kind: discount.kind, value: discount.value })
    : NextResponse.json({ valid: false });
}
