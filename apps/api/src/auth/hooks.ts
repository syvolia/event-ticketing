// Fastify preHandler hooks. `requireAuth` proves the caller has a valid
// token; `requireRole` additionally proves the role is in the allowed set.
// Both throw AppError so the global error handler produces the standard
// error body — no reply.send() here, which would bypass the handler.
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { UserRole } from '@ticketing/shared';
import { forbidden, unauthenticated } from '../errors.js';

export async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  try {
    await req.jwtVerify();
  } catch {
    throw unauthenticated('Missing or invalid access token');
  }
}

export function requireRole(...allowed: UserRole[]) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    try {
      await req.jwtVerify();
    } catch {
      throw unauthenticated('Missing or invalid access token');
    }
    if (!allowed.includes(req.user.role)) {
      throw forbidden(`This endpoint requires one of: ${allowed.join(', ')}`);
    }
  };
}