// Webhook entry points. Both providers share the same service function.
// Response bodies are the minimum the provider expects:
//   M-Pesa: {"ResultCode": 0, "ResultDesc": "Accepted"} — anything else and
//           Safaricom retries.
//   Stripe: {"received": true} with a 2xx.
//
// Duplicate deliveries return 200 with the same body. This is deliberate:
// a non-2xx would trigger the provider's retry schedule and, for M-Pesa,
// could exceed the retry window and drop the callback entirely.
import type { FastifyInstance } from 'fastify';
import { recordWebhook } from '../services/payments.js';
import { logger } from '../logger.js';
import { webhookDuplicates } from '../metrics.js';

export async function registerWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.post('/webhooks/mpesa', async (req, reply) => {
    try {
      const result = await recordWebhook('mpesa', {
        headers: req.headers,
        rawBody:
          (req as unknown as { rawBody?: Buffer }).rawBody ??
          Buffer.from(JSON.stringify(req.body)),
        body: req.body,
      });
      if (result.duplicate) {
        webhookDuplicates.inc({ provider: 'mpesa' });
        req.log.info({ provider: 'mpesa' }, 'duplicate mpesa callback ignored');
      }
      if (result.paymentId) req.attachLogContext({ paymentId: result.paymentId });
      reply.code(200).send({ ResultCode: 0, ResultDesc: 'Accepted' });
    } catch (err) {
      req.log.error({ err }, 'mpesa webhook failed');
      // Return 200 anyway for malformed/unknown payloads so Safaricom does
      // not retry a payload we will never be able to process.
      reply.code(200).send({ ResultCode: 0, ResultDesc: 'Accepted' });
    }
  });

  app.post('/webhooks/stripe', async (req, reply) => {
    try {
      const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
      if (!rawBody) {
        // The preParsing hook should have populated this. A missing raw body
        // means signature verification cannot run — fail closed.
        reply.code(400).send({ error: 'missing raw body' });
        return;
      }
      const result = await recordWebhook('stripe', {
        headers: req.headers,
        rawBody,
        body: req.body,
      });
      if (result.duplicate) {
        webhookDuplicates.inc({ provider: 'stripe' });
        req.log.info({ provider: 'stripe' }, 'duplicate stripe event ignored');
      }
      if (result.paymentId) req.attachLogContext({ paymentId: result.paymentId });
      reply.code(200).send({ received: true });
    } catch (err) {
      // Signature verification failures surface as 400 with a body the Stripe
      // dashboard can display.
      logger.warn({ err }, 'stripe webhook rejected');
      reply.code(400).send({ error: (err as Error).message });
    }
  });
}