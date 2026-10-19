// Liveness + readiness. Liveness never touches the DB (so a slow DB does not
// cause an orchestrator to restart a healthy pod). Readiness pings the DB and
// returns 503 if the pool cannot reach Postgres.
import type { FastifyInstance } from 'fastify';
import { pingDb } from '../db/pool.js';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/health/ready', async (_req, reply) => {
    try {
      await pingDb();
      return { status: 'ready' };
    } catch {
      reply.code(503);
      return { status: 'degraded', reason: 'database_unreachable' };
    }
  });
}