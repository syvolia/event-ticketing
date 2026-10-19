import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { voidTicketInputSchema } from '@ticketing/shared';
import { requireAuth, requireRole } from '../auth/hooks.js';
import { badRequest } from '../errors.js';
import { RATE_LIMITS } from '../plugins/rateLimit.js';
import { generatePng, generateSvg } from '../qr/generator.js';
import {
  getTicketForUser,
  listTicketsForBuyer,
  voidTicket,
} from '../services/tickets.js';

const uuidParam = z.string().uuid();

export async function registerTicketRoutes(app: FastifyInstance): Promise<void> {
  // Buyer's tickets. Includes qrPayload so the client can render its own code.
  app.get(
    '/tickets',
    { preHandler: requireAuth, config: { rateLimit: RATE_LIMITS.publicRead } },
    async (req) => {
      req.attachLogContext({ userId: req.user.sub });
      return { tickets: await listTicketsForBuyer(req.user.sub) };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/tickets/:id',
    { preHandler: requireAuth },
    async (req) => {
      const id = uuidParam.parse(req.params.id);
      req.attachLogContext({ userId: req.user.sub, ticketId: id });
      return { ticket: await getTicketForUser(id, req.user.sub, req.user.role) };
    },
  );

  // QR image. `?format=png` for raster; default SVG. The payload is signed
  // server-side and never re-signed here, so what this returns is exactly what
  // was issued — verification will succeed even after a signing-key rotation.
  app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    '/tickets/:id/qr',
    { preHandler: requireAuth, config: { rateLimit: RATE_LIMITS.publicRead } },
    async (req, reply) => {
      const id = uuidParam.parse(req.params.id);
      const format = req.query.format ?? 'svg';
      if (format !== 'svg' && format !== 'png') {
        throw badRequest('format must be svg or png');
      }
      req.attachLogContext({ userId: req.user.sub, ticketId: id, format });
      const ticket = await getTicketForUser(id, req.user.sub, req.user.role);
      if (format === 'png') {
        const png = await generatePng(ticket.qrPayload);
        reply.header('content-type', 'image/png');
        reply.header('cache-control', 'private, max-age=60');
        return reply.send(png);
      }
      const svg = await generateSvg(ticket.qrPayload);
      reply.header('content-type', 'image/svg+xml');
      reply.header('cache-control', 'private, max-age=60');
      return reply.send(svg);
    },
  );

  // Organizer-only. Voids a ticket so it fails validation at the door.
  app.post<{ Params: { id: string } }>(
    '/tickets/:id/void',
    { preHandler: requireRole('organizer') },
    async (req) => {
      const id = uuidParam.parse(req.params.id);
      req.attachLogContext({ userId: req.user.sub, ticketId: id });
      const body = voidTicketInputSchema.parse(req.body);
      return { ticket: await voidTicket(id, req.user.sub, body.reason) };
    },
  );
}