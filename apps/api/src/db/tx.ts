// Transaction wrapper. Defaults to READ COMMITTED; the invariant we care about
// is enforced by the row-level UPDATE predicate + CHECK, which are race-free
// under READ COMMITTED, so we don't need SERIALIZABLE or its retries.
import type { PoolClient } from 'pg';
import { pool } from './pool.js';
import { logger } from '../logger.js';

export type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable';

export interface WithTransactionOptions {
  isolation?: IsolationLevel;
  label?: string;
}

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
  options: WithTransactionOptions = {},
): Promise<T> {
  const { isolation = 'read committed', label = 'tx' } = options;
  const client = await pool.connect();
  const startedAt = Date.now();

  try {
    await client.query('BEGIN');
    if (isolation !== 'read committed') {
      await client.query(`SET TRANSACTION ISOLATION LEVEL ${isolation.toUpperCase()}`);
    }

    const result = await fn(client);
    await client.query('COMMIT');

    const durationMs = Date.now() - startedAt;
    if (durationMs > 500) logger.warn({ label, durationMs }, 'slow transaction');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error({ err: rollbackErr, label }, 'rollback failed');
    }
    throw err;
  } finally {
    client.release();
  }
}
