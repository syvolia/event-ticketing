import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { config } from './config.js';
import { logger } from './logger.js';
import { toErrorBody } from './errors.js';
import jwtPlugin from './plugins/jwt.js';
import securityPlugin from './plugins/security.js';
import rateLimitPlugin from './plugins/rateLimit.js';
import requestContextPlugin from './plugins/requestContext.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerCheckinRoutes } from './routes/checkin.js';
import { registerEventRoutes } from './routes/events.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerMetricsRoute } from './routes/metrics.js';
import { registerOrderRoutes } from './routes/orders.js';
import { registerPaymentRoutes } from './routes/payments.js';
import { registerTicketRoutes } from './routes/tickets.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { ensureActiveSigningKey } from './qr/keys.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: logger as FastifyBaseLogger,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      if (typeof incoming === 'string' && incoming.length > 0 && incoming.length < 200) {
        return incoming;
      }
      return randomUUID();
    },
    trustProxy: true,
    disableRequestLogging: true, // requestContext plugin logs completions
    bodyLimit: 1_048_576, // 1 MiB — larger bodies are almost certainly abuse
  });

  await app.register(securityPlugin);
  await app.register(rateLimitPlugin);
  await app.register(requestContextPlugin);

  // Stripe webhook needs the raw body before JSON parsing.
  app.addHook('preParsing', async (req, _reply, payload) => {
    if (req.url.startsWith('/webhooks/stripe')) {
      const chunks: Buffer[] = [];
      for await (const chunk of payload as AsyncIterable<Buffer>) {
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks);
      (req as unknown as { rawBody?: Buffer }).rawBody = raw;
      return Readable.from(raw);
    }
    return payload;
  });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  app.setErrorHandler((err, req, reply) => {
    const { status, body } = toErrorBody(err);
    if (status >= 500) req.log.error({ err }, 'unhandled error');
    else
      req.log.info(
        { err: { message: err.message, code: (err as { code?: string }).code } },
        'request error',
      );
    reply.code(status).send(body);
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({
      error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.url} not found` },
    });
  });

  await app.register(jwtPlugin);
  await registerHealthRoutes(app);
  await registerMetricsRoute(app);
  await registerAuthRoutes(app);
  await registerEventRoutes(app);
  await registerOrderRoutes(app);
  await registerPaymentRoutes(app);
  await registerWebhookRoutes(app);
  await registerTicketRoutes(app);
  await registerCheckinRoutes(app);

  return app;
}

export { config, ensureActiveSigningKey };