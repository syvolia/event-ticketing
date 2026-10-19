import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { getToken } from '../lib/api.js';

export function RequireAuth(): JSX.Element {
  const token = getToken();
  const location = useLocation();

  if (!token) {
    // Redirect to login, but save the page they were trying to visit so
    // they can be sent right back after a successful login.
    const returnTo = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?returnTo=${returnTo}`} replace />;
  }

  // If they have a token, render the child route (e.g., HomePage).
  return <Outlet />;
}
