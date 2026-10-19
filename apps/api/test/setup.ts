import { afterAll, beforeEach } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://ticketing:ticketing@localhost:5432/ticketing_test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-production-0123456789';
process.env.LOG_LEVEL = 'fatal';
process.env.INVENTORY_IMPL = process.env.INVENTORY_IMPL ?? 'conditional';
process.env.SMTP_HOST = 'localhost';
process.env.SMTP_PORT = '1025';
process.env.SMTP_FROM = 'Ticketing <noreply@ticketing.local>';

beforeEach(async () => {
  const { truncateAll } = await import('./helpers/db.js');
  await truncateAll();
  // The signing-key cache must be flushed after truncation; otherwise a
  // subsequent test holds a reference to a key row that no longer exists.
  const { _resetKeysCacheForTests } = await import('../src/qr/keys.js');
  _resetKeysCacheForTests();
});

afterAll(async () => {
  const { closeAllApps } = await import('./helpers/app.js');
  await closeAllApps();
  const { _resetOutboxForTests } = await import('../src/workers/outboxPublisher.js');
  _resetOutboxForTests();
  const { pool } = await import('../src/db/pool.js');
  await pool.end();
});