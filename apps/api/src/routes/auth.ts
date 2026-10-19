import type { FastifyInstance } from 'fastify';
import { loginInputSchema, registerInputSchema } from '@ticketing/shared';
import { requireAuth } from '../auth/hooks.js';
import { unauthenticated } from '../errors.js';
import { RATE_LIMITS } from '../plugins/rateLimit.js';
import { authenticate, createUser, getUserById } from '../services/users.js';

const ACCESS_TOKEN_TTL_SECONDS = 30 * 60;

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  // Rate-limited per IP (no user context yet). 20/15min is enough for a
  // legitimate user who mistypes their email; low enough to stop a spray.
  app.post(
    '/auth/register',
    { config: { rateLimit: RATE_LIMITS.register } },
    async (req, reply) => {
      const body = registerInputSchema.parse(req.body);
      const user = await createUser(body);
      req.attachLogContext({ userId: user.id, role: user.role });
      const accessToken = app.jwt.sign(
        { sub: user.id, role: user.role, email: user.email },
        { expiresIn: ACCESS_TOKEN_TTL_SECONDS },
      );
      reply.code(201);
      return {
        accessToken,
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          displayName: user.displayName,
        },
      };
    },
  );

  // Rate-limited per IP. 10/15min is the classic login brute-force budget.
  app.post(
    '/auth/login',
    { config: { rateLimit: RATE_LIMITS.login } },
    async (req) => {
      const body = loginInputSchema.parse(req.body);
      const user = await authenticate(body.email, body.password);
      // Identical error for unknown email and wrong password — do not give an
      // attacker an oracle to enumerate accounts.
      if (!user) throw unauthenticated('Invalid email or password');
      req.attachLogContext({ userId: user.id, role: user.role });
      const accessToken = app.jwt.sign(
        { sub: user.id, role: user.role, email: user.email },
        { expiresIn: ACCESS_TOKEN_TTL_SECONDS },
      );
      return {
        accessToken,
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          displayName: user.displayName,
        },
      };
    },
  );

  app.get('/auth/me', { preHandler: requireAuth }, async (req) => {
    // Re-read the user from the DB so a deleted account does not continue to
    // authenticate against a still-valid token.
    const user = await getUserById(req.user.sub);
    if (!user) throw unauthenticated('Account no longer exists');
    req.attachLogContext({ userId: user.id, role: user.role });
    return {
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        displayName: user.displayName,
      },
    };
  });
}