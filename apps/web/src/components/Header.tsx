import { Link, useLocation, useNavigate } from 'react-router-dom';
import { isAuthenticated, logout } from '../lib/auth.js';

export function Header(): JSX.Element {
  const loc = useLocation();
  const navigate = useNavigate();
  const authed = isAuthenticated();
  const onScan = loc.pathname.startsWith('/scan');
  // On the login page itself, a "Sign in" link is redundant — it would
  // navigate to the page the user is already on. Hiding it removes a dead
  // affordance. Everywhere else, an unauthenticated user needs the link, so
  // it stays visible.
  const onLogin = loc.pathname === '/login';

  function onSignOut(): void {
    logout();
    // Sign-out lands on the login page, not the home page. The user
    // explicitly ended their session, so the most useful next step is the
    // place to start a new one.
    //
    // `replace: true` so the browser Back button does not return to the
    // authenticated page the user just left. Without it, hitting Back would
    // re-render the previous route with no token — usually a flash of
    // "Loading…" followed by another redirect to /login, which is more
    // confusing than helpful.
    navigate('/login', { replace: true });
  }

  return (
    <header className="sticky top-0 z-20 border-b border-edge bg-ink/95 backdrop-blur">
      <div className="mx-auto flex max-w-md items-center justify-between px-4 py-3">
        <Link to="/" className="text-lg font-bold tracking-tight">
          Ticketing
        </Link>
        <nav className="flex items-center gap-3 text-sm">
          {authed ? (
            <>
              <Link to="/tickets" className="text-neutral-300 hover:text-white">
                My tickets
              </Link>
              <button
                type="button"
                onClick={onSignOut}
                className="text-neutral-500 hover:text-neutral-300"
              >
                Sign out
              </button>
            </>
          ) : onLogin ? null : (
            <Link to="/login" className="text-neutral-300 hover:text-white">
              Sign in
            </Link>
          )}
          {!onScan ? (
            <Link
              to="/scan"
              className="rounded-md border border-edge px-2 py-1 text-xs text-neutral-300 hover:text-white"
            >
              Scanner
            </Link>
          ) : null}
        </nav>
      </div>
    </header>
  );
}
