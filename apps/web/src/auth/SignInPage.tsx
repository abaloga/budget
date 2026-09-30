import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { StatusNote } from '@/components/ui/misc';
import { isConfigured, supabase } from '@/lib/supabase';
import { errorMessage } from '@/lib/utils';

type Mode = 'sign-in' | 'sign-up' | 'magic-link';

export function SignInPage() {
  const [mode, setMode] = React.useState<Mode>('sign-in');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === 'sign-in') {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else if (mode === 'sign-up') {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: window.location.origin },
        });
        if (error) throw error;
        if (!data.session) setNotice('Check your email to confirm your account, then sign in.');
      } else {
        const { error } = await supabase.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: window.location.origin, shouldCreateUser: false },
        });
        if (error) throw error;
        setNotice('Check your email for a sign-in link.');
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2.5">
          <img src="/favicon.svg" alt="" className="size-8" />
          <span className="text-lg font-semibold tracking-tight">Budget</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {mode === 'sign-up' ? 'Create your account' : 'Welcome back'}
        </h1>
        <p className="mt-1 mb-6 text-sm text-ink-3">
          {mode === 'sign-up' ? 'Your data is private to your account.' : 'Sign in to see your money at a glance.'}
        </p>

        {!isConfigured && (
          <StatusNote tone="warn" className="mb-4">
            Supabase isn’t configured. Copy <code>apps/web/.env.example</code> to <code>apps/web/.env.local</code> and
            fill it in.
          </StatusNote>
        )}

        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field label="Email" htmlFor="email">
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          {mode !== 'magic-link' && (
            <Field
              label="Password"
              htmlFor="password"
              hint={mode === 'sign-up' ? 'At least 10 characters, letters and numbers.' : undefined}
            >
              <Input
                id="password"
                type="password"
                autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
                required
                minLength={mode === 'sign-up' ? 10 : undefined}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
          )}
          {error && <StatusNote tone="bad">{error}</StatusNote>}
          {notice && <StatusNote tone="good">{notice}</StatusNote>}
          <Button type="submit" variant="primary" size="lg" loading={busy}>
            {mode === 'sign-in' ? 'Sign in' : mode === 'sign-up' ? 'Create account' : 'Email me a link'}
          </Button>
        </form>

        <div className="mt-6 flex flex-col gap-2 text-sm text-ink-3">
          {mode !== 'magic-link' && (
            <button type="button" className="text-left hover:text-ink" onClick={() => setMode('magic-link')}>
              Sign in with an email link instead
            </button>
          )}
          {mode !== 'sign-in' && (
            <button type="button" className="text-left hover:text-ink" onClick={() => setMode('sign-in')}>
              Sign in with a password
            </button>
          )}
          {mode === 'sign-in' && (
            <button type="button" className="text-left hover:text-ink" onClick={() => setMode('sign-up')}>
              First time here? Create an account
            </button>
          )}
        </div>
      </div>
    </main>
  );
}
