// Service-role client. BYPASSES EVERY RLS POLICY in the database.
//
// SERVER ONLY. The `server-only` import below makes a client bundle fail to
// build if this file is ever imported from client code — but don't rely on
// that as the only guard: never re-export it through a barrel file a client
// component might touch, and never put the key in a NEXT_PUBLIC_* var.
//
// Legitimate uses: the Stripe webhook (writes orders — clients can't),
// /api/admin/* (after an explicit role check), design persistence for
// anonymous carts. Everything else should use route.ts and let RLS work.
import 'server-only';
import { createClient } from '@supabase/supabase-js';

export function supabaseService() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'Supabase service role is not configured. Set SUPABASE_SERVICE_ROLE_KEY (server-side only, never NEXT_PUBLIC_*).',
    );
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
