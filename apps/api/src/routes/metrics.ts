// Prometheus scrape endpoint.
//
// In production this is token-protected: a Prometheus scrape config (or the
// reverse proxy in front of it) injects `Authorization: Bearer ${METRICS_TOKEN}`.
// In dev no token is required — curl it freely.
//
// We do NOT rate limit this route. Prometheus scrapes on a fixed interval
// from one IP; rate limiting would make the scrape unreliable and cause gaps
// in every dashboard. If you need to protect against unauthorized scrapes,
// the token gate is the right control.
import type { FastifyInstance } from 'fastify';
import { register } from '../metrics.js';
import { config } from '../config.js';

export async function registerMetricsRoute(app: FastifyInstance): Promise<void> {
  app.get('/metrics', async (req, reply) => {
    if (config.NODE_ENV === 'production') {
      const auth = req.headers.authorization;
      if (!config.METRICS_TOKEN || auth !== `Bearer ${config.METRICS_TOKEN}`) {
        reply.code(401).send({
          error: { code: 'UNAUTHENTICATED', message: 'metrics auth required' },
        });
        return;
      }
    }
    reply.header('content-type', register.contentType);
    return reply.send(await register.metrics());
  });
}