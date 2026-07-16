// Route-handler client: anon key + the caller's auth cookie, so RLS applies
// AS THE SIGNED-IN USER. This is the default choice for API routes — reach
// for service.ts only when a route must legitimately cross RLS (webhooks,
// admin operations), never for convenience.
import { cookies } from 'next/headers';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

export async function supabaseRoute() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      'Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local.',
    );
  }
  const store = await cookies();
  return createServerClient(url, key, {
    cookies: {
      getAll() {
        return store.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        // Route handlers may set cookies; server components may not — Next
        // throws there, and swallowing it is the documented @supabase/ssr
        // pattern (middleware refreshes the session in that case).
        try {
          for (const { name, value, options } of cookiesToSet) {
            store.set(name, value, options);
          }
        } catch {
          /* called from a server component — middleware handles refresh */
        }
      },
    },
  });
}
