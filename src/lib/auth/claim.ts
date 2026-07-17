// Attach anonymous work to a just-signed-in account. Anonymous uploads are
// first-class (demanding signup before the first mockup kills the funnel);
// this is the moment they become owned. claim_anon_projects() is SECURITY
// DEFINER server-side and claims only rows carrying this browser's token, so
// calling it eagerly after every sign-in is safe and idempotent.

const ANON_TOKEN_KEY = 'ps-anon-token';

// Accepts the client as unknown and casts to the one method it uses: the
// exact SupabaseClient generics differ between @supabase/ssr wrapper versions
// and supabase-js releases (rpc's Args parameter degrades to `never` through
// the wrapper), and coupling this helper to that churn isn't worth one RPC.
interface RpcSlice {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

export async function claimAnonWork(client: unknown): Promise<number> {
  const supabase = client as RpcSlice;
  if (typeof window === 'undefined') return 0;
  const token = window.localStorage.getItem(ANON_TOKEN_KEY);
  if (!token) return 0;

  const { data, error } = await supabase.rpc('claim_anon_projects', { p_token: token });
  if (error) return 0; // claiming is best-effort; the work stays claimable later

  const claimed = typeof data === 'number' ? data : 0;
  if (claimed > 0) {
    // The token has served its purpose; a fresh anonymous session later gets
    // a fresh token instead of colliding with the claimed one.
    window.localStorage.removeItem(ANON_TOKEN_KEY);
  }
  return claimed;
}
