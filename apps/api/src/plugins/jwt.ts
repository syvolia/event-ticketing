// Registers @fastify/jwt at the root scope. fastify-plugin breaks plugin
// encapsulation so `app.jwt.sign()` and `req.jwtVerify()` are visible to every
// route. Without fp, the decoration would only exist inside the plugin's own
// child scope and route handlers would blow up with "req.jwtVerify is not a
// function".
import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import type { UserRole } from '@ticketing/shared';
import { config } from '../config.js';

// Module augmentation: tells @fastify/jwt the shape of our token. Anything we
// sign must match `payload`; anything after `jwtVerify()` is `user`. The `sub`
// claim is standard; the role is our own addition so authorization checks do
// not need a DB round-trip on every request.
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; role: UserRole; email: string };
    user: { sub: string; role: UserRole; email: string; iat: number; exp: number };
  }
}

export default fp(
  async (app) => {
    await app.register(fastifyJwt, {
      secret: config.JWT_SECRET,
      // Explicit algorithm — do not rely on the default. HS256 with a strong
      // symmetric secret is fine here; if we ever needed public-key verify
      // (e.g. third-party issuers), switch to RS256 and expose the JWKS.
      sign: { algorithm: 'HS256' },
      verify: { algorithms: ['HS256'] },
    });
  },
  { name: 'jwt' },
);