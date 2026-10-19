// apps/api/src/db/pool.ts
//
// Note on timeouts: We do NOT pass `statement_timeout`, `lock_timeout`, or
// `application_name` via the `options` connection string parameter.
// Neon (and any PgBouncer-based pooler) rejects arbitrary startup parameters
// with `08P01: unsupported startup parameter in options`. 
//
// If specific routes need a timeout (e.g. the sweeper batch), they set it
// locally using `SET LOCAL statement_timeout = '...'` inside their transaction.
import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../logger.js';

const { Pool, types } = pg;

types.setTypeParser(types.builtins.INT8, (v) => Number(v));

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: config.PG_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  // No `options` array here. Rely on the server defaults or per-transaction
  // settings to avoid PgBouncer/Neon connection errors.
});

pool.on('error', (err) => {
  logger.error({ err }, 'idle pg client error');
});

export async function pingDb(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
}