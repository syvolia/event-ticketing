// Single fetch wrapper. All requests go to VITE_API_URL directly. In dev, the
// API is on a different origin (http://localhost:3000) than the scanner
// (https://<lan-ip>:5173), so the API's CORS settings must allow the scanner
// origin; the API enables permissive CORS in dev only.
const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3000';

const TOKEN_KEY = 'ticketing.token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiOptions extends Omit<RequestInit, 'body'> {
  /** Serialized as JSON. Mutually exclusive with `body`. */
  json?: unknown;
  /** Raw body. Used when the caller already has a Blob, FormData, etc. */
  body?: BodyInit | null;
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.json !== undefined) headers.set('content-type', 'application/json');
  const token = getToken();
  if (token) headers.set('authorization', `Bearer ${token}`);

  // Build the RequestInit conditionally. Under exactOptionalPropertyTypes,
  // `body: undefined` is not assignable to `RequestInit.body` (which is
  // typed `BodyInit | null`). The property must be *absent* to mean "no
  // body", so we only add it when the caller actually supplied something.
  const init: RequestInit = {
    ...options,
    headers,
  };
  delete (init as { json?: unknown }).json;
  if (options.json !== undefined) {
    init.body = JSON.stringify(options.json);
  } else if (options.body !== undefined) {
    init.body = options.body;
  } else {
    delete (init as { body?: unknown }).body;
  }

  const res = await fetch(`${BASE}${path}`, init);

  const text = await res.text();
  const parsed: unknown = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const err = parsed as { error?: { code?: string; message?: string; details?: unknown } } | null;
    throw new ApiError(
      res.status,
      err?.error?.code ?? 'HTTP_ERROR',
      err?.error?.message ?? `Request failed with ${res.status}`,
      err?.error?.details,
    );
  }
  return parsed as T;
}

export const API_BASE = BASE;