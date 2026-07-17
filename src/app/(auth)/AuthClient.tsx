'use client';

// One component, three modes: login, signup, reset. Supabase handles the
// mechanics (sessions, confirmation emails, recovery links); these pages are
// deliberately thin over it.
//
// The one piece of app logic: after ANY successful sign-in, claimAnonWork()
// attaches this browser's anonymous uploads to the account — the moment
// claim_anon_projects() was built for. It runs on login too, not just
// signup: a visitor who uploads anonymously and then remembers they already
// have an account must not lose their work.

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase/client';
import { claimAnonWork } from '@/lib/auth/claim';

type Mode = 'login' | 'signup' | 'reset';

const COPY: Record<Mode, { title: string; cta: string }> = {
  login: { title: 'Sign in', cta: 'Sign in' },
  signup: { title: 'Create your account', cta: 'Create account' },
  reset: { title: 'Reset your password', cta: 'Send reset link' },
};

export default function AuthClient({ mode }: { mode: Mode }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      let supabase;
      try {
        supabase = supabaseBrowser();
      } catch {
        setMessage({
          kind: 'info',
          text: 'Accounts are not available on this demo deployment — connect Supabase to enable them.',
        });
        return;
      }

      if (mode === 'reset') {
        const site = window.location.origin;
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${site}/login`,
        });
        if (error) throw error;
        setMessage({
          kind: 'info',
          text: 'If that address has an account, a reset link is on its way.',
        });
        return;
      }

      if (mode === 'signup') {
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        if (!data.session) {
          // Email confirmation is on: the account exists but there's no
          // session yet. The anon claim will run on first sign-in instead.
          setMessage({
            kind: 'info',
            text: 'Check your email to confirm your account, then sign in.',
          });
          return;
        }
        await claimAnonWork(supabase);
        router.push('/studio');
        return;
      }

      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      await claimAnonWork(supabase);
      router.push('/studio');
    } catch (err) {
      // Supabase auth errors are already user-safe ("Invalid login
      // credentials") — pass them through rather than inventing vaguer ones.
      setMessage({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Something went wrong. Try again.',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-6">
      <h1 className="text-2xl font-bold tracking-tight">{COPY[mode].title}</h1>

      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-600">Email</span>
          <input
            type="email"
            required
            autoComplete="email"
            className="rounded-lg border border-neutral-300 p-2"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>

        {mode !== 'reset' && (
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-600">Password</span>
            <input
              type="password"
              required
              minLength={8}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              className="rounded-lg border border-neutral-300 p-2"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        )}

        <button
          type="submit"
          disabled={busy}
          className="mt-2 rounded-xl bg-neutral-900 px-6 py-3 font-medium text-white transition-opacity disabled:opacity-40"
        >
          {busy ? 'One moment…' : COPY[mode].cta}
        </button>
      </form>

      {message && (
        <p className={`text-sm ${message.kind === 'error' ? 'text-red-600' : 'text-neutral-700'}`}>
          {message.text}
        </p>
      )}

      <p className="text-sm text-neutral-500">
        {mode === 'login' && (
          <>
            No account?{' '}
            <Link className="underline" href="/signup">
              Create one
            </Link>{' '}
            ·{' '}
            <Link className="underline" href="/reset">
              Forgot password
            </Link>
          </>
        )}
        {mode === 'signup' && (
          <>
            Already have an account?{' '}
            <Link className="underline" href="/login">
              Sign in
            </Link>
          </>
        )}
        {mode === 'reset' && (
          <>
            Remembered it?{' '}
            <Link className="underline" href="/login">
              Sign in
            </Link>
          </>
        )}
      </p>
    </main>
  );
}
