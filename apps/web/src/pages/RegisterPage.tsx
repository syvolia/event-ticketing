import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { signupFormSchema, type SignupForm } from '@ticketing/shared';
import { api, ApiError } from '../lib/api.js';

interface AuthResponse {
  accessToken: string;
  expiresIn: number;
  user: { id: string; email: string; role: string; displayName: string };
}

export function RegisterPage(): JSX.Element {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const returnTo = params.get('returnTo');

  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);

  const form = useForm<SignupForm>({
    resolver: zodResolver(signupFormSchema),
    defaultValues: { email: '', displayName: '', password: '', confirmPassword: '' },
    mode: 'onBlur',
  });

  async function onSubmit(values: SignupForm): Promise<void> {
    setError(null);
    setConflict(false);
    setBusy(true);
    try {
      // The UI only ever creates attendees. Organizer and staff accounts are
      // provisioned server-side (or via curl in the demo).
      //
      // The API returns a token on success, but we deliberately do NOT store
      // it. The user is sent to the login page so they explicitly authenticate
      // — this makes the login flow the single entry point for a session, and
      // avoids a "half-registered, half-signed-in" state where a failed
      // follow-up (e.g. a crash before navigation) leaves a token in
      // localStorage that the user does not remember acquiring.
      await api<AuthResponse>('/auth/register', {
        method: 'POST',
        json: {
          email: values.email,
          password: values.password,
          displayName: values.displayName,
          role: 'attendee',
        },
      });

      // Build the login URL:
      //   - returnTo, if the user came from a protected page
      //   - registered=1, so the login page shows "Account created."
      //   - email, so the login form is pre-filled
      const qs = new URLSearchParams();
      if (returnTo) qs.set('returnTo', returnTo);
      qs.set('registered', '1');
      qs.set('email', values.email);
      navigate(`/login?${qs.toString()}`, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setConflict(true);
        setError('An account with that email already exists.');
      } else if (err instanceof ApiError && err.status === 400) {
        const details = err.details as { fieldErrors?: Record<string, string[]> } | undefined;
        const firstField = details?.fieldErrors && Object.keys(details.fieldErrors)[0];
        const firstMsg = firstField ? details.fieldErrors![firstField]![0] : null;
        setError(firstMsg ?? 'Please check the form and try again.');
      } else {
        setError((err as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }

  const loginHref = returnTo ? `/login?returnTo=${encodeURIComponent(returnTo)}` : '/login';

  return (
    <main className="mx-auto max-w-sm py-8">
      <h1 className="text-2xl font-bold">Create your account</h1>
      <p className="mt-1 text-sm text-neutral-500">Buy tickets and see them in one place.</p>

      <form className="mt-6 space-y-3" onSubmit={form.handleSubmit(onSubmit)} noValidate>
        <div>
          <label className="label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            type="email"
            className="input"
            autoComplete="email"
            {...form.register('email')}
          />
          {form.formState.errors.email ? (
            <p className="mt-1 text-xs text-danger">{form.formState.errors.email.message}</p>
          ) : null}
        </div>

        <div>
          <label className="label" htmlFor="displayName">
            Your name
          </label>
          <input
            id="displayName"
            type="text"
            className="input"
            autoComplete="name"
            {...form.register('displayName')}
          />
          {form.formState.errors.displayName ? (
            <p className="mt-1 text-xs text-danger">{form.formState.errors.displayName.message}</p>
          ) : null}
        </div>

        <div>
          <label className="label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            type="password"
            className="input"
            autoComplete="new-password"
            {...form.register('password')}
          />
          {form.formState.errors.password ? (
            <p className="mt-1 text-xs text-danger">{form.formState.errors.password.message}</p>
          ) : (
            <p className="mt-1 text-[11px] text-neutral-600">At least 10 characters.</p>
          )}
        </div>

        <div>
          <label className="label" htmlFor="confirmPassword">
            Confirm password
          </label>
          <input
            id="confirmPassword"
            type="password"
            className="input"
            autoComplete="new-password"
            {...form.register('confirmPassword')}
          />
          {form.formState.errors.confirmPassword ? (
            <p className="mt-1 text-xs text-danger">
              {form.formState.errors.confirmPassword.message}
            </p>
          ) : null}
        </div>

        {error ? (
          <div className="rounded-lg bg-danger/10 p-3 text-xs text-danger">
            <p>{error}</p>
            {conflict ? (
              <p className="mt-2">
                <Link to={loginHref} className="font-semibold underline">
                  Sign in instead
                </Link>
              </p>
            ) : null}
          </div>
        ) : null}

        <button type="submit" className="btn-primary w-full" disabled={busy}>
          {busy ? 'Creating account…' : 'Create account'}
        </button>
      </form>

      <p className="mt-6 text-center text-xs text-neutral-500">
        Already have an account?{' '}
        <Link to={loginHref} className="text-accent underline">
          Sign in
        </Link>
      </p>
    </main>
  );
}
