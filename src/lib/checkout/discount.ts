// The one place a discount code is judged. Both /api/discount/validate (the
// cart's preview) and /api/stripe/checkout (the charge) call this, so a code
// the cart accepted cannot be refused at payment — or vice versa.
//
// Reads through the SERVICE client because clients have no read access to
// discounts at all (no enumeration oracle); the rate limit on the validate
// route is the other half of that defence.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Discount } from '../pricing/types';

export async function loadActiveDiscount(
  db: SupabaseClient,
  code: string,
): Promise<Discount | null> {
  const { data } = await db.from('discounts').select('*').eq('code', code).maybeSingle();
  if (!data) return null;
  const d = data as {
    code: string;
    kind: 'percent' | 'fixed';
    value: number;
    active: boolean;
    expires_at: string | null;
    max_redemptions: number | null;
    redemptions: number;
  };
  // One boolean out: WHY a code is invalid (expired vs maxed vs unknown) is
  // deliberately not distinguishable from outside.
  if (!d.active) return null;
  if (d.expires_at && new Date(d.expires_at).getTime() < Date.now()) return null;
  if (d.max_redemptions !== null && d.redemptions >= d.max_redemptions) return null;
  return { code: d.code, kind: d.kind, value: d.value };
}
