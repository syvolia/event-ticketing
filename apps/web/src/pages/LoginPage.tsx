import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, setToken } from '../lib/api.js';

interface AuthResponse {
  accessToken: string;
  expiresIn: number;
  user: { id: string; email: string; role: string; displayName: string };
}

export function LoginPage(): JSX.Element {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const returnTo = params.get('returnTo');
  const justRegistered = params.get('registered') === '1';
  const prefillEmail = params.get('email') ?? '';

  const [email, setEmail] = useState(prefillEmail);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await api<AuthResponse>('/auth/login', {
        method: 'POST',
        json: { email, password },
      });
      setToken(res.accessToken);
      // If we arrived here from a redirect (e.g. an unauthenticated attempt
      // to reach /checkout/:id), honor that target. Otherwise route by role:
      // staff and organizers land on the scanner, attendees land on the
      // buyer home.
      if (returnTo) {
        navigate(returnTo, { replace: true });
      } else if (res.user.role === 'staff' || res.user.role === 'organizer') {
        navigate('/scan');
      } else {
        navigate('/');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Preserve returnTo when linking to sign-up, so a buyer who was trying to
  // reach /checkout lands back there after creating an account and signing in.
  const signupHref = returnTo ? `/register?returnTo=${encodeURIComponent(returnTo)}` : '/register';

  return (
    <main className="mx-auto max-w-sm py-8">
      <h1 className="text-2xl font-bold">Sign in</h1>
      <p className="mt-1 text-sm text-neutral-500">Sign in to buy tickets or scan.</p>

      {justRegistered ? (
        <div className="mt-4 rounded-lg bg-accent/10 p-3 text-sm text-accent">
          Account created. Sign in to continue.
        </div>
      ) : null}

      <form className="mt-6 space-y-3" onSubmit={onSubmit}>
        <div>
          <label className="label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            type="email"
            className="input"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            type="password"
            className="input"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            // Auto-focus the password when the email is pre-filled from the
            // register redirect — saves one tap and signals "you're almost there".
            autoFocus={Boolean(prefillEmail)}
          />
        </div>
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        <button type="submit" className="btn-primary w-full" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <p className="mt-6 text-center text-xs text-neutral-500">
        New here?{' '}
        <Link to={signupHref} className="text-accent underline">
          Create an account
        </Link>
      </p>
    </main>
  );
}
