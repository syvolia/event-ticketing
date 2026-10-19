import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { startPaymentInputSchema } from '@ticketing/shared';
import { requireAuth } from '../auth/hooks.js';
import { badRequest } from '../errors.js';
import { RATE_LIMITS } from '../plugins/rateLimit.js';
import { getPaymentForBuyer, startPayment } from '../services/payments.js';
import { paymentInitiateDuration } from '../metrics.js';

const uuidParam = z.string().uuid();

export async function registerPaymentRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string } }>(
    '/orders/:id/pay',
    { preHandler: requireAuth, config: { rateLimit: RATE_LIMITS.startPayment } },
    async (req, reply) => {
      const orderId = uuidParam.parse(req.params.id);
      const rawKey = req.headers['idempotency-key'];
      if (typeof rawKey !== 'string' || rawKey.length === 0) {
        throw badRequest('Idempotency-Key header is required');
      }
      const body = startPaymentInputSchema.parse(req.body ?? {});
      req.attachLogContext({
        userId: req.user.sub,
        orderId,
        provider: body.provider,
      });

      const timer = paymentInitiateDuration.startTimer({ provider: body.provider });
      try {
        const result = await startPayment(req.user.sub, orderId, body);
        req.attachLogContext({ paymentId: result.payment.id });
        reply.code(result.created ? 201 : 200);
        return { payment: result.payment };
      } finally {
        timer();
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    '/payments/:id',
    { preHandler: requireAuth },
    async (req) => {
      const id = uuidParam.parse(req.params.id);
      req.attachLogContext({ userId: req.user.sub, paymentId: id });
      return { payment: await getPaymentForBuyer(req.user.sub, id) };
    },
  );
}