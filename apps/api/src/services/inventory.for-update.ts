// Inventory reservation — alternate implementation using SELECT ... FOR UPDATE.
//
// This is correct but costs two round-trips per tier (SELECT FOR UPDATE, then
// UPDATE) and trusts the application to compute the availability predicate in
// JS. It exists ONLY so we can benchmark it against the atomic conditional
// UPDATE. It is not the default.
//
// Correctness under READ COMMITTED:
//   - SELECT ... FOR UPDATE takes an exclusive row lock and, in READ
//     COMMITTED, sees the latest committed row.
//   - Every subsequent writer to the same tier blocks on that lock until we
//     commit or roll back, so between our SELECT and our UPDATE no one else
//     can change `sold` or `reserved`.
//   - The UPDATE therefore applies against exactly the row we inspected.
//
// The lock ordering constraint is identical to the conditional variant: sort
// by tier id ascending before locking anything. Otherwise multi-tier requests
// can deadlock.
//
// The CHECK (sold + reserved <= capacity) is still our backstop: if this
// implementation ever drifted from the app-side predicate, the write would
// fail at commit rather than oversell.

import type { PoolClient } from 'pg';
import { conflict } from '../errors.js';
import type { ReserveLine, ReservedTier } from './inventory.js';

interface LockedTierRow {
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

export async function reserveTiers(
  client: PoolClient,
  eventId: string,
  lines: ReserveLine[],
): Promise<ReservedTier[]> {
  const sorted = [...lines].sort((a, b) => a.tierId.localeCompare(b.tierId));
  const out: ReservedTier[] = [];

  // A single `now()` for the whole request so the sales-window decision is
  // consistent across all lines. In READ COMMITTED `now()` is the transaction
  // start, so this is also what the UPDATE path would see.
  const clock = await client.query<{ now: Date }>('SELECT now() AS now');
  const now = clock.rows[0]!.now;

  for (const line of sorted) {
    // 1. Exclusive row lock. Any concurrent writer — another reservation, a
    //    tier update, the sweeper releasing — waits on this lock until we
    //    commit or roll back. In READ COMMITTED, Postgres returns the latest
    //    committed row version once the lock is granted.
    const sel = await client.query<LockedTierRow>(
      `SELECT id, event_id, name, price_minor, currency, capacity, sold,
              reserved, per_order_max, sales_start, sales_end
         FROM ticket_tiers
        WHERE id = $1
        FOR UPDATE`,
      [line.tierId],
    );
    const tier = sel.rows[0];
    if (!tier || tier.event_id !== eventId) {
      throw conflict('Ticket tier not found for this event', {
        tierId: line.tierId,
        reason: 'TIER_NOT_FOUND',
        requested: line.quantity,
      });
    }

    // 2. Every predicate is evaluated while we hold the exclusive lock, so
    //    the row cannot change between check and write.
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
    if (available < line.quantity) {
      throw conflict('Not enough tickets available', {
        tierId: line.tierId,
        reason: 'INSUFFICIENT_INVENTORY',
        requested: line.quantity,
        available,
      });
    }

    // 3. The lock is still held, so this write applies against exactly the
    //    row we inspected above. The CHECK constraint remains as a backstop.
    await client.query(
      `UPDATE ticket_tiers SET reserved = reserved + $2::int WHERE id = $1`,
      [line.tierId, line.quantity],
    );

    out.push({
      tierId: tier.id,
      name: tier.name,
      quantity: line.quantity,
      priceMinor: tier.price_minor,
      currency: tier.currency,
    });
  }
  return out;
}