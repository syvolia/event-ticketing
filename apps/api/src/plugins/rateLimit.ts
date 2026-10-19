// Rate limiting strategy: two-tier.
//
//  - Per-user for authenticated routes (keyed by req.user.sub). One buyer
//    cannot exhaust a shared IP limit by having 50 tabs open; each account
//    has its own bucket.
//  - Per-IP for unauthenticated routes (login, register). An attacker
//    spraying credentials from one IP hits the limit regardless of the
//    accounts they try.
//
// We apply limits at ROUTE level, not globally. A read-heavy GET /events is
// cheap to serve and does not need to compete with POST /orders for a shared
// bucket. Routes declare their own config; the global registration sets
// shared defaults (keyGenerator, error response shape).
//
// The limiter uses @fastify/rate-limit's in-memory store. That is fine for a
// single-instance deployment. For multi-instance we would swap the store for
// the Redis backend (@fastify/rate-limit supports it transparently) — a
// change of one option, no route code needs to move.
//
// DISABLED IN TESTS: @fastify/rate-limit@8 does not have an `enabled` option
// on the plugin registration. We therefore skip registration entirely when
// config.RATE_LIMIT_ENABLED is false. The per-route `config: { rateLimit:
// ... }` declarations become inert passthroughs that no plugin reads — the
// concurrency suite can fire 200 requests in a tight loop without being
// throttled.
import fp from 'fastify-plugin';
import rateLimit from '@fastify/rate-limit';
import { config } from '../config.js';

export default fp(
  async (app) => {
    if (!config.RATE_LIMIT_ENABLED) {
      app.log.info('rate limiting disabled via RATE_LIMIT_ENABLED=false');
      return;
    }

    await app.register(rateLimit, {
      global: false,
      // The keyGenerator runs per request. It prefers the authenticated user
      // id when present, and falls back to the IP otherwise. Fastify's
      // `req.ip` respects `trustProxy` (set on the Fastify instance in
      // server.ts), so behind a load balancer it is the real client IP,
      // not the balancer's.
      keyGenerator: (req) => {
        const user = (req as { user?: { sub?: string } }).user;
        if (user?.sub) return `u:${user.sub}`;
        return `ip:${req.ip}`;
      },
      // The error response must match the API's standard shape:
      //   { error: { code, message, details? } }
      // Otherwise the client's `api()` wrapper would treat a 429 like an
      // opaque HTTP error instead of a first-class `RATE_LIMITED`.
      errorResponseBuilder: (_req, context) => ({
        error: {
          code: 'RATE_LIMITED',
          message: `Too many requests. Retry in ${Math.ceil(context.ttl / 1000)}s.`,
          details: { limit: context.max, ttlMs: context.ttl },
        },
      }),
    });
  },
  { name: 'rate-limit' },
);

// Per-route limits, exported so routes can import the exact policy they want.
export const RATE_LIMITS = {
  // Login is unauthenticated and worth brute-forcing. 10 attempts per 15 min
  // per IP is aggressive but does not break a legitimate user who fat-fingers
  // their password twice.
  login: { max: 10, timeWindow: '15 minutes' },

  // Registration is also unauthenticated. Similar budget.
  register: { max: 20, timeWindow: '15 minutes' },

  // Checkout is authenticated and inventory-affecting. 30 per minute is well
  // above a genuine human checkout pace but blocks a scripted oversell.
  createOrder: { max: 30, timeWindow: '1 minute' },

  // Payment initiation hits an external provider. Cap to protect Daraja from
  // us, and to blunt a user who retries aggressively.
  startPayment: { max: 10, timeWindow: '1 minute' },

  // Check-in is authenticated (staff role) but a malfunctioning scanner can
  // retry in a loop. Sync batches are large, so the count is per request,
  // not per scan.
  checkin: { max: 120, timeWindow: '1 minute' },
  checkinSync: { max: 30, timeWindow: '1 minute' },

  // Public reads. Generous, but not unlimited.
  publicRead: { max: 300, timeWindow: '1 minute' },
} as const;