// The admin gate, shared by every /api/admin/* route so the check can't
// drift between them: a signed-in user (RLS cookie client) whose profile row
// says role='admin' (read via the service client — the users policy only
// lets a user see their own row, which is fine, but the role check must not
// depend on client-writable state).

import { NextResponse } from 'next/server';
import { supabaseRoute } from '../supabase/route';
import { supabaseService } from '../supabase/service';

export type AdminGate =
  | { ok: true; userId: string }
  | { ok: false; response: NextResponse };

export async function requireAdmin(): Promise<AdminGate> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Admin actions are not configured on this deployment.' },
        { status: 503 },
      ),
    };
  }

  const rls = await supabaseRoute();
  const {
    data: { user },
  } = await rls.auth.getUser();
  if (!user) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Sign in.' }, { status: 401 }),
    };
  }

  const db = supabaseService();
  const { data: profile } = await db.from('users').select('role').eq('id', user.id).maybeSingle();
  if (profile?.role !== 'admin') {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Admins only.' }, { status: 403 }),
    };
  }

  return { ok: true, userId: user.id };
}
