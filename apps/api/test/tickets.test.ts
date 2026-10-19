import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, makeOrganizer } from './helpers/app.js';
import { pool } from '../src/db/pool.js';
import { withTransaction } from '../src/db/tx.js';
import { issueTicketsForOrder } from '../src/services/tickets.js';
import { drainOutboxOnce } from '../src/workers/outboxPublisher.js';
import { getActiveKey, getKeysByKid, rotateSigningKey } from '../src/qr/keys.js';
import { signTicketPayload, verifyTicketToken } from '../src/qr/signing.js';
import { FakeMpesaProvider } from './helpers/fake-mpesa.js';
import { _setProviderForTests, _resetProvidersForTests } from '../src/payments/registry.js';

interface Ctx {
  app: FastifyInstance;
  organizerToken: string;
  buyerToken: string;
  buyerId: string;
  eventId: string;
  tierId: string;
  fake: FakeMpesaProvider;
}

async function setup(capacity = 10, priceMinor = 100_000): Promise<Ctx> {
  const app = await makeApp();
  const org = await makeOrganizer(app, `t-org-${Date.now()}@example.com`);
  const buyerRes = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      email: `t-buyer-${Date.now()}@example.com`,
      password: 'correct horse battery staple',
      displayName: 'B',
      role: 'attendee',
    },
  });
  const buyerBody = buyerRes.json() as { accessToken: string; user: { id: string } };
  const buyerToken = buyerBody.accessToken;
  const buyerId = buyerBody.user.id;

  const ev = await app.inject({
    method: 'POST',
    url: '/events',
    headers: { authorization: `Bearer ${org.token}` },
    payload: {
      name: 'E',
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
  const tr = await app.inject({
    method: 'POST',
    url: `/events/${eventId}/tiers`,
    headers: { authorization: `Bearer ${org.token}` },
    payload: {
      name: 'GA',
      priceMinor,
      currency: 'KES',
      capacity,
      perOrderMax: capacity,
      salesStart: new Date(Date.now() - 3600_000).toISOString(),
      salesEnd: new Date(Date.now() + 86_400_000).toISOString(),
    },
  });
  const tierId = tr.json().tier.id as string;

  const fake = new FakeMpesaProvider();
  _setProviderForTests('mpesa', fake);
  return { app, organizerToken: org.token, buyerToken, buyerId, eventId, tierId, fake };
}

async function placePaidOrder(
  ctx: Ctx,
  key: string,
  quantity: number,
): Promise<string> {
  const orderRes = await ctx.app.inject({
    method: 'POST',
    url: '/orders',
    headers: { authorization: `Bearer ${ctx.buyerToken}`, 'idempotency-key': key },
    payload: { eventId: ctx.eventId, items: [{ tierId: ctx.tierId, quantity }] },
  });
  expect(orderRes.statusCode).toBe(201);
  const orderId = orderRes.json().order.id as string;

  const payRes = await ctx.app.inject({
    method: 'POST',
    url: `/orders/${orderId}/pay`,
    headers: { authorization: `Bearer ${ctx.buyerToken}`, 'idempotency-key': `${key}-p` },
    payload: { provider: 'mpesa', phone: '+254708374149' },
  });
  expect(payRes.statusCode).toBe(201);

  const { rows } = await pool.query<{ provider_ref: string; merchant_request_id: string }>(
    `SELECT provider_ref, merchant_request_id FROM payments WHERE order_id = $1`,
    [orderId],
  );
  const checkout = rows[0]!.provider_ref;
  const merchant = rows[0]!.merchant_request_id;

  const cb = await ctx.app.inject({
    method: 'POST',
    url: '/webhooks/mpesa',
    payload: {
      Body: {
        stkCallback: {
          MerchantRequestID: merchant,
          CheckoutRequestID: checkout,
          ResultCode: 0,
          ResultDesc: 'Success',
          CallbackMetadata: {
            Item: [
              { Name: 'Amount', Value: (quantity * 100_000) / 100 },
              { Name: 'MpesaReceiptNumber', Value: 'RCPT-TEST' },
              { Name: 'TransactionDate', Value: 20240101120000 },
              { Name: 'PhoneNumber', Value: 254708374149 },
            ],
          },
        },
      },
    },
  });
  expect(cb.statusCode).toBe(200);
  return orderId;
}

describe('ticket issuance', () => {
  beforeEach(() => {
    _resetProvidersForTests();
  });

  it('issues one ticket per unit in the paid order', async () => {
    const ctx = await setup(10);
    const orderId = await placePaidOrder(ctx, `t1-${Date.now()}`, 3);
    await drainOutboxOnce();

    const { rows } = await pool.query<{ id: string; short_code: string; status: string; kid: string }>(
      `SELECT id, short_code, status, kid FROM tickets WHERE order_id = $1 ORDER BY serial_no`,
      [orderId],
    );
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.status).toBe('valid');
      expect(r.short_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    }
    // short codes are unique by construction (DB unique index)
    expect(new Set(rows.map((r) => r.short_code)).size).toBe(3);

    const ord = await pool.query<{ status: string }>('SELECT status FROM orders WHERE id = $1', [orderId]);
    expect(ord.rows[0]!.status).toBe('fulfilled');
  });

  it('replaying issueTicketsForOrder 10 times inserts exactly N tickets', async () => {
    const ctx = await setup(20);
    // Create an order via the API so all its rows exist, but skip the payment
    // webhook — we want to drive issuance directly.
    const orderRes = await ctx.app.inject({
      method: 'POST',
      url: '/orders',
      headers: { authorization: `Bearer ${ctx.buyerToken}`, 'idempotency-key': `replay-${Date.now()}` },
      payload: { eventId: ctx.eventId, items: [{ tierId: ctx.tierId, quantity: 4 }] },
    });
    const orderId = orderRes.json().order.id as string;

    const key = await getActiveKey();
    for (let i = 0; i < 10; i++) {
      await withTransaction((client) => issueTicketsForOrder(client, orderId, key), {
        label: 'replay',
      });
    }

    const { rows } = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM tickets WHERE order_id = $1`,
      [orderId],
    );
    expect(rows[0]!.n).toBe(4);

    // serial_no 1..4 for the single order_item, no gaps, no duplicates
    const serials = await pool.query<{ serial_no: number }>(
      `SELECT serial_no FROM tickets WHERE order_id = $1 ORDER BY serial_no`,
      [orderId],
    );
    expect(serials.rows.map((r) => r.serial_no)).toEqual([1, 2, 3, 4]);
  });

  it('replaying the whole outbox flow 10 times still yields exactly N tickets', async () => {
    const ctx = await setup(20);
    const orderId = await placePaidOrder(ctx, `replay-out-${Date.now()}`, 5);

    for (let i = 0; i < 10; i++) {
      // On tick 1, order.paid is processed; on tick 2, tickets.issued is
      // processed; on ticks 3-10 nothing new appears. The invariant we assert
      // is that no tick can produce a duplicate ticket.
      await drainOutboxOnce();
    }

    const { rows } = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM tickets WHERE order_id = $1`,
      [orderId],
    );
    expect(rows[0]!.n).toBe(5);

    // Exactly one payment_events row per provider_event_id — replays of the
    // webhook do not enqueue a second order.paid.
    const ev = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM outbox_events WHERE event_type = 'tickets.issued' AND aggregate_id = $1`,
      [orderId],
    );
    expect(ev.rows[0]!.n).toBe(1);
  });
});

describe('QR signing and verification', () => {
  it('a signed payload verifies and contains the right ticket/event ids', async () => {
    const key = await getActiveKey();
    const token = signTicketPayload(
      { t: '11111111-1111-1111-1111-111111111111', e: '22222222-2222-2222-2222-222222222222', v: 1 },
      key.kid,
      key.secret,
    );
    const keys = await getKeysByKid();
    const result = verifyTicketToken(token, keys);
    expect(result).not.toBeNull();
    expect(result!.payload.t).toBe('11111111-1111-1111-1111-111111111111');
    expect(result!.payload.e).toBe('22222222-2222-2222-2222-222222222222');
    expect(result!.kid).toBe(key.kid);
  });

  it('a payload tampered with in flight fails verification', async () => {
    const key = await getActiveKey();
    const good = signTicketPayload(
      { t: '33333333-3333-3333-3333-333333333333', e: '44444444-4444-4444-4444-444444444444', v: 1 },
      key.kid,
      key.secret,
    );
    // Flip a character in the payload section (third segment).
    const parts = good.split('.');
    parts[2] = parts[2]!.slice(0, -1) + (parts[2]!.endsWith('A') ? 'B' : 'A');
    const bad = parts.join('.');
    const keys = await getKeysByKid();
    expect(verifyTicketToken(bad, keys)).toBeNull();
  });

  it('a payload signed with a different kid fails when that kid is unknown', async () => {
    const key = await getActiveKey();
    const token = signTicketPayload(
      { t: '55555555-5555-5555-5555-555555555555', e: '66666666-6666-6666-6666-666666666666', v: 1 },
      'k_doesnotexist',
      key.secret,
    );
    const keys = await getKeysByKid();
    expect(verifyTicketToken(token, keys)).toBeNull();
  });

  it('tokens signed with a retired key still verify after rotation', async () => {
    const before = await getActiveKey();
    const oldToken = signTicketPayload(
      { t: '77777777-7777-7777-7777-777777777777', e: '88888888-8888-8888-8888-888888888888', v: 1 },
      before.kid,
      before.secret,
    );
    const after = await rotateSigningKey();
    expect(after.kid).not.toBe(before.kid);

    const keys = await getKeysByKid();
    // Old token still verifies because the retired key remains in the map.
    expect(verifyTicketToken(oldToken, keys)).not.toBeNull();

    // New tokens are signed with the new kid.
    const newToken = signTicketPayload(
      { t: '99999999-9999-9999-9999-999999999999', e: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', v: 1 },
      after.kid,
      after.secret,
    );
    const verified = verifyTicketToken(newToken, keys);
    expect(verified).not.toBeNull();
    expect(verified!.kid).toBe(after.kid);
  });
});

describe('void', () => {
  beforeEach(() => {
    _resetProvidersForTests();
  });

  it('organizer voids a ticket and its status becomes void', async () => {
    const ctx = await setup(5);
    const orderId = await placePaidOrder(ctx, `void-${Date.now()}`, 2);
    await drainOutboxOnce();
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM tickets WHERE order_id = $1 ORDER BY serial_no`,
      [orderId],
    );
    const ticketId = rows[0]!.id;

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/tickets/${ticketId}/void`,
      headers: { authorization: `Bearer ${ctx.organizerToken}` },
      payload: { reason: 'Chargeback' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ticket.status).toBe('void');

    // Idempotent: voiding again is a no-op returning the same state.
    const again = await ctx.app.inject({
      method: 'POST',
      url: `/tickets/${ticketId}/void`,
      headers: { authorization: `Bearer ${ctx.organizerToken}` },
      payload: { reason: 'Retry' },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().ticket.status).toBe('void');
  });

  it('a non-owner cannot void a ticket', async () => {
    const ctx = await setup(5);
    const orderId = await placePaidOrder(ctx, `void-own-${Date.now()}`, 1);
    await drainOutboxOnce();
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM tickets WHERE order_id = $1`,
      [orderId],
    );
    const ticketId = rows[0]!.id;

    const other = await makeOrganizer(ctx.app, `other-${Date.now()}@example.com`);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/tickets/${ticketId}/void`,
      headers: { authorization: `Bearer ${other.token}` },
      payload: { reason: 'Hijack' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('my tickets endpoint', () => {
  it('returns only the caller\'s tickets', async () => {
    const ctx = await setup(5);
    const orderId = await placePaidOrder(ctx, `my-${Date.now()}`, 2);
    await drainOutboxOnce();

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/tickets',
      headers: { authorization: `Bearer ${ctx.buyerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tickets: Array<{ orderId: string; shortCode: string }> };
    expect(body.tickets).toHaveLength(2);
    for (const t of body.tickets) {
      expect(t.orderId).toBe(orderId);
      expect(t.shortCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    }
  });
});