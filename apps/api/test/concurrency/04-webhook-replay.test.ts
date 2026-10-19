// Safaricom's callback delivery is at-least-once. This test proves our handler
// is idempotent: 20 concurrent copies of the same M-Pesa success callback
// produce exactly one payment transition, one `payment_events` row, correct
// sold counts, and exactly N tickets (after the outbox drains).
import { beforeEach, describe, expect, it } from 'vitest';
import {
  drainOutboxAll,
  getTierCounters,
  mpesaSuccessCallback,
  postOrder,
  setupBurstContext,
  startMpesaPayment,
  type ConcurrencyContext,
} from './helpers.js';
import { checkInvariants } from './invariants.js';
import { pool } from '../../src/db/pool.js';

describe('concurrency — M-Pesa webhook replay', () => {
  let ctx: ConcurrencyContext;

  beforeEach(async () => {
    ctx = await setupBurstContext({ capacity: 20 });
  });

  it('20 concurrent copies of the same success callback: one transition, N tickets', async () => {
    const QUANTITY = 3;

    const order = await postOrder(
      ctx.app,
      ctx.buyerToken,
      { eventId: ctx.eventId, items: [{ tierId: ctx.tierId, quantity: QUANTITY }] },
      `wh-${Date.now()}`,
    );
    expect(order.status).toBe(201);
    const orderId = (order.body as { order: { id: string } }).order.id;

    const payment = await startMpesaPayment(ctx.app, ctx.buyerToken, orderId);
    const amountMinor = QUANTITY * 50_000;
    const callbackBody = mpesaSuccessCallback(
      payment.providerRef,
      payment.merchantRequestId,
      amountMinor,
    );

    const N = 20;
    const responses = await Promise.all(
      Array.from({ length: N }, () =>
        ctx.app.inject({
          method: 'POST',
          url: '/webhooks/mpesa',
          payload: callbackBody,
        }),
      ),
    );

    // Every delivery returns 200 with the "Accepted" body. M-Pesa treats
    // anything else as a retry trigger; we want replays to be silent.
    for (const r of responses) {
      expect(r.statusCode).toBe(200);
      expect(r.json().ResultCode).toBe(0);
    }

    // Exactly one row in payment_events for this provider_event_id.
    const ev = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM payment_events WHERE provider_event_id = $1`,
      [payment.providerRef],
    );
    expect(ev.rows[0]!.n).toBe(1);

    // Exactly one payment succeeded.
    const pay = await pool.query<{ status: string; n: number }>(
      `SELECT status, (SELECT COUNT(*)::int FROM payments WHERE order_id = $2 AND status = 'succeeded') AS n
         FROM payments WHERE id = $1`,
      [payment.paymentId, orderId],
    );
    expect(pay.rows[0]!.status).toBe('succeeded');
    expect(pay.rows[0]!.n).toBe(1);

    // Order moved to paid (or fulfilled, depending on outbox timing).
    const ord = await pool.query<{ status: string }>(
      `SELECT status FROM orders WHERE id = $1`,
      [orderId],
    );
    expect(['paid', 'fulfilled']).toContain(ord.rows[0]!.status);

    // Tier counters: sold == quantity, reserved == 0.
    const counters = await getTierCounters(ctx.tierId);
    expect(counters.sold).toBe(QUANTITY);
    expect(counters.reserved).toBe(0);

    // Drain the outbox and confirm exactly QUANTITY tickets.
    await drainOutboxAll();
    const tickets = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM tickets WHERE order_id = $1`,
      [orderId],
    );
    expect(tickets.rows[0]!.n).toBe(QUANTITY);

    // Exactly one `tickets.issued` event in the outbox — the dedupe_key
    // fence prevented the replay from enqueueing a second email.
    const issuedEvents = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM outbox_events
         WHERE event_type = 'tickets.issued' AND aggregate_id = $1`,
      [orderId],
    );
    expect(issuedEvents.rows[0]!.n).toBe(1);

    await checkInvariants();
  });
});