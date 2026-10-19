import fp from 'fastify-plugin';
import helmet from '@fastify/helmet';
import fastifyCors from '@fastify/cors';
import { config } from '../config.js';

export default fp(
  async (app) => {
    // Helmet sets a standard set of security headers: HSTS, X-Content-Type-
    // Options, X-Frame-Options, Referrer-Policy, etc. The API does not serve
    // HTML, so CSP is largely irrelevant here — it is the web app's job.
    // We still enable Helmet's non-CSP defaults because they cost nothing and
    // protect against content-sniffing and framing attacks on any route that
    // might reflect content.
    await app.register(helmet, {
      // HSTS: one year, include subdomains. Browsers will refuse plain HTTP
      // to this host for the next year. Only enable in production — in dev
      // we are on http://localhost and HSTS would poison the browser's
      // cache for localhost.
      hsts: config.NODE_ENV === 'production'
        ? { maxAge: 31_536_000, includeSubDomains: true, preload: true }
        : false,
      // We do not serve HTML from the API, so CSP is disabled.
      contentSecurityPolicy: false,
      // The scanner and web app are separate origins in dev; in prod they
      // may be same-origin or a known CDN. We are explicit.
      crossOriginResourcePolicy: { policy: 'same-site' },
    });

    // CORS. Same pattern as before: reflect in dev, allowlist in prod. The
    // allowlist is a comma-separated env value so a staging deploy can
    // include both the main app and the scanner origins.
    const prodOrigins = config.PUBLIC_APP_URL.split(',').map((s) => s.trim()).filter(Boolean);
    await app.register(fastifyCors, {
      origin: config.NODE_ENV === 'production' ? prodOrigins : true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['content-type', 'authorization', 'idempotency-key', 'x-request-id'],
      exposedHeaders: ['x-request-id'],
      credentials: false,
      maxAge: 600,
    });
  },
  { name: 'security' },
);