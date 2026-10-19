import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/server.js';

const open: FastifyInstance[] = [];

export async function makeApp(): Promise<FastifyInstance> {
  const app = await buildServer();
  await app.ready();
  open.push(app);
  return app;
}

export async function closeAllApps(): Promise<void> {
  for (const app of open.splice(0)) {
    await app.close();
  }
}

// Convenience: register an organizer and return the bearer token + id.
export async function makeOrganizer(
  app: FastifyInstance,
  email = 'org@example.com',
  password = 'correct horse battery staple',
): Promise<{ token: string; userId: string; email: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email, password, displayName: 'Org', role: 'organizer' },
  });
  if (res.statusCode !== 201) {
    throw new Error(`register failed: ${res.statusCode} ${res.body}`);
  }
  const body = res.json() as { accessToken: string; user: { id: string } };
  return { token: body.accessToken, userId: body.user.id, email };
}