import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, makeOrganizer } from './helpers/app.js';
import { pool } from '../src/db/pool.js';
import { sweepOnce } from '../src/workers/sweeper.js';

// Focused tests for the sweeper's release-once semantics.
describe('sweeper — release once', () => {
  let app: FastifyInstance;
  let organizerToken: string;
  let buyerToken: string;
  let eventId: string;
  let tierId: string;

  beforeEach(async () => {
    app = await makeApp();
    const org = await makeOrganizer(app, 'sw-org@example.com');
    organizerToken = org.token;
    const buyerRes = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'sw-buyer@example.com',
        password: 'correct horse battery staple',
        displayName: 'B',
        role: 'attendee',
      },
    });
    buyerToken = buyerRes.json().accessToken as string;

    const ev = await app.inject({
      method: 'POST',
      url: '/events',
      headers: { authorization: `Bearer ${organizerToken}` },
      payload: {
        name: 'E',
        description: '',
        venue: 'V',
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
        endsAt: new Date(Date.now() + 86_400_000 + 3600_000).toISOString(),
      },
    });
    eventId = ev.json().event.id as string;
    await app.inject({
      method: 'POST',
      url: `/events/${eventId}/publish`,
      headers: { authorization: `Bearer ${organizerToken}` },
    });

    const tr = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/tiers`,
      headers: { authorization: `Bearer ${organizerToken}` },
      payload: {
        name: 'GA',
        priceMinor: 1000,
        currency: 'KES',
        capacity: 10,
        perOrderMax: 5,
        salesStart: new Date(Date.now() - 3600_000).toISOString(),
        salesEnd: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    tierId = tr.json().tier.id as string;
  });

  async function placeOrder(key: string, quantity: number): Promise<void> {
    const res = await app.inject({
      method: 'POST',
      url: '/orders',
      headers: {
        authorization: `Bearer ${buyerToken}`,
        'idempotency-key': key,
      },
      payload: { eventId, items: [{ tierId, quantity }] },
    });
    expect(res.statusCode).toBe(201);
  }

  it('expires an order with expires_at in the past and releases all reserved units', async () => {
    await placeOrder('sw-key-0001', 3);
    await placeOrder('sw-key-0002', 2);
    expect((await pool.query('SELECT reserved FROM ticket_tiers WHERE id = $1', [tierId])).rows[0].reserved).toBe(5);

    await pool.query(
      `UPDATE orders SET expires_at = now() - interval '1 minute'
        WHERE idempotency_key IN ('sw-key-0001','sw-key-0002')`,
    );

    const released = await sweepOnce();
    expect(released).toBe(2);
    expect((await pool.query('SELECT reserved FROM ticket_tiers WHERE id = $1', [tierId])).rows[0].reserved).toBe(0);
  });

  it('does not touch orders whose expires_at is in the future', async () => {
    await placeOrder('sw-key-0003', 2);
    const released = await sweepOnce();
    expect(released).toBe(0);
    expect((await pool.query('SELECT reserved FROM ticket_tiers WHERE id = $1', [tierId])).rows[0].reserved).toBe(2);
  });

  it('only transitions once even if sweepOnce is called back-to-back', async () => {
    await placeOrder('sw-key-0004', 4);
    await pool.query(
      `UPDATE orders SET expires_at = now() - interval '1 minute'
        WHERE idempotency_key = 'sw-key-0004'`,
    );
    expect(await sweepOnce()).toBe(1);
    expect(await sweepOnce()).toBe(0);
    expect(await sweepOnce()).toBe(0);
    expect((await pool.query('SELECT reserved FROM ticket_tiers WHERE id = $1', [tierId])).rows[0].reserved).toBe(0);
  });

  it('does not expire already-paid orders (state guard)', async () => {
    await placeOrder('sw-key-0005', 2);
    // Manually move the order to 'paid' — this is what Step 5 will do.
    // The state machine allows awaiting_payment -> paid.
    await pool.query(
      `UPDATE orders
          SET status = 'paid', paid_at = now(),
              expires_at = now() - interval '1 minute'
        WHERE idempotency_key = 'sw-key-0005'`,
    );
    const released = await sweepOnce();
    expect(released).toBe(0);
    // Reserved stays put for a paid order.
    expect((await pool.query('SELECT reserved FROM ticket_tiers WHERE id = $1', [tierId])).rows[0].reserved).toBe(2);
  });
});