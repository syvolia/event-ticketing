// Expired-reservation sweeper.
//
// Every tick:
//   1. Claim a batch of expired orders with SELECT ... FOR UPDATE SKIP LOCKED.
//      SKIP LOCKED means two sweepers running concurrently (e.g. blue/green
//      deploy) each pick a disjoint set — no waiting, no double-processing.
//   2. For each claimed order, transition status to 'expired' with the status
//      in the WHERE clause. This transition IS the "won exactly once" guard:
//      a concurrent sweeper, a late payment webhook, or any other actor that
//      already moved the order cannot match, so rowCount is 0 and we skip the
//      release. The orders state-machine trigger would also reject an illegal
//      transition, so we are protected even if a caller forgot the guard.
//   3. Release the inventory by decrementing `reserved` per order_item. This
//      runs in the same transaction as the status transition, so either both
//      happen or neither does.
//
// The statement_timeout is bumped inside the transaction so a large batch
// does not hit the per-connection default (30s). The lock_timeout is left at
// its default (5s) — if a buyer's order lock is held that long, something is
// wrong and we WANT the sweeper to abort rather than pile up.
//
// Why the release cannot double-fire: the UPDATE that moves the order out of
// 'awaiting_payment' is a single statement. Postgres serializes writers on
// the order row; only one transaction can perform the transition. Any loser
// sees zero rows and skips the release.

import { pool } from '../db/pool.js';
import { withTransaction } from '../db/tx.js';
import { logger } from '../logger.js';
import { expiredReservationsReleased } from '../metrics.js';

const BATCH_SIZE = 100;
const SWEEP_INTERVAL_MS = 5_000;

/** Runs one sweep cycle. Returns the number of orders transitioned+released. */
export async function sweepOnce(): Promise<number> {
  const released = await withTransaction(
    async (client) => {
      // A sweep can legitimately touch hundreds of rows across many
      // transactions' worth of work. Give it more headroom than the default
      // 30s statement_timeout so a busy night does not abort mid-batch.
      await client.query(`SET LOCAL statement_timeout = '60s'`);

      const { rows: claimable } = await client.query<{ id: string }>(
        `SELECT id
           FROM orders
          WHERE status IN ('pending','awaiting_payment')
            AND expires_at IS NOT NULL
            AND expires_at <= now()
          ORDER BY expires_at ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [BATCH_SIZE],
      );
      if (claimable.length === 0) return 0;

      let releasedHere = 0;
      for (const { id } of claimable) {
        // The guard. Only the winner of this UPDATE proceeds to release.
        const upd = await client.query(
          `UPDATE orders
              SET status = 'expired',
                  failed_reason = COALESCE(failed_reason, 'reservation expired')
            WHERE id = $1
              AND status IN ('pending','awaiting_payment')`,
          [id],
        );
        if (upd.rowCount === 0) continue;

        const { rows: items } = await client.query<{
          tier_id: string;
          quantity: number;
        }>(
          `SELECT tier_id, quantity FROM order_items WHERE order_id = $1`,
          [id],
        );
        for (const it of items) {
          // Plain subtraction: the status guard means we can only reach this
          // line once per order, so `reserved` cannot go negative. If a future
          // refactor ever broke that guarantee, the CHECK
          // (sold + reserved <= capacity) would not fire on a decrement, so we
          // rely on the guard alone — which is exactly why the guard is
          // atomic.
          await client.query(
            `UPDATE ticket_tiers
                SET reserved = reserved - $2::int
              WHERE id = $1`,
            [it.tier_id, it.quantity],
          );
        }
        releasedHere += 1;
      }
      return releasedHere;
    },
    { label: 'sweepExpiredOrders' },
  );

  if (released > 0) {
    // Metric increment outside the transaction so the counter reflects what
    // actually committed. If the transaction had rolled back, `released` would
    // be undefined here and this line would not run.
    expiredReservationsReleased.inc(released);
    logger.info({ released }, 'sweeper released expired orders');
  }
  return released;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startSweeper(intervalMs: number = SWEEP_INTERVAL_MS): void {
  if (timer) return;
  const tick = async (): Promise<void> => {
    if (running) return; // never overlap ticks in the same process
    running = true;
    try {
      await sweepOnce();
    } catch (err) {
      logger.error({ err }, 'sweeper tick failed');
    } finally {
      running = false;
    }
  };
  timer = setInterval(() => void tick(), intervalMs);
  // Do not hold the process open on the sweeper; the HTTP listener is what
  // keeps us alive.
  timer.unref?.();
}

export function stopSweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Test helper — used by vitest to reset module state between suites. */
export function _resetSweeperForTests(): void {
  stopSweeper();
  running = false;
}

// Silence "unused import" when only sweepOnce is consumed by tests.
void pool;