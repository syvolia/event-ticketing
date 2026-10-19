// Payment service.
//
// Every state change in this file is written as a single-statement conditional
// UPDATE with the current state in the WHERE clause. That is what makes
// duplicate webhook delivery a no-op: the first delivery wins the transition,
// the second sees the new status and matches zero rows.
//
// The success path does four things in one transaction:
//   1. Lock the payment row (FOR UPDATE) so a concurrent duplicate blocks.
//   2. Verify the callback amount equals the order total.
//   3. Convert reserved -> sold on every tier (or re-claim if the reservation
//      already expired, or record a refund if re-claim fails).
//   4. Move the order to paid and insert an outbox event for ticket issuance.
//
// Steps 3 and 4 are guarded by order status. Normal path: awaiting_payment ->
// paid. Re-claim path: expired -> paid, with a savepoint so a partial re-claim
// can roll back without unwinding the payment_events insert.
//
// The refund path (expired + re-claim failed) sets the order to refund_pending
// and inserts a refunds row. The actual provider-side refund is out of scope.

import type { PoolClient } from 'pg';
import type {
  PaymentProvider as PaymentProviderName,
  PaymentStatus,
  PaymentView,
  StartPaymentInput,
} from '@ticketing/shared';
import { pool } from '../db/pool.js';
import { withTransaction } from '../db/tx.js';
import { conflict, notFound, unprocessable } from '../errors.js';
import { getProvider } from '../payments/registry.js';
import type { ParsedWebhook } from '../payments/types.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface PaymentRow {
  id: string;
  order_id: string;
  provider: PaymentProviderName;
  status: PaymentStatus;
  amount_minor: number;
  currency: string;
  merchant_request_id: string | null;
  provider_ref: string | null;
  client_secret: string | null;
  phone: string | null;
  failure_code: string | null;
  failure_reason: string | null;
  idempotency_key: string;
  created_at: Date;
  succeeded_at: Date | null;
}

interface OrderRow {
  id: string;
  buyer_user_id: string;
  event_id: string;
  status: string;
  currency: string;
  total_minor: number;
  expires_at: Date | null;
}

interface OrderItemRow {
  tier_id: string;
  quantity: number;
}

interface PaymentEventRow {
  id: string;
  payment_id: string | null;
  provider: PaymentProviderName;
  provider_event_id: string;
  event_type: string;
  payload: unknown;
}

function toView(row: PaymentRow): PaymentView {
  return {
    id: row.id,
    orderId: row.order_id,
    provider: row.provider,
    status: row.status,
    amountMinor: row.amount_minor,
    currency: row.currency,
    providerRef: row.provider_ref,
    clientSecret: row.client_secret,
    failureCode: row.failure_code,
    failureReason: row.failure_reason,
    createdAt: row.created_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// startPayment
// ---------------------------------------------------------------------------

export interface StartPaymentResult {
  payment: PaymentView;
  created: boolean;
}

/**
 * Create a payment row for an order and hand it to the provider.
 *
 * Three-step flow to keep the external call out of a transaction:
 *   1. tx1: lock order, validate state, insert payment (status initiated),
 *      return the row.
 *   2. Call provider.initiate() — a slow network call, deliberately outside
 *      any transaction so it does not hold locks.
 *   3. tx2: store providerRef / merchantRequestId / clientSecret, then drain
 *      any orphan payment_events that arrived while step 2 was in flight.
 *
 * If step 2 fails, the payment row stays in `initiated` with no provider_ref.
 * The reconciler will pick it up; a human can also mark it failed.
 */
export async function startPayment(
  buyerUserId: string,
  orderId: string,
  input: StartPaymentInput,
): Promise<StartPaymentResult> {
  const provider = getProvider(input.provider);

  if (input.provider === 'mpesa' && !input.phone) {
    throw unprocessable('phone is required for M-Pesa payments');
  }

  // ---- tx1 -------------------------------------------------------------
  const staged = await withTransaction(
    async (client) => {
      // Lock the order so two concurrent pay requests cannot both create a
      // payment. Without this, the UNIQUE on (order_id, provider,
      // idempotency_key) would only dedupe same-key retries; different keys
      // would race.
      const { rows: ords } = await client.query<OrderRow>(
        `SELECT id, buyer_user_id, event_id, status, currency, total_minor, expires_at
           FROM orders WHERE id = $1 FOR UPDATE`,
        [orderId],
      );
      const order = ords[0];
      if (!order) throw notFound('Order not found');
      if (order.buyer_user_id !== buyerUserId) throw notFound('Order not found');

      // An existing active payment wins. This is the same idempotency the
      // DB enforces via the unique index, but checked under the order lock
      // so two in-flight calls cannot both pass.
      const { rows: existing } = await client.query<PaymentRow>(
        `SELECT * FROM payments
          WHERE order_id = $1 AND provider = $2
            AND status IN ('initiated','pending','succeeded')
          ORDER BY created_at DESC LIMIT 1`,
        [orderId, input.provider],
      );
      const prior = existing[0];
      if (prior) {
        if (prior.status === 'succeeded') {
          throw conflict('Order has already been paid');
        }
        return { payment: toView(prior), created: false, order };
      }

      if (order.status !== 'awaiting_payment') {
        throw unprocessable(`Order is not payable (status: ${order.status})`);
      }
      // Note: we do NOT reject on expires_at here. The sweeper races with us
      // and the authoritative decision is made by the sweeper's status
      // transition. If the reservation is genuinely gone, the callback will
      // take the refund path.

      const idempotencyKey = `sp_${orderId}_${input.provider}_${Date.now()}`;
      const { rows: inserted } = await client.query<PaymentRow>(
        `INSERT INTO payments
           (order_id, provider, status, amount_minor, currency,
            idempotency_key, phone)
         VALUES ($1, $2, 'initiated', $3, $4, $5, $6)
         RETURNING *`,
        [
          orderId,
          input.provider,
          order.total_minor,
          order.currency,
          idempotencyKey,
          input.phone ?? null,
        ],
      );
      return { payment: toView(inserted[0]!), created: true, order };
    },
    { label: 'startPayment:stage' },
  );

  if (!staged.created) return { payment: staged.payment, created: false };

  // ---- external call ---------------------------------------------------
  const accountReference = `ORD${staged.order.id.replace(/-/g, '').slice(0, 9).toUpperCase()}`;
  let initiated;
  try {
    initiated = await provider.initiate({
      paymentId: staged.payment.id,
      orderId: staged.order.id,
      amountMinor: staged.order.total_minor,
      currency: staged.order.currency,
      phone: input.phone,
      accountReference,
      description: `Order ${accountReference}`,
    });
  } catch (err) {
    // Record the failure on the payment row so the client sees a terminal
    // state instead of a silently stuck "initiated".
    await pool.query(
      `UPDATE payments
          SET status = 'failed',
              failure_code = 'initiation_failed',
              failure_reason = $2
        WHERE id = $1 AND status = 'initiated'`,
      [staged.payment.id, (err as Error).message.slice(0, 500)],
    );
    throw err;
  }

  // ---- tx2: store refs, drain orphans ----------------------------------
  const final = await withTransaction(
    async (client) => {
      const { rows } = await client.query<PaymentRow>(
        `UPDATE payments
            SET provider_ref = $2,
                merchant_request_id = $3,
                client_secret = $4,
                status = CASE WHEN $5::text = 'succeeded' THEN 'succeeded'::payment_status
                              ELSE status END,
                succeeded_at = CASE WHEN $5::text = 'succeeded' THEN now() ELSE succeeded_at END
          WHERE id = $1 AND status = 'initiated'
          RETURNING *`,
        [
          staged.payment.id,
          initiated.providerRef,
          initiated.merchantRequestId ?? null,
          initiated.clientSecret ?? null,
          initiated.status,
        ],
      );
      return toView(rows[0]!);
    },
    { label: 'startPayment:storeRefs' },
  );

  // A callback may have arrived while step 2 was in flight and been stored
  // as an orphan (payment_id NULL). Now that the ref exists, process it.
  await drainOrphanEvents(input.provider, initiated.providerRef);

  return { payment: final, created: true };
}

// ---------------------------------------------------------------------------
// Webhook handling
// ---------------------------------------------------------------------------

export interface RecordWebhookResult {
  /** True if this exact event was seen before. */
  duplicate: boolean;
  /** True if the event was applied (or is scheduled to be). */
  processed: boolean;
  paymentId: string | null;
}

/**
 * Record a raw webhook and, if we can find the payment, apply it.
 *
 * Idempotency contract:
 *   - `payment_events` has UNIQUE (provider, provider_event_id). Insert with
 *     ON CONFLICT DO NOTHING. A conflict means we already saw this exact
 *     event; return duplicate=true without touching any other table.
 *   - If the insert succeeded but the payment row cannot be found (the pay
 *     endpoint has not stored provider_ref yet), leave payment_id NULL. The
 *     drain path or the reconciler will bind it later. Return processed=false.
 *   - If both insert and lookup succeed, process in a single transaction.
 */
export async function recordWebhook(
  provider: PaymentProviderName,
  raw: { headers: Record<string, string | string[] | undefined>; rawBody: Buffer; body: unknown },
): Promise<RecordWebhookResult> {
  const p = getProvider(provider);
  const parsed: ParsedWebhook = await p.parseWebhook(raw);

  // Step 1: record. This is the idempotency fence. Everything below only
  // runs for the winning delivery.
  const inserted = await pool.query<PaymentEventRow>(
    `INSERT INTO payment_events
       (payment_id, provider, provider_event_id, event_type, payload)
     VALUES (NULL, $1, $2, $3, $4)
     ON CONFLICT (provider, provider_event_id) DO NOTHING
     RETURNING id, payment_id, provider, provider_event_id, event_type, payload`,
    [provider, parsed.providerEventId, parsed.eventType, JSON.stringify(parsed.raw)],
  );
  if (inserted.rowCount === 0) {
    return { duplicate: true, processed: true, paymentId: null };
  }
  const event = inserted.rows[0]!;

  // Step 2: bind to a payment if we can. Lookup is by provider_ref first,
  // then by merchant_request_id, because the callback may precede the
  // provider_ref write (see startPayment step 3).
  const payment = await findPaymentForEvent(provider, parsed);
  if (!payment) {
    logger.warn(
      { provider, providerEventId: parsed.providerEventId },
      'webhook arrived before payment row had a provider_ref; stored as orphan',
    );
    return { duplicate: false, processed: false, paymentId: null };
  }

  await withTransaction(
    async (client) => {
      await applyEvent(client, event.id, payment.id, parsed);
    },
    { label: 'recordWebhook:apply' },
  );

  return { duplicate: false, processed: true, paymentId: payment.id };
}

async function findPaymentForEvent(
  provider: PaymentProviderName,
  parsed: ParsedWebhook,
): Promise<PaymentRow | null> {
  // Prefer the exact provider_ref match. Fall back to merchant_request_id so
  // a callback that beat the pay endpoint to the DB can still be matched.
  const { rows } = await pool.query<PaymentRow>(
    `SELECT * FROM payments
      WHERE provider = $1
        AND (provider_ref = $2 OR ($3::text IS NOT NULL AND merchant_request_id = $3))
      ORDER BY created_at DESC
      LIMIT 1`,
    [provider, parsed.providerRef, parsed.merchantRequestId ?? null],
  );
  return rows[0] ?? null;
}

/** Bind and process orphan events for a provider_ref. Called from startPayment. */
export async function drainOrphanEvents(
  provider: PaymentProviderName,
  providerRef: string,
): Promise<number> {
  const { rows: orphans } = await pool.query<PaymentEventRow>(
    `SELECT id, payment_id, provider, provider_event_id, event_type, payload
       FROM payment_events
      WHERE provider = $1
        AND provider_event_id = $2
        AND payment_id IS NULL
        AND processed_at IS NULL
      FOR UPDATE SKIP LOCKED`,
    [provider, providerRef],
  );
  if (orphans.length === 0) return 0;

  const payment = await findPaymentForEvent(provider, {
    providerEventId: providerRef,
    providerRef,
    eventType: 'orphan_drain',
    status: 'pending',
    raw: null,
  });
  if (!payment) return 0;

  const p = getProvider(provider);
  for (const orphan of orphans) {
    // Re-parse the stored raw payload so we go through the same parsing path
    // as a fresh webhook. For M-Pesa the payload was stored verbatim.
    const parsed = await p.parseWebhook({
      headers: {},
      rawBody: Buffer.from(JSON.stringify(orphan.payload)),
      body: orphan.payload,
    });
    await withTransaction(
      async (client) => {
        await applyEvent(client, orphan.id, payment.id, parsed);
      },
      { label: 'drainOrphanEvents' },
    );
  }
  return orphans.length;
}

// ---------------------------------------------------------------------------
// applyEvent — the transactional core
// ---------------------------------------------------------------------------

async function applyEvent(
  client: PoolClient,
  eventId: string,
  paymentId: string,
  parsed: ParsedWebhook,
): Promise<void> {
  // Lock the payment row first. A concurrent duplicate delivery of the same
  // event id would be blocked by the payment_events unique index before it
  // even got here, but a *different* event for the same payment (say, a
  // status query result racing a callback) serializes on this lock.
  const { rows: payRows } = await client.query<PaymentRow>(
    `SELECT * FROM payments WHERE id = $1 FOR UPDATE`,
    [paymentId],
  );
  const payment = payRows[0];
  if (!payment) throw notFound('Payment not found');

  // Bind the event to the payment in the same transaction. This is what
  // makes the event row's payment_id non-null and marks it processed.
  await client.query(
    `UPDATE payment_events
        SET payment_id = $1
      WHERE id = $2 AND payment_id IS NULL`,
    [paymentId, eventId],
  );

  // Already succeeded — nothing to do. This is the "delivered 5 times" case
  // that slipped past the unique index (e.g. a status query and a callback
  // carrying different event ids for the same success).
  if (payment.status === 'succeeded') {
    await markEventProcessed(client, eventId);
    return;
  }

  if (parsed.status === 'pending') {
    // Unknown event type or still-processing status. Record and return.
    await markEventProcessed(client, eventId);
    return;
  }

  // Lock the order.
  const { rows: ordRows } = await client.query<OrderRow>(
    `SELECT id, buyer_user_id, event_id, status, currency, total_minor, expires_at
       FROM orders WHERE id = $1 FOR UPDATE`,
    [payment.order_id],
  );
  const order = ordRows[0];
  if (!order) throw notFound('Order not found');

  if (parsed.status === 'failed') {
    await applyFailure(client, eventId, payment, order, parsed);
    return;
  }

  // ---- success path ----------------------------------------------------

  // Amount verification. A callback that claims a different amount than the
  // order total is either a spoofed callback or a mismatch caused by a client
  // editing the price in transit (impossible here, but the check is cheap).
  // The provider amount is in minor units (cents) once parsed.
  if (parsed.amountMinor !== undefined && parsed.amountMinor !== order.total_minor) {
    await client.query(
      `UPDATE payments
          SET status = 'failed',
              failure_code = 'amount_mismatch',
              failure_reason = $2
        WHERE id = $1`,
      [
        payment.id,
        `Callback amount ${parsed.amountMinor} does not match order total ${order.total_minor}`,
      ],
    );
    await markEventProcessed(client, eventId);
    logger.error(
      { paymentId: payment.id, orderId: order.id, callback: parsed.amountMinor, expected: order.total_minor },
      'amount mismatch on payment callback',
    );
    return;
  }

  const { rows: items } = await client.query<OrderItemRow>(
    `SELECT tier_id, quantity FROM order_items WHERE order_id = $1 ORDER BY tier_id`,
    [order.id],
  );

  // Decide which path applies based on the order's current status.
  if (order.status === 'awaiting_payment') {
    await applyPaidNormal(client, payment, order, items, parsed);
  } else if (order.status === 'expired') {
    await applyPaidAfterExpiry(client, payment, order, items, parsed);
  } else if (order.status === 'paid' || order.status === 'fulfilled') {
    // Already paid; just make sure the payment row reflects the success.
    await client.query(
      `UPDATE payments
          SET status = 'succeeded',
              succeeded_at = COALESCE(succeeded_at, now()),
              provider_ref = COALESCE(provider_ref, $2),
              failure_code = NULL,
              failure_reason = NULL
        WHERE id = $1`,
      [payment.id, parsed.providerRef],
    );
  } else if (order.status === 'refund_pending' || order.status === 'refunded') {
    // Late duplicate. Leave the refund state untouched.
    logger.warn({ orderId: order.id }, 'success callback for order already in refund state');
  } else {
    // cancelled, failed — terminal states we cannot satisfy. Record for refund.
    await applyRefundPending(
      client,
      payment,
      order,
      parsed,
      `Order in terminal state ${order.status}`,
    );
  }

  await markEventProcessed(client, eventId);
}

async function markEventProcessed(client: PoolClient, eventId: string): Promise<void> {
  await client.query(
    `UPDATE payment_events SET processed_at = now() WHERE id = $1 AND processed_at IS NULL`,
    [eventId],
  );
}

// ---------------------------------------------------------------------------
// Success paths
// ---------------------------------------------------------------------------

async function applyPaidNormal(
  client: PoolClient,
  payment: PaymentRow,
  order: OrderRow,
  items: OrderItemRow[],
  parsed: ParsedWebhook,
): Promise<void> {
  // Convert reserved -> sold on each tier. This does not change the sum
  // sold + reserved, so the CHECK constraint cannot fire. It is a single
  // statement per tier and runs under the same transaction as the payment
  // and order updates.
  for (const item of items) {
    await client.query(
      `UPDATE ticket_tiers
          SET reserved = reserved - $2::int,
              sold     = sold     + $2::int
        WHERE id = $1
          AND reserved >= $2::int`,
      [item.tier_id, item.quantity],
    );
  }

  // State transition guarded by the current status. A concurrent cancel or
  // sweeper that already moved the order will make this match zero rows, in
  // which case we fall into the refund path instead of silently desyncing.
  const upd = await client.query(
    `UPDATE orders
        SET status = 'paid',
            paid_at = now(),
            expires_at = NULL
      WHERE id = $1 AND status = 'awaiting_payment'`,
    [order.id],
  );
  if (upd.rowCount === 0) {
    // Extremely unlikely (we hold the row lock), but handle it.
    await applyRefundPending(client, payment, order, parsed, 'Order transition raced');
    return;
  }

  await client.query(
    `UPDATE payments
        SET status = 'succeeded',
            succeeded_at = now(),
            provider_ref = COALESCE(provider_ref, $2),
            failure_code = NULL,
            failure_reason = NULL
      WHERE id = $1`,
    [payment.id, parsed.providerRef],
  );

  await insertOutbox(client, 'order.paid', order.id, {
    orderId: order.id,
    paymentId: payment.id,
    receiptNumber: parsed.receiptNumber ?? null,
  });
}

async function applyPaidAfterExpiry(
  client: PoolClient,
  payment: PaymentRow,
  order: OrderRow,
  items: OrderItemRow[],
  parsed: ParsedWebhook,
): Promise<void> {
  // Policy: try to re-claim inventory. The buyer already paid; getting them
  // their tickets is the better outcome than a refund. If re-claiming would
  // oversell, fall back to refund_pending.
  //
  // Mechanism: a savepoint around the re-claim attempt. If any tier's
  // conditional UPDATE matches zero rows, we roll back to the savepoint and
  // take the refund path. The savepoint is what lets us undo a *partial*
  // re-claim without unwinding the payment_events insert done by the caller.
  //
  // Trade-off: re-claiming may mean a ticket that was already resold to
  // someone else is now also sold to the first buyer — except it cannot,
  // because the conditional UPDATE only fires if capacity - sold - reserved
  // is still >= qty. The exception is when a tier's capacity was *increased*
  // between expiry and the callback; then the first buyer wins the newly
  // added capacity. That is correct behavior (the organizer grew supply).
  await client.query('SAVEPOINT reclaim');
  let reclaimOk = true;
  for (const item of items) {
    const upd = await client.query(
      `UPDATE ticket_tiers
          SET sold = sold + $2::int
        WHERE id = $1
          AND capacity - sold - reserved >= $2::int`,
      [item.tier_id, item.quantity],
    );
    if (upd.rowCount === 0) {
      reclaimOk = false;
      break;
    }
  }

  if (!reclaimOk) {
    await client.query('ROLLBACK TO SAVEPOINT reclaim');
    await client.query('RELEASE SAVEPOINT reclaim');
    await applyRefundPending(
      client,
      payment,
      order,
      parsed,
      'Reservation expired and inventory could not be re-claimed',
    );
    return;
  }
  await client.query('RELEASE SAVEPOINT reclaim');

  const upd = await client.query(
    `UPDATE orders
        SET status = 'paid',
            paid_at = now(),
            expires_at = NULL,
            failed_reason = COALESCE(failed_reason, 're-claimed after expiry')
      WHERE id = $1 AND status = 'expired'`,
    [order.id],
  );
  if (upd.rowCount === 0) {
    await applyRefundPending(client, payment, order, parsed, 'Order transition raced');
    return;
  }

  await client.query(
    `UPDATE payments
        SET status = 'succeeded',
            succeeded_at = now(),
            provider_ref = COALESCE(provider_ref, $2),
            failure_code = NULL,
            failure_reason = NULL
      WHERE id = $1`,
    [payment.id, parsed.providerRef],
  );

  await insertOutbox(client, 'order.paid.after_expiry', order.id, {
    orderId: order.id,
    paymentId: payment.id,
    receiptNumber: parsed.receiptNumber ?? null,
  });
}

// ---------------------------------------------------------------------------
// Failure and refund paths
// ---------------------------------------------------------------------------

async function applyFailure(
  client: PoolClient,
  eventId: string,
  payment: PaymentRow,
  order: OrderRow,
  parsed: ParsedWebhook,
): Promise<void> {
  // Record the failure on the payment row. If the payment is already
  // succeeded (a failed event arriving after a success — does not happen with
  // M-Pesa but could with a flaky provider), leave it alone.
  await client.query(
    `UPDATE payments
        SET status = 'failed',
            failure_code = $2,
            failure_reason = $3
      WHERE id = $1 AND status <> 'succeeded'`,
    [payment.id, parsed.failureCode ?? 'unknown', parsed.failureReason ?? 'Payment failed'],
  );
  // The order stays awaiting_payment. The buyer can retry with a new
  // idempotency key. The sweeper will eventually expire the reservation.
  await markEventProcessed(client, eventId);
}

async function applyRefundPending(
  client: PoolClient,
  payment: PaymentRow,
  order: OrderRow,
  parsed: ParsedWebhook,
  reason: string,
): Promise<void> {
  // Mark the payment as succeeded — the money did move — but flag the order
  // for refund.
  await client.query(
    `UPDATE payments
        SET status = 'succeeded',
            succeeded_at = COALESCE(succeeded_at, now()),
            provider_ref = COALESCE(provider_ref, $2)
      WHERE id = $1`,
    [payment.id, parsed.providerRef],
  );

  // Transition the order. The state machine allows awaiting_payment → refund_pending
  // and expired → refund_pending and paid → refund_pending.
  await client.query(
    `UPDATE orders
        SET status = 'refund_pending',
            failed_reason = $2
      WHERE id = $1
        AND status IN ('awaiting_payment','expired','paid','fulfilled')`,
    [order.id, reason.slice(0, 500)],
  );

  // Record the refund. UNIQUE (payment_id) makes this idempotent: a second
  // delivery that somehow reached here would conflict and no-op.
  await client.query(
    `INSERT INTO refunds (order_id, payment_id, amount_minor, currency, reason)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (payment_id) DO NOTHING`,
    [order.id, payment.id, payment.amount_minor, payment.currency, reason.slice(0, 500)],
  );

  await insertOutbox(client, 'order.refund_pending', order.id, {
    orderId: order.id,
    paymentId: payment.id,
    reason,
    amountMinor: payment.amount_minor,
    currency: payment.currency,
  });
}

async function insertOutbox(
  client: PoolClient,
  eventType: string,
  aggregateId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  // dedupe_key is (eventType, aggregateId) so a retried apply of the same
  // logical event cannot enqueue a duplicate outbox row.
  await client.query(
    `INSERT INTO outbox_events (dedupe_key, aggregate_type, aggregate_id, event_type, payload)
     VALUES ($1, 'order', $2, $3, $4)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [`${eventType}:${aggregateId}`, aggregateId, eventType, JSON.stringify(payload)],
  );
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getPaymentForBuyer(
  buyerUserId: string,
  paymentId: string,
): Promise<PaymentView> {
  const { rows } = await pool.query<PaymentRow & { buyer_user_id: string }>(
    `SELECT p.*, o.buyer_user_id
       FROM payments p
       JOIN orders o ON o.id = p.order_id
      WHERE p.id = $1`,
    [paymentId],
  );
  const row = rows[0];
  if (!row || row.buyer_user_id !== buyerUserId) throw notFound('Payment not found');
  return toView(row);
}

/** Used by the reconciler. */
export async function findStuckPayments(olderThanSeconds: number, limit: number): Promise<PaymentRow[]> {
  const { rows } = await pool.query<PaymentRow>(
    `SELECT * FROM payments
      WHERE status = 'initiated'
        AND provider_ref IS NOT NULL
        AND created_at < now() - ($1::int * interval '1 second')
      ORDER BY created_at ASC
      LIMIT $2
      FOR UPDATE SKIP LOCKED`,
    [olderThanSeconds, limit],
  );
  return rows;
}