// The buyer double-taps Pay. The client sends the same Idempotency-Key 50
// times. Exactly one order must exist, with exactly the requested quantity
// reserved — never 50 × quantity.
import { beforeEach, describe, expect, it } from 'vitest';
import { postOrder, setupBurstContext, type ConcurrencyContext } from './helpers.js';
import { checkInvariants } from './invariants.js';
import { pool } from '../../src/db/pool.js';

describe('concurrency — idempotency key', () => {
  let ctx: ConcurrencyContext;

  beforeEach(async () => {
    ctx = await setupBurstContext({ capacity: 20 });
  });

  it('50 concurrent requests with the same Idempotency-Key produce exactly one order', async () => {
    const KEY = `idem-${Date.now()}`;
    const N = 50;
    const QUANTITY = 2;

    const results = await Promise.all(
      Array.from({ length: N }, () =>
        postOrder(
          ctx.app,
          ctx.buyerToken,
          { eventId: ctx.eventId, items: [{ tierId: ctx.tierId, quantity: QUANTITY }] },
          KEY,
        ),
      ),
    );

    // Exactly one request wins the INSERT race with a 201. Every other
    // request receives the existing order with a 200. Zero requests error.
    const created = results.filter((r) => r.status === 201).length;
    const returned = results.filter((r) => r.status === 200).length;
    expect(created).toBe(1);
    expect(returned).toBe(N - 1);
    expect(created + returned).toBe(N);

    // All responses reference the same order id.
    const orderIds = new Set(
      results.map((r) => (r.body as { order: { id: string } }).order.id),
    );
    expect(orderIds.size).toBe(1);
    const orderId = [...orderIds][0]!;

    // Exactly one row in the orders table for this (buyer, key).
    const { rows: orders } = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM orders WHERE id = $1`,
      [orderId],
    );
    expect(orders[0]!.n).toBe(1);

    // The reservation is exactly `QUANTITY`, not `N × QUANTITY`.
    const { rows: counters } = await pool.query<{ sold: number; reserved: number }>(
      `SELECT sold, reserved FROM ticket_tiers WHERE id = $1`,
      [ctx.tierId],
    );
    expect(counters[0]!.reserved).toBe(QUANTITY);
    expect(counters[0]!.sold).toBe(0);

    await checkInvariants();
  });

  it('a different Idempotency-Key from the same buyer creates a second order', async () => {
    const base = `idem-b-${Date.now()}`;

    const [a, b] = await Promise.all([
      postOrder(
        ctx.app,
        ctx.buyerToken,
        { eventId: ctx.eventId, items: [{ tierId: ctx.tierId, quantity: 1 }] },
        `${base}-a`,
      ),
      postOrder(
        ctx.app,
        ctx.buyerToken,
        { eventId: ctx.eventId, items: [{ tierId: ctx.tierId, quantity: 1 }] },
        `${base}-b`,
      ),
    ]);

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const idA = (a.body as { order: { id: string } }).order.id;
    const idB = (b.body as { order: { id: string } }).order.id;
    expect(idA).not.toBe(idB);

    const { rows: counters } = await pool.query<{ sold: number; reserved: number }>(
      `SELECT sold, reserved FROM ticket_tiers WHERE id = $1`,
      [ctx.tierId],
    );
    // Two orders → two reservations.
    expect(counters[0]!.reserved).toBe(2);

    await checkInvariants();
  });
});