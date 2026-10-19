import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createEventInputSchema,
  createTierInputSchema,
  updateEventInputSchema,
  updateTierInputSchema,
} from '@ticketing/shared';
import { requireRole } from '../auth/hooks.js';
import { RATE_LIMITS } from '../plugins/rateLimit.js';
import {
  cancelEvent,
  createEvent,
  getPublicEvent,
  listOrganizerEvents,
  listPublicEvents,
  publishEvent,
  updateEvent,
} from '../services/events.js';
import { createTier, updateTier } from '../services/tiers.js';

const uuidParam = z.string().uuid();

export async function registerEventRoutes(app: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------------
  // Public catalog — no auth. Rate-limited per IP so a scraper cannot drown
  // the DB. 300/min is generous for a single user; blocks aggressive crawls.
  // ---------------------------------------------------------------------
  app.get(
    '/events',
    { config: { rateLimit: RATE_LIMITS.publicRead } },
    async () => ({ events: await listPublicEvents() }),
  );

  app.get<{ Params: { id: string } }>(
    '/events/:id',
    { config: { rateLimit: RATE_LIMITS.publicRead } },
    async (req) => {
      const id = uuidParam.parse(req.params.id);
      return { event: await getPublicEvent(id) };
    },
  );

  // ---------------------------------------------------------------------
  // Organizer: own events (including drafts).
  // ---------------------------------------------------------------------
  app.get('/organizer/events', { preHandler: requireRole('organizer') }, async (req) => {
    req.attachLogContext({ userId: req.user.sub });
    return { events: await listOrganizerEvents(req.user.sub) };
  });

  app.post('/events', { preHandler: requireRole('organizer') }, async (req, reply) => {
    const body = createEventInputSchema.parse(req.body);
    const event = await createEvent(req.user.sub, body);
    req.attachLogContext({ userId: req.user.sub, eventId: event.id });
    reply.code(201);
    return { event };
  });

  app.patch<{ Params: { id: string } }>(
    '/events/:id',
    { preHandler: requireRole('organizer') },
    async (req) => {
      const id = uuidParam.parse(req.params.id);
      req.attachLogContext({ userId: req.user.sub, eventId: id });
      const patch = updateEventInputSchema.parse(req.body);
      return { event: await updateEvent(req.user.sub, id, patch) };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/events/:id/publish',
    { preHandler: requireRole('organizer') },
    async (req) => {
      const id = uuidParam.parse(req.params.id);
      req.attachLogContext({ userId: req.user.sub, eventId: id });
      return { event: await publishEvent(req.user.sub, id) };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/events/:id/cancel',
    { preHandler: requireRole('organizer') },
    async (req) => {
      const id = uuidParam.parse(req.params.id);
      req.attachLogContext({ userId: req.user.sub, eventId: id });
      return { event: await cancelEvent(req.user.sub, id) };
    },
  );

  // ---------------------------------------------------------------------
  // Tiers
  // ---------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/events/:id/tiers',
    { preHandler: requireRole('organizer') },
    async (req, reply) => {
      const eventId = uuidParam.parse(req.params.id);
      req.attachLogContext({ userId: req.user.sub, eventId });
      const body = createTierInputSchema.parse(req.body);
      const tier = await createTier(req.user.sub, eventId, body);
      reply.code(201);
      return { tier };
    },
  );

  app.patch<{ Params: { tierId: string } }>(
    '/tiers/:tierId',
    { preHandler: requireRole('organizer') },
    async (req) => {
      const tierId = uuidParam.parse(req.params.tierId);
      req.attachLogContext({ userId: req.user.sub, tierId });
      const patch = updateTierInputSchema.parse(req.body);
      return { tier: await updateTier(req.user.sub, tierId, patch) };
    },
  );
}