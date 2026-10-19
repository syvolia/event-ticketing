// The order-creation flow. All work happens in ONE transaction, using the
// reservation implementation chosen by INVENTORY_IMPL. The order of operations
// is deliberate:
//
//   1. Validate the event and lock its status (SHARE lock — multiple concurrent
//      orders can hold it; a cancel takes an exclusive lock).
//   2. Reserve every tier (atomic conditional UPDATE, sorted by tier id).
//   3. Insert the order row with `ON CONFLICT (buyer_user_id, idempotency_key)
//      DO NOTHING`.
//   4. If the insert returned zero rows, another transaction already created
//      this order — abort with a marker error, then re-read the winner and
//      return it.
//   5. Insert order_items.
//
// If any step fails, the whole transaction rolls back. Any reservation
// applied by step 2 is undone, so a failed or duplicate request never leaks
// inventory.
//
// The idempotency UNIQUE index is what makes step 4 race-free: two concurrent
// requests with the same key both reach the INSERT; Postgres serializes them
// on the index entry, one wins with a row, the other gets zero rows. Because
// the reservation happens BEFORE the insert, and the loser rolls back, the
// net effect is that only the winner's reservations survive.

import type { PoolClient } from 'pg';
import type {
  CreateOrderInput,
  OrderView,
  PaymentProvider,
  PaymentStatus,
} from '@ticketing/shared';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { withTransaction } from '../db/tx.js';
import { conflict, notFound, unprocessable } from '../errors.js';
import { reserveTiers as reserveConditional } from './inventory.js';
import { reserveTiers as reserveForUpdate } from './inventory.for-update.js';

const reserveTiers =
  config.INVENTORY_IMPL === 'for-update' ? reserveForUpdate : reserveConditional;

// Marker error thrown when the idempotency INSERT collides. Kept as its own
// class so the outer catch can distinguish it from real failures.
class IdempotencyConflictError extends Error {
  constructor() {
    super('idempotency conflict');
    this.name = 'IdempotencyConflictError';
  }
}

export interface CreateOrderResult {
  order: OrderView;
  /** true = freshly created; false = idempotent hit on an existing order. */
  created: boolean;
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface OrderRow {
  id: string;
  event_id: string;
  status: string;
  currency: string;
  subtotal_minor: number;
  total_minor: number;
  expires_at: Date | null;
  created_at: Date;
}

interface OrderItemRow {
  tier_id: string;
  tier_name: string;
  quantity: number;
  unit_price_minor: number;
  currency: string;
  line_total_minor: number;
}

interface LatestPaymentRow {
  id: string;
  provider: PaymentProvider;
  status: PaymentStatus;
  failure_code: string | null;
  failure_reason: string | null;
}

// The latest payment is projected into the order view so the buyer's
// payment-pending screen can distinguish three states that all look like
// `awaiting_payment` at the order level:
//   - no payment yet        → user hasn't tapped Pay
//   - payment initiated     → waiting on the STK prompt / card confirmation
//   - payment failed        → user should retry, order is still reservable
// Without this field the client cannot tell "still waiting" from "failed",
// which forces it to invent a timeout heuristic.
async function hydrateOrder(
  client: Pick<PoolClient, 'query'>,
  orderId: string,
): Promise<OrderView> {
  const { rows: ords } = await client.query<OrderRow>(
    `SELECT id, event_id, status, currency, subtotal_minor, total_minor,
            expires_at, created_at
       FROM orders WHERE id = $1`,
    [orderId],
  );
  const ord = ords[0];
  if (!ord) throw notFound('Order not found');

  const { rows: items } = await client.query<OrderItemRow>(
    `SELECT oi.tier_id,
            tt.name        AS tier_name,
            oi.quantity,
            oi.unit_price_minor,
            oi.currency,
            oi.line_total_minor
       FROM order_items oi
       JOIN ticket_tiers tt ON tt.id = oi.tier_id
      WHERE oi.order_id = $1
      ORDER BY tt.name`,
    [orderId],
  );

  const { rows: pays } = await client.query<LatestPaymentRow>(
    `SELECT id, provider, status, failure_code, failure_reason
       FROM payments
      WHERE order_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [orderId],
  );
  const latestPayment = pays[0]
    ? {
        id: pays[0].id,
        provider: pays[0].provider,
        status: pays[0].status,
        failureCode: pays[0].failure_code,
        failureReason: pays[0].failure_reason,
      }
    : null;

  return {
    id: ord.id,
    eventId: ord.event_id,
    status: ord.status,
    currency: ord.currency,
    subtotalMinor: ord.subtotal_minor,
    totalMinor: ord.total_minor,
    expiresAt: ord.expires_at ? ord.expires_at.toISOString() : null,
    createdAt: ord.created_at.toISOString(),
    latestPayment,
    items: items.map((i) => ({
      tierId: i.tier_id,
      tierName: i.tier_name,
      quantity: i.quantity,
      unitPriceMinor: i.unit_price_minor,
      currency: i.currency,
      lineTotalMinor: i.line_total_minor,
    })),
  };
}

// ---------------------------------------------------------------------------
// createOrder
// ---------------------------------------------------------------------------

/**
 * Idempotent order creation. Calling twice with the same
 * `(buyerUserId, idempotencyKey)` returns the same order and never
 * double-reserves.
 */
export async function createOrder(
  buyerUserId: string,
  input: CreateOrderInput,
  idempotencyKey: string,
): Promise<CreateOrderResult> {
  // Fast path: if the order is already committed, skip the reservation work
  // entirely. This is a pure optimization — correctness is preserved by the
  // INSERT ... ON CONFLICT below.
  const prior = await pool.query<{ id: string }>(
    `SELECT id FROM orders
      WHERE buyer_user_id = $1 AND idempotency_key = $2`,
    [buyerUserId, idempotencyKey],
  );
  if (prior.rows[0]) {
    return { order: await hydrateOrder(pool, prior.rows[0].id), created: false };
  }

  try {
    return await withTransaction(
      async (client) => {
        // 1. Validate the event and lock its status. A SHARE lock here
        //    prevents a concurrent cancel from flipping the event to
        //    cancelled between our check and our reservation. Multiple
        //    concurrent orders can each hold this SHARE lock simultaneously;
        //    only cancel (exclusive) waits.
        const ev = await client.query<{ id: string; status: string }>(
          `SELECT id, status FROM events WHERE id = $1 FOR SHARE`,
          [input.eventId],
        );
        const event = ev.rows[0];
        if (!event) throw notFound('Event not found');
        if (event.status !== 'published') {
          throw unprocessable('Event is not open for sales');
        }

        // 2. Reserve every tier. The reserveTiers helper throws on any
        //    failure, which aborts the whole transaction and rolls back any
        //    reservations already made for earlier tiers in this request.
        const reserved = await reserveTiers(client, input.eventId, input.items);

        // 3. Currency consistency. An order has one currency; mixing tiers in
        //    different currencies would produce a total that cannot be paid.
        const currencies = new Set(reserved.map((r) => r.currency));
        if (currencies.size !== 1) {
          throw unprocessable('All tiers in an order must share a currency', {
            currencies: [...currencies],
          });
        }
        const currency = reserved[0]!.currency;

        // 4. Totals computed from the DB row prices returned by the
        //    reservation, never from client input.
        const subtotal = reserved.reduce((sum, r) => sum + r.priceMinor * r.quantity, 0);
        const total = subtotal;

        // 5. Insert the order. `expires_at` is set on the DB clock so the
        //    reservation deadline is immune to app-server skew.
        //    ON CONFLICT DO NOTHING is the idempotency fence: if a concurrent
        //    request already inserted this (buyer, key), we get zero rows.
        const ordRes = await client.query<{ id: string }>(
          `INSERT INTO orders
             (buyer_user_id, event_id, status, currency,
              subtotal_minor, total_minor, idempotency_key, expires_at)
           VALUES
             ($1, $2, 'awaiting_payment', $3, $4, $5, $6,
              now() + ($7::int * interval '1 minute'))
           ON CONFLICT (buyer_user_id, idempotency_key) DO NOTHING
           RETURNING id`,
          [
            buyerUserId,
            input.eventId,
            currency,
            subtotal,
            total,
            idempotencyKey,
            config.RESERVATION_TTL_MINUTES,
          ],
        );

        if (ordRes.rowCount === 0) {
          // Lost the idempotency race. Throw to roll back this transaction
          // (undoing our reservation) and let the caller re-read the winner.
          throw new IdempotencyConflictError();
        }
        const orderId = ordRes.rows[0]!.id;

        // 6. Insert line items. Prices come from `reserved`, which came from
        //    the tier rows themselves.
        for (const line of reserved) {
          await client.query(
            `INSERT INTO order_items
               (order_id, tier_id, quantity, unit_price_minor, currency, line_total_minor)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              orderId,
              line.tierId,
              line.quantity,
              line.priceMinor,
              line.currency,
              line.priceMinor * line.quantity,
            ],
          );
        }

        return { order: await hydrateOrder(client, orderId), created: true };
      },
      { label: 'createOrder' },
    );
  } catch (err) {
    if (err instanceof IdempotencyConflictError) {
      // The winner has committed (Postgres held us on the unique index entry
      // until then). Re-read and return their order.
      const winner = await pool.query<{ id: string }>(
        `SELECT id FROM orders
          WHERE buyer_user_id = $1 AND idempotency_key = $2`,
        [buyerUserId, idempotencyKey],
      );
      const id = winner.rows[0]?.id;
      if (!id) {
        // Extremely unlikely: winner rolled back between our conflict and now.
        throw conflict('Order creation is in progress; retry shortly');
      }
      return { order: await hydrateOrder(pool, id), created: false };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getOrderForBuyer(
  buyerUserId: string,
  orderId: string,
): Promise<OrderView> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM orders WHERE id = $1 AND buyer_user_id = $2`,
    [orderId, buyerUserId],
  );
  if (!rows[0]) throw notFound('Order not found');
  return hydrateOrder(pool, rows[0].id);
}