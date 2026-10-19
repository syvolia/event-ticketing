// Timeouts are defence in depth. Postgres enforces three of them, in order of
// increasing scope:
//
//   lock_timeout        — how long a statement waits to acquire a row lock
//                          before giving up. Default: 5s.
//   statement_timeout   — how long any single statement may run before
//                          Postgres aborts it. Default: 30s.
//   idle_in_transaction_session_timeout
//                       — how long a transaction may sit idle between
//                          statements before Postgres aborts it. Default: 60s.
//
// The ordering matters: lock_timeout < statement_timeout so a blocked UPDATE
// fails fast (5s) rather than eating the statement budget (30s). The 5s
// window is long enough for legitimate lock contention at our target load and
// short enough that a stuck sweeper never blocks the whole rollout.
//
// idle_in_transaction guards against the "commit forgot to run" class of bug:
// a client checked out and left in a transaction is eventually reaped by
// Postgres, its row locks released, and the caller's subsequent query fails
// with SQLSTATE 25P03 (idle_in_transaction_session_timeout).
//
// We ALSO set a client-side connection timeout on the pool. That fires when
// Postgres itself is unreachable, not when a query is slow.
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
  // `options` is passed to the backend as command-line flags. Postgres
  // accepts `-c key=value` for any run-time GUC. Setting them here means
  // every connection has the same protection without a per-query SET.
  options: [
    '-c statement_timeout=30000',
    '-c lock_timeout=5000',
    '-c idle_in_transaction_session_timeout=60000',
  ].join(' '),
});

pool.on('error', (err) => {
  logger.error({ err }, 'idle pg client error');
});

pool.on('connect', (client) => {
  // Application-level context for every query: identifiable in pg_stat_activity
  // so a slow query can be traced back to this service. Cheap and permanent.
  void client.query(
    `SET application_name = 'ticketing-api'`,
  ).catch((err) => {
    logger.warn({ err }, 'failed to set application_name');
  });
});

export async function pingDb(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
}