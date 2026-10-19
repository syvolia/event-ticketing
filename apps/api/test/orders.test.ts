import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, makeOrganizer } from './helpers/app.js';
import { pool } from '../src/db/pool.js';
import { sweepOnce } from '../src/workers/sweeper.js';

interface Ctx {
  app: FastifyInstance;
  organizerToken: string;
  buyerToken: string;
  eventId: string;
}

async function setup(): Promise<Ctx> {
  const app = await makeApp();
  const org = await makeOrganizer(app, 'sweep-org@example.com');
  const buyerRes = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      email: 'buyer@example.com',
      password: 'correct horse battery staple',
      displayName: 'Buyer',
      role: 'attendee',
    },
  });
  const buyerToken = buyerRes.json().accessToken as string;

  const ev = await app.inject({
    method: 'POST',
    url: '/events',
    headers: { authorization: `Bearer ${org.token}` },
    payload: {
      name: 'Concert',
      description: '',
      venue: 'V',
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      endsAt: new Date(Date.now() + 86_400_000 + 3600_000).toISOString(),
    },
  });
  const eventId = ev.json().event.id as string;
  await app.inject({
    method: 'POST',
    url: `/events/${eventId}/publish`,
    headers: { authorization: `Bearer ${org.token}` },
  });
  return { app, organizerToken: org.token, buyerToken, eventId };
}

async function makeTier(
  ctx: Ctx,
  opts: { name: string; capacity: number; priceMinor?: number; perOrderMax?: number },
): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/events/${ctx.eventId}/tiers`,
    headers: { authorization: `Bearer ${ctx.organizerToken}` },
    payload: {
      name: opts.name,
      priceMinor: opts.priceMinor ?? 100_000,
      currency: 'KES',
      capacity: opts.capacity,
      perOrderMax: opts.perOrderMax ?? Math.min(opts.capacity, 10),
      salesStart: new Date(Date.now() - 3600_000).toISOString(),
      salesEnd: new Date(Date.now() + 86_400_000).toISOString(),
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().tier.id as string;
}

async function postOrder(
  ctx: Ctx,
  idempotencyKey: string,
  items: { tierId: string; quantity: number }[],
): Promise<{ status: number; body: unknown }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/orders',
    headers: {
      authorization: `Bearer ${ctx.buyerToken}`,
      'idempotency-key': idempotencyKey,
    },
    payload: { eventId: ctx.eventId, items },
  });
  return { status: res.statusCode, body: res.json() };
}

async function tierCounters(tierId: string): Promise<{ sold: number; reserved: number; capacity: number }> {
  const { rows } = await pool.query(
    'SELECT sold, reserved, capacity FROM ticket_tiers WHERE id = $1',
    [tierId],
  );
  return rows[0]!;
}

describe('POST /orders — reservation engine', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('creates an order, reserves inventory, and returns totals from DB prices', async () => {
    const tierId = await makeTier(ctx, { name: 'GA', capacity: 10, priceMinor: 50_000 });
    const { status, body } = await postOrder(ctx, 'key-aaaa-1111', [{ tierId, quantity: 2 }]);
    expect(status).toBe(201);
    const order = (body as { order: { totalMinor: number; items: { unitPriceMinor: number }[] } }).order;
    expect(order.totalMinor).toBe(100_000);
    expect(order.items[0]!.unitPriceMinor).toBe(50_000);

    const t = await tierCounters(tierId);
    expect(t.reserved).toBe(2);
    expect(t.sold).toBe(0);
  });

  it('is idempotent on the same Idempotency-Key (no double reservation)', async () => {
    const tierId = await makeTier(ctx, { name: 'GA', capacity: 10 });
    const first = await postOrder(ctx, 'key-bbbb-2222', [{ tierId, quantity: 3 }]);
    expect(first.status).toBe(201);
    const second = await postOrder(ctx, 'key-bbbb-2222', [{ tierId, quantity: 3 }]);
    // Second call returns 200 with the SAME order.
    expect(second.status).toBe(200);
    const id1 = (first.body as { order: { id: string } }).order.id;
    const id2 = (second.body as { order: { id: string } }).order.id;
    expect(id2).toBe(id1);

    const t = await tierCounters(tierId);
    expect(t.reserved).toBe(3);
  });

  it('returns 409 when quantity exceeds per-order max', async () => {
    const tierId = await makeTier(ctx, { name: 'GA', capacity: 10, perOrderMax: 2 });
    const { status, body } = await postOrder(ctx, 'key-cccc-3333', [{ tierId, quantity: 3 }]);
    expect(status).toBe(409);
    expect((body as { error: { details: { reason: string } } }).error.details.reason).toBe(
      'EXCEEDS_PER_ORDER_MAX',
    );
  });

  it('returns 409 when the sales window has closed', async () => {
    const tierId = await makeTier(ctx, { name: 'GA', capacity: 10 });
    // Force sales_end into the past directly.
    await pool.query(
      `UPDATE ticket_tiers SET sales_end = now() - interval '1 hour' WHERE id = $1`,
      [tierId],
    );
    const { status, body } = await postOrder(ctx, 'key-dddd-4444', [{ tierId, quantity: 1 }]);
    expect(status).toBe(409);
    expect((body as { error: { details: { reason: string } } }).error.details.reason).toBe(
      'SALES_CLOSED',
    );
  });

  it('rolls back a partial reservation when a second tier fails', async () => {
    const good = await makeTier(ctx, { name: 'GA', capacity: 10 });
    const bad = await makeTier(ctx, { name: 'VIP', capacity: 5, perOrderMax: 2 });
    const { status } = await postOrder(ctx, 'key-eeee-5555', [
      { tierId: good, quantity: 3 },
      { tierId: bad, quantity: 5 },
    ]);
    expect(status).toBe(409);
    // The good tier's reservation must have been rolled back.
    const t = await tierCounters(good);
    expect(t.reserved).toBe(0);
  });

  it('concurrency: 100 parallel buyers on 10 tickets, exactly 10 win', async () => {
    const tierId = await makeTier(ctx, { name: 'GA', capacity: 10, perOrderMax: 1 });
    const N = 100;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        postOrder(ctx, `race-key-${i.toString().padStart(6, '0')}`, [
          { tierId, quantity: 1 },
        ]),
      ),
    );
    const created = results.filter((r) => r.status === 201).length;
    const conflicts = results.filter((r) => r.status === 409).length;
    expect(created).toBe(10);
    expect(conflicts).toBe(N - 10);

    const t = await tierCounters(tierId);
    expect(t.reserved).toBe(10);
    expect(t.reserved + t.sold).toBeLessThanOrEqual(t.capacity);
  });

  it('sweeper releases an expired order exactly once', async () => {
    const tierId = await makeTier(ctx, { name: 'GA', capacity: 10 });
    const { status } = await postOrder(ctx, 'key-sweep-0001', [{ tierId, quantity: 4 }]);
    expect(status).toBe(201);
    expect((await tierCounters(tierId)).reserved).toBe(4);

    // Simulate time passing.
    await pool.query(
      `UPDATE orders SET expires_at = now() - interval '1 minute'
        WHERE idempotency_key = 'key-sweep-0001'`,
    );

    const released = await sweepOnce();
    expect(released).toBe(1);
    expect((await tierCounters(tierId)).reserved).toBe(0);

    // Second sweep is a no-op (no double release, no double-status change).
    const again = await sweepOnce();
    expect(again).toBe(0);
    expect((await tierCounters(tierId)).reserved).toBe(0);

    const ord = await pool.query(
      `SELECT status FROM orders WHERE idempotency_key = 'key-sweep-0001'`,
    );
    expect(ord.rows[0].status).toBe('expired');
  });
});