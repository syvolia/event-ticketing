// Auth helpers that sit above the raw token storage in lib/api.ts.
//
// The API uses stateless JWTs: logout is a client-side action. We clear the
// token so this browser cannot use it again. The token itself remains valid
// on the server until its `exp` claim (30 minutes from issue). That is fine
// for this project — a production app would use short-lived access tokens
// (5–15 min) with refresh tokens, or maintain a revocation list. If a token
// is stolen before logout, clearing it on one device does nothing on another.
//
// The TanStack Query cache is also cleared on logout. Without this, another
// user signing in on the same browser would briefly see the previous user's
// tickets, orders, or payments from the cache before the fresh fetch lands.
// That is not just a UX wart — it is an information leak.
import { queryClient } from './queryClient.js';
import { setToken } from './api.js';

export function logout(): void {
  setToken(null);
  queryClient.clear();
}

export function isAuthenticated(): boolean {
  // Reading localStorage is synchronous. The header calls this on every
  // render, and because navigation triggers re-render, a logout that
  // navigates is reflected immediately.
  return localStorage.getItem('ticketing.token') !== null;
}