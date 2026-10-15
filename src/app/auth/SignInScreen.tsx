import { useState, type FormEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Alert, Field } from '@/components/ui';

type Mode = 'sign_in' | 'sign_up' | 'reset';

const MIN_PASSWORD = 10;

function friendlyAuthError(message: string): string {
  if (/invalid login credentials/i.test(message))
    return 'That email and password don’t match an account.';
  if (/email not confirmed/i.test(message))
    return 'Confirm your email address first — check your inbox for the link.';
  if (/signups not allowed|signup is disabled/i.test(message))
    return 'New accounts are switched off for this app.';
  if (/password/i.test(message) && /(weak|characters|should)/i.test(message)) return message;
  if (/fetch|network/i.test(message))
    return 'Can’t reach the server. Check your connection and try again.';
  if (/rate limit|too many/i.test(message))
    return 'Too many attempts. Wait a minute and try again.';
  return message;
}

export function SignInScreen({ client }: { client: SupabaseClient }) {
  const [mode, setMode] = useState<Mode>('sign_in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const trimmed = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError('Enter a valid email address.');
      return;
    }
    if (mode !== 'reset' && password.length < (mode === 'sign_up' ? MIN_PASSWORD : 1)) {
      setError(
        mode === 'sign_up'
          ? `Use at least ${MIN_PASSWORD} characters, with upper- and lower-case letters and a number.`
          : 'Enter your password.',
      );
      return;
    }
    setBusy(true);
    try {
      if (mode === 'sign_in') {
        const { error: err } = await client.auth.signInWithPassword({ email: trimmed, password });
        if (err) throw err;
      } else if (mode === 'sign_up') {
        const { data, error: err } = await client.auth.signUp({
          email: trimmed,
          password,
          options: { emailRedirectTo: window.location.origin },
        });
        if (err) throw err;
        if (!data.session) {
          setNotice('Account created. Check your email for the confirmation link, then sign in.');
          setMode('sign_in');
        }
      } else {
        const { error: err } = await client.auth.resetPasswordForEmail(trimmed, {
          redirectTo: window.location.origin,
        });
        if (err) throw err;
        setNotice('If that email has an account, a password-reset link is on its way.');
        setMode('sign_in');
      }
    } catch (err) {
      const message =
        typeof err === 'object' && err !== null && 'message' in err
          ? String(err.message)
          : String(err);
      setError(friendlyAuthError(message));
    } finally {
      setBusy(false);
    }
  }

  const title =
    mode === 'sign_in'
      ? 'Sign in'
      : mode === 'sign_up'
        ? 'Create your account'
        : 'Reset your password';
  return (
    <main className="auth-screen">
      <form
        className="card form auth-card"
        onSubmit={submit}
        noValidate
        aria-labelledby="auth-title"
      >
        <div>
          <p className="muted small">Personal Finance Hub</p>
          <h1 id="auth-title">{title}</h1>
          <p className="small muted">
            Signing in keeps your budget in sync between your PC and phone. Your records are stored
            in your own account and are only visible when you’re signed in.
          </p>
        </div>
        {notice && <Alert tone="success">{notice}</Alert>}
        {error && <Alert tone="negative">{error}</Alert>}
        <Field label="Email" htmlFor="auth-email">
          <input
            id="auth-email"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        {mode !== 'reset' && (
          <Field
            label="Password"
            htmlFor="auth-password"
            hint={
              mode === 'sign_up'
                ? `At least ${MIN_PASSWORD} characters with upper- and lower-case letters and a number.`
                : undefined
            }
          >
            <input
              id="auth-password"
              type="password"
              autoComplete={mode === 'sign_up' ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
        )}
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy
            ? 'Please wait…'
            : mode === 'sign_in'
              ? 'Sign in'
              : mode === 'sign_up'
                ? 'Create account'
                : 'Send reset link'}
        </button>
        <div className="btn-row">
          {mode !== 'sign_in' && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setMode('sign_in')}
            >
              I have an account
            </button>
          )}
          {mode !== 'sign_up' && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setMode('sign_up')}
            >
              Create an account
            </button>
          )}
          {mode !== 'reset' && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMode('reset')}>
              Forgot password?
            </button>
          )}
        </div>
      </form>
    </main>
  );
}

export function SetNewPassword({ client, onDone }: { client: SupabaseClient; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password.length < MIN_PASSWORD) {
      setError(
        `Use at least ${MIN_PASSWORD} characters, with upper- and lower-case letters and a number.`,
      );
      return;
    }
    setBusy(true);
    const { error: err } = await client.auth.updateUser({ password });
    setBusy(false);
    if (err) setError(friendlyAuthError(err.message));
    else onDone();
  }
  return (
    <main className="auth-screen">
      <form
        className="card form auth-card"
        onSubmit={submit}
        noValidate
        aria-labelledby="newpw-title"
      >
        <h1 id="newpw-title">Choose a new password</h1>
        {error && <Alert tone="negative">{error}</Alert>}
        <Field label="New password" htmlFor="new-password">
          <input
            id="new-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          Save new password
        </button>
      </form>
    </main>
  );
}
