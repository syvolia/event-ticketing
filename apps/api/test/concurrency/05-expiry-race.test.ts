// The reservation expires while the buyer is still on the M-Pesa prompt.
// The sweeper fires at the exact moment the success callback arrives. Both
// take a row lock on the order; only one proceeds first, and the loser sees
// the winner's committed state.
//
// Deterministic outcome for this setup (capacity 10, quantity 2, no other
// orders): the callback ultimately wins either way.
//   - Callback first: order goes awaiting_payment -> paid. Sweeper's SELECT
//     sees status='paid' and skips.
//   - Sweeper first: order goes awaiting_payment -> expired, reserved
//     decremented. Callback's `applyPaidAfterExpiry` re-claims the released
//     inventory and moves the order expired -> paid.
// In both cases the final state is: sold=2, reserved=0, two tickets, no
// refunds. That is the assertion.
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
import { sweepOnce } from '../../src/workers/sweeper.js';

describe('concurrency — expiry worker vs. payment callback', () => {
  let ctx: ConcurrencyContext;

  beforeEach(async () => {
    ctx = await setupBurstContext({ capacity: 10 });
  });

  it('single race: final state is consistent regardless of who wins', async () => {
    const QUANTITY = 2;
    const order = await postOrder(
      ctx.app,
      ctx.buyerToken,
      { eventId: ctx.eventId, items: [{ tierId: ctx.tierId, quantity: QUANTITY }] },
      `race-${Date.now()}`,
    );
    expect(order.status).toBe(201);
    const orderId = (order.body as { order: { id: string } }).order.id;

    const payment = await startMpesaPayment(ctx.app, ctx.buyerToken, orderId);
    const callbackBody = mpesaSuccessCallback(
      payment.providerRef,
      payment.merchantRequestId,
      QUANTITY * 50_000,
    );

    // Force the reservation to look expired so the sweeper will claim it.
    await pool.query(
      `UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [orderId],
    );

    // Fire both operations in the same tick. Promise.all fires them without
    // awaiting, so the DB decides the winner.
    await Promise.all([
      sweepOnce(),
      ctx.app.inject({ method: 'POST', url: '/webhooks/mpesa', payload: callbackBody }),
    ]);

    // Drain the outbox to issue tickets / send email.
    await drainOutboxAll();

    // ---- Deterministic assertions ------------------------------------

    const counters = await getTierCounters(ctx.tierId);
    // Whichever path won, the net effect is: 2 tickets sold for this order,
    // 0 reserved. Not 0/2, not 2/2, not 4/0.
    expect(counters.sold).toBe(QUANTITY);
    expect(counters.reserved).toBe(0);
    expect(counters.sold + counters.reserved).toBeLessThanOrEqual(counters.capacity);

    const { rows: tickets } = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM tickets WHERE order_id = $1`,
      [orderId],
    );
    expect(tickets[0]!.n).toBe(QUANTITY);

    // No refund was created — the reservation was re-claimed in the sweeper-
    // first case, and never expired in the callback-first case.
    const { rows: refunds } = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM refunds WHERE order_id = $1`,
      [orderId],
    );
    expect(refunds[0]!.n).toBe(0);

    // The order reached a terminal paid state.
    const { rows: ord } = await pool.query<{ status: string }>(
      `SELECT status FROM orders WHERE id = $1`,
      [orderId],
    );
    expect(['paid', 'fulfilled']).toContain(ord.rows[0]!.status);

    await checkInvariants();
  });

  it('repeat the race 20 times to catch schedule-dependent bugs', async () => {
    for (let i = 0; i < 20; i++) {
      const local = await setupBurstContext({ capacity: 5 });
      const order = await postOrder(
        local.app,
        local.buyerToken,
        { eventId: local.eventId, items: [{ tierId: local.tierId, quantity: 1 }] },
        `rep-${i}-${Date.now()}`,
      );
      const orderId = (order.body as { order: { id: string } }).order.id;
      const payment = await startMpesaPayment(local.app, local.buyerToken, orderId);
      const callbackBody = mpesaSuccessCallback(
        payment.providerRef,
        payment.merchantRequestId,
        50_000,
      );
      await pool.query(
        `UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = $1`,
        [orderId],
      );

      await Promise.all([
        sweepOnce(),
        local.app.inject({ method: 'POST', url: '/webhooks/mpesa', payload: callbackBody }),
      ]);
      await drainOutboxAll();

      const counters = await getTierCounters(local.tierId);
      expect(counters.sold).toBe(1);
      expect(counters.reserved).toBe(0);
    }
    await checkInvariants();
  });
});