import type { FastifyInstance } from 'fastify';
import {
  createOrderInputSchema,
  idempotencyKeySchema,
} from '@ticketing/shared';
import { z } from 'zod';
import { requireAuth } from '../auth/hooks.js';
import { AppError, badRequest } from '../errors.js';
import { RATE_LIMITS } from '../plugins/rateLimit.js';
import { createOrder, getOrderForBuyer } from '../services/orders.js';
import {
  orderCreateDuration,
  ordersCreated,
  reservationConflicts,
} from '../metrics.js';

const uuidParam = z.string().uuid();

export async function registerOrderRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/orders',
    { preHandler: requireAuth, config: { rateLimit: RATE_LIMITS.createOrder } },
    async (req, reply) => {
      const rawKey = req.headers['idempotency-key'];
      if (typeof rawKey !== 'string' || rawKey.length === 0) {
        throw badRequest('Idempotency-Key header is required');
      }
      const idempotencyKey = idempotencyKeySchema.parse(rawKey);
      const body = createOrderInputSchema.parse(req.body);
      req.attachLogContext({
        userId: req.user.sub,
        eventId: body.eventId,
        idempotencyKey,
      });

      const timer = orderCreateDuration.startTimer();
      try {
        const result = await createOrder(req.user.sub, body, idempotencyKey);
        // Only count genuinely new orders. The idempotency fast-path returns
        // `created: false`, which must not inflate the counter.
        if (result.created) {
          ordersCreated.inc({ event_tier_count: String(body.items.length) });
        }
        req.attachLogContext({ orderId: result.order.id });
        // 201 on a fresh create; 200 on an idempotent replay. Same body
        // either way. A client retrying with the same key gets an idempotent
        // success, not a 409.
        reply.code(result.created ? 201 : 200);
        return { order: result.order };
      } catch (err) {
        // The inventory predicate throws AppError(409, CONFLICT) with a
        // `reason` in details. Route-level catch keeps the metric local to
        // where the reason is known.
        if (err instanceof AppError && err.statusCode === 409) {
          const details = err.details as { reason?: string } | undefined;
          const reason = details?.reason ?? 'UNKNOWN';
          reservationConflicts.inc({ reason });
        }
        throw err;
      } finally {
        timer();
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    '/orders/:id',
    { preHandler: requireAuth },
    async (req) => {
      const id = uuidParam.parse(req.params.id);
      req.attachLogContext({ userId: req.user.sub, orderId: id });
      return { order: await getOrderForBuyer(req.user.sub, id) };
    },
  );
}