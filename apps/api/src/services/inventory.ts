// Inventory reservation — primary implementation.
//
// WHY THIS IS CORRECT UNDER READ COMMITTED
// ----------------------------------------
// Each reservation is a single UPDATE whose WHERE clause encodes every
// predicate: sales window open, quantity within per-order cap, and
// capacity - sold - reserved >= quantity. Postgres serializes writers on the
// row via the row lock taken by the UPDATE itself. If two transactions race
// the same tier:
//
//   1. Writer A takes the row lock and evaluates its WHERE against the
//      current row.
//   2. Writer B blocks on the same row lock.
//   3. A commits.
//   4. B's row lock is granted, but before applying the update Postgres
//      re-evaluates B's WHERE against the *latest committed* row version
//      (EvalPlanQual). If B's predicate no longer holds — because A just
//      consumed the last ticket — B's UPDATE matches zero rows and B
//      reports OUT_OF_STOCK.
//
// This is exactly the "read under the writer's own lock" guarantee we need,
// without the app ever reading-then-deciding. The `CHECK (sold + reserved <=
// capacity)` is a second fence: if any code path ever bypasses the predicate,
// the write fails at commit.
//
// WHY WE SORT BY tier_id
// ----------------------
// Consistent lock order. If request R1 touches [T2, T1] and R2 touches
// [T1, T2] without sorting, R1 holds T2 and waits for T1 while R2 holds T1
// and waits for T2 — classic deadlock. Sorting ascending means both take T1
// first, so one waits for the other; no cycle.
//
// WHY WE DO NOT USE SERIALIZABLE
// ------------------------------
// The invariant is per-tier arithmetic enforced by the UPDATE. Serializable
// would add 40001 aborts that must be retried by every caller — including
// webhook handlers, where retrying is not always possible. Read committed
// plus a predicate-per-write is a strictly simpler and equally correct answer
// for this anomaly class.

import type { PoolClient } from 'pg';
import { conflict } from '../errors.js';

export interface ReserveLine {
  tierId: string;
  quantity: number;
}

export interface ReservedTier {
  tierId: string;
  name: string;
  quantity: number;
  priceMinor: number;
  currency: string;
}

export type ReserveFailureReason =
  | 'TIER_NOT_FOUND'
  | 'SALES_NOT_OPEN'
  | 'SALES_CLOSED'
  | 'INSUFFICIENT_INVENTORY'
  | 'EXCEEDS_PER_ORDER_MAX';

interface TierDiagRow {
  id: string;
  event_id: string;
  name: string;
  price_minor: number;
  currency: string;
  capacity: number;
  sold: number;
  reserved: number;
  per_order_max: number;
  sales_start: Date;
  sales_end: Date;
}

interface ReservedRow {
  id: string;
  name: string;
  price_minor: number;
  currency: string;
}

/**
 * Reserve every line or throw. MUST be called inside a transaction on the
 * same client — the caller depends on rollback to undo partial reservations
 * when a later line fails.
 *
 * @param eventId scopes the reservation so a tier from another event can
 *                never be silently booked. Include it in the UPDATE WHERE,
 *                not just a pre-check, so a stale pre-check cannot slip past.
 */
export async function reserveTiers(
  client: PoolClient,
  eventId: string,
  lines: ReserveLine[],
): Promise<ReservedTier[]> {
  // 1. Deterministic lock order. Two concurrent requests touching the same
  //    pair of tiers will contend on the lower id first; no deadlock.
  const sorted = [...lines].sort((a, b) => a.tierId.localeCompare(b.tierId));

  const out: ReservedTier[] = [];
  for (const line of sorted) {
    // 2. Single atomic statement. All predicates are evaluated against the
    //    latest committed row under the writer's lock (EvalPlanQual). If any
    //    predicate fails, zero rows match and the caller aborts the whole
    //    transaction — undoing any reservations already taken for earlier
    //    lines in this same request.
    //
    //    `now()` inside a transaction returns the transaction start time in
    //    READ COMMITTED, so the sales window is checked against a single
    //    consistent instant even if the statement runs for milliseconds.
    const res = await client.query<ReservedRow>(
      `UPDATE ticket_tiers
          SET reserved = reserved + $3::int
        WHERE id = $1
          AND event_id = $2
          AND now() >= sales_start
          AND now() <= sales_end
          AND capacity - sold - reserved >= $3::int
          AND $3::int <= per_order_max
        RETURNING id, name, price_minor, currency`,
      [line.tierId, eventId, line.quantity],
    );

    // 3. rowCount === 0 means the predicate failed. We diagnose inside the
    //    same transaction so the message is precise without a second
    //    round-trip outside the tx (which could race a concurrent change).
    //    The diagnosis is best-effort: even if it reads a slightly different
    //    state, the caller will get a 409 with a sane reason.
    if (res.rowCount === 0) {
      const diag = await client.query<TierDiagRow>(
        `SELECT id, event_id, name, price_minor, currency, capacity, sold,
                reserved, per_order_max, sales_start, sales_end
           FROM ticket_tiers
          WHERE id = $1`,
        [line.tierId],
      );
      const tier = diag.rows[0];
      if (!tier || tier.event_id !== eventId) {
        throw conflict('Ticket tier not found for this event', {
          tierId: line.tierId,
          reason: 'TIER_NOT_FOUND',
          requested: line.quantity,
        });
      }
      const now = new Date();
      if (now < tier.sales_start) {
        throw conflict('Ticket sales have not opened yet', {
          tierId: line.tierId,
          reason: 'SALES_NOT_OPEN',
          requested: line.quantity,
          salesStart: tier.sales_start.toISOString(),
        });
      }
      if (now > tier.sales_end) {
        throw conflict('Ticket sales have closed', {
          tierId: line.tierId,
          reason: 'SALES_CLOSED',
          requested: line.quantity,
          salesEnd: tier.sales_end.toISOString(),
        });
      }
      if (line.quantity > tier.per_order_max) {
        throw conflict('Quantity exceeds per-order maximum', {
          tierId: line.tierId,
          reason: 'EXCEEDS_PER_ORDER_MAX',
          requested: line.quantity,
          perOrderMax: tier.per_order_max,
        });
      }
      const available = tier.capacity - tier.sold - tier.reserved;
      throw conflict('Not enough tickets available', {
        tierId: line.tierId,
        reason: 'INSUFFICIENT_INVENTORY',
        requested: line.quantity,
        available,
      });
    }

    const row = res.rows[0]!;
    out.push({
      tierId: row.id,
      name: row.name,
      quantity: line.quantity,
      priceMinor: row.price_minor,
      currency: row.currency,
    });
  }
  return out;
}