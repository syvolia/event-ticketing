// The classic TOCTOU implementation, kept so the before/after comparison is
// visible in a test. Do NOT use this anywhere in the real code path.
//
// `reserveTierNaive` does: SELECT the current state, decide in JS, UPDATE.
// Between the SELECT and the UPDATE there is no lock and no atomic predicate,
// so any number of concurrent callers can read the same `available` value and
// all decide to proceed.
//
// The naive tier lives in its own table `ticket_tiers_naive` with NO CHECK
// constraint — this is deliberate. The correct implementation is protected
// by a CHECK as a backstop. Removing the CHECK from the naive table is what
// lets the oversell actually land in the DB, which is the point of the demo.
import { randomUUID } from 'node:crypto';
import { pool } from '../../src/db/pool.js';

export async function setupNaiveTable(): Promise<void> {
  await pool.query('DROP TABLE IF EXISTS ticket_tiers_naive CASCADE');
  await pool.query(`
    CREATE TABLE ticket_tiers_naive (
      id            uuid PRIMARY KEY,
      capacity      integer NOT NULL,
      per_order_max integer NOT NULL,
      sold          integer NOT NULL DEFAULT 0,
      reserved      integer NOT NULL DEFAULT 0
    )
  `);
}

export async function setupNaiveTier(capacity: number): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO ticket_tiers_naive (id, capacity, per_order_max) VALUES ($1, $2, $3)`,
    [id, capacity, capacity],
  );
  return id;
}

export async function reserveTierNaive(tierId: string, qty: number): Promise<boolean> {
  const { rows } = await pool.query<{
    capacity: number;
    sold: number;
    reserved: number;
    per_order_max: number;
  }>(
    `SELECT capacity, sold, reserved, per_order_max FROM ticket_tiers_naive WHERE id = $1`,
    [tierId],
  );
  const t = rows[0];
  if (!t) return false;
  const available = t.capacity - t.sold - t.reserved;
  if (available < qty || qty > t.per_order_max) return false;
  // <-- no lock held, no predicate on the UPDATE; another caller can read
  //     the same `available` in this gap and both will write.
  await pool.query(
    `UPDATE ticket_tiers_naive SET reserved = reserved + $2 WHERE id = $1`,
    [tierId, qty],
  );
  return true;
}

export async function readNaiveCounters(
  tierId: string,
): Promise<{ capacity: number; sold: number; reserved: number }> {
  const { rows } = await pool.query<{ capacity: number; sold: number; reserved: number }>(
    `SELECT capacity, sold, reserved FROM ticket_tiers_naive WHERE id = $1`,
    [tierId],
  );
  return rows[0]!;
}