import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, makeOrganizer } from './helpers/app.js';
import { FakeMpesaProvider } from './helpers/fake-mpesa.js';
import { pool } from '../src/db/pool.js';
import { _setProviderForTests, _resetProvidersForTests } from '../src/payments/registry.js';
import { drainAllOrphansOnce } from '../src/workers/paymentReconciler.js';

interface Ctx {
  app: FastifyInstance;
  organizerToken: string;
  buyerToken: string;
  eventId: string;
  tierId: string;
  fake: FakeMpesaProvider;
}

async function setup(capacity = 10, priceMinor = 100_000): Promise<Ctx> {
  const app = await makeApp();
  const org = await makeOrganizer(app, `pay-org-${Date.now()}@example.com`);
  const buyerRes = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      email: `pay-buyer-${Date.now()}@example.com`,
      password: 'correct horse battery staple',
      displayName: 'B',
      role: 'attendee',
    },
  });
  const buyerToken = buyerRes.json().accessToken as string;

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

  return { app, organizerToken: org.token, buyerToken, eventId, tierId, fake };
}

async function placeOrder(ctx: Ctx, key: string, quantity: number): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/orders',
    headers: { authorization: `Bearer ${ctx.buyerToken}`, 'idempotency-key': key },
    payload: { eventId: ctx.eventId, items: [{ tierId: ctx.tierId, quantity }] },
  });
  expect(res.statusCode).toBe(201);
  return res.json().order.id as string;
}

async function startPayment(ctx: Ctx, orderId: string, key: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/orders/${orderId}/pay`,
    headers: { authorization: `Bearer ${ctx.buyerToken}`, 'idempotency-key': key },
    payload: { provider: 'mpesa', phone: '+254708374149' },
  });
  expect(res.statusCode).toBe(201);
  return res.json().payment.id as string;
}

async function postMpesaCallback(
  ctx: Ctx,
  checkoutRequestId: string,
  merchantRequestId: string,
  resultCode: number,
  opts: { amountMinor?: number; receipt?: string } = {},
): Promise<void> {
  const body = {
    Body: {
      stkCallback: {
        MerchantRequestID: merchantRequestId,
        CheckoutRequestID: checkoutRequestId,
        ResultCode: resultCode,
        ResultDesc: resultCode === 0 ? 'Success' : `Failure ${resultCode}`,
        ...(resultCode === 0
          ? {
              CallbackMetadata: {
                Item: [
                  { Name: 'Amount', Value: (opts.amountMinor ?? 100_000) / 100 },
                  { Name: 'MpesaReceiptNumber', Value: opts.receipt ?? 'RCPT123' },
                  { Name: 'TransactionDate', Value: 20240101120000 },
                  { Name: 'PhoneNumber', Value: 254708374149 },
                ],
              },
            }
          : {}),
      },
    },
  };
  const res = await ctx.app.inject({ method: 'POST', url: '/webhooks/mpesa', payload: body });
  expect(res.statusCode).toBe(200);
}

async function tierCounters(tierId: string): Promise<{ sold: number; reserved: number }> {
  const { rows } = await pool.query(
    'SELECT sold, reserved FROM ticket_tiers WHERE id = $1',
    [tierId],
  );
  return rows[0]!;
}

async function orderStatus(orderId: string): Promise<string> {
  const { rows } = await pool.query('SELECT status FROM orders WHERE id = $1', [orderId]);
  return rows[0].status;
}

describe('M-Pesa payment flow', () => {
  beforeEach(() => {
    _resetProvidersForTests();
  });

  it('startPayment creates a payment row and calls initiate once', async () => {
    const ctx = await setup();
    const orderId = await placeOrder(ctx, `k1-${Date.now()}`, 2);
    const paymentId = await startPayment(ctx, orderId, `kp1-${Date.now()}`);
    expect(ctx.fake.initiateCalls).toHaveLength(1);
    const { rows } = await pool.query('SELECT provider_ref, status FROM payments WHERE id = $1', [paymentId]);
    expect(rows[0].status).toBe('initiated');
    expect(rows[0].provider_ref).toMatch(/^ws_CO_TEST_/);
  });

  it('success callback converts reserved -> sold and marks order paid', async () => {
    const ctx = await setup();
    const orderId = await placeOrder(ctx, `k2-${Date.now()}`, 2);
    await startPayment(ctx, orderId, `kp2-${Date.now()}`);
    const { rows } = await pool.query('SELECT provider_ref, merchant_request_id FROM payments WHERE order_id = $1', [orderId]);
    const { provider_ref, merchant_request_id } = rows[0];
    expect((await tierCounters(ctx.tierId)).reserved).toBe(2);

    await postMpesaCallback(ctx, provider_ref, merchant_request_id, 0, {
      amountMinor: 200_000,
      receipt: 'RECEIPT-A',
    });

    const t = await tierCounters(ctx.tierId);
    expect(t.reserved).toBe(0);
    expect(t.sold).toBe(2);
    expect(await orderStatus(orderId)).toBe('paid');
    const pay = await pool.query('SELECT status, provider_ref FROM payments WHERE order_id = $1', [orderId]);
    expect(pay.rows[0].status).toBe('succeeded');
  });

  it('delivering the same callback 5 times is a no-op after the first', async () => {
    const ctx = await setup();
    const orderId = await placeOrder(ctx, `k3-${Date.now()}`, 1);
    await startPayment(ctx, orderId, `kp3-${Date.now()}`);
    const { rows } = await pool.query('SELECT provider_ref, merchant_request_id FROM payments WHERE order_id = $1', [orderId]);
    const { provider_ref, merchant_request_id } = rows[0];

    for (let i = 0; i < 5; i++) {
      await postMpesaCallback(ctx, provider_ref, merchant_request_id, 0, {
        amountMinor: 100_000,
        receipt: 'RECEIPT-B',
      });
    }

    const t = await tierCounters(ctx.tierId);
    expect(t.sold).toBe(1);
    expect(t.reserved).toBe(0);

    const evs = await pool.query('SELECT COUNT(*)::int AS n FROM payment_events WHERE provider_event_id = $1', [provider_ref]);
    expect(evs.rows[0].n).toBe(1);
  });

  it('rejects a callback whose amount does not match the order total', async () => {
    const ctx = await setup(10, 100_000);
    const orderId = await placeOrder(ctx, `k4-${Date.now()}`, 1);
    await startPayment(ctx, orderId, `kp4-${Date.now()}`);
    const { rows } = await pool.query('SELECT provider_ref, merchant_request_id FROM payments WHERE order_id = $1', [orderId]);
    const { provider_ref, merchant_request_id } = rows[0];

    // Callback says KES 1, order is KES 1000. The amount check must refuse.
    await postMpesaCallback(ctx, provider_ref, merchant_request_id, 0, {
      amountMinor: 100,
      receipt: 'RECEIPT-C',
    });

    expect((await tierCounters(ctx.tierId)).reserved).toBe(1);
    expect(await orderStatus(orderId)).toBe('awaiting_payment');
    const pay = await pool.query('SELECT status, failure_code FROM payments WHERE order_id = $1', [orderId]);
    expect(pay.rows[0].status).toBe('failed');
    expect(pay.rows[0].failure_code).toBe('amount_mismatch');
  });

  it('failure callbacks record the reason and leave the order awaiting payment', async () => {
    const ctx = await setup();
    const orderId = await placeOrder(ctx, `k5-${Date.now()}`, 1);
    await startPayment(ctx, orderId, `kp5-${Date.now()}`);
    const { rows } = await pool.query('SELECT provider_ref, merchant_request_id FROM payments WHERE order_id = $1', [orderId]);
    const { provider_ref, merchant_request_id } = rows[0];

    await postMpesaCallback(ctx, provider_ref, merchant_request_id, 1032);

    const pay = await pool.query('SELECT status, failure_code, failure_reason FROM payments WHERE order_id = $1', [orderId]);
    expect(pay.rows[0].status).toBe('failed');
    expect(pay.rows[0].failure_code).toBe('1032');
    expect(pay.rows[0].failure_reason).toMatch(/cancel/i);
    expect(await orderStatus(orderId)).toBe('awaiting_payment');
  });

  it('re-claims inventory when success arrives after the reservation expired', async () => {
    const ctx = await setup(10, 50_000);
    const orderId = await placeOrder(ctx, `k6-${Date.now()}`, 3);
    await startPayment(ctx, orderId, `kp6-${Date.now()}`);
    const { rows } = await pool.query('SELECT provider_ref, merchant_request_id FROM payments WHERE order_id = $1', [orderId]);
    const { provider_ref, merchant_request_id } = rows[0];

    // Force expiry and release by hand to mimic the sweeper.
    await pool.query(
      `UPDATE orders SET status = 'expired', expires_at = NULL WHERE id = $1`,
      [orderId],
    );
    await pool.query(
      `UPDATE ticket_tiers SET reserved = reserved - 3 WHERE id = $1`,
      [ctx.tierId],
    );
    expect((await tierCounters(ctx.tierId)).reserved).toBe(0);

    await postMpesaCallback(ctx, provider_ref, merchant_request_id, 0, {
      amountMinor: 150_000,
      receipt: 'RECEIPT-D',
    });

    const t = await tierCounters(ctx.tierId);
    expect(t.sold).toBe(3);
    expect(t.reserved).toBe(0);
    expect(await orderStatus(orderId)).toBe('paid');

    const refunds = await pool.query('SELECT COUNT(*)::int AS n FROM refunds');
    expect(refunds.rows[0].n).toBe(0);
  });

  it('records a refund when success arrives after expiry AND inventory is gone', async () => {
    const ctx = await setup(3, 50_000);
    const orderId = await placeOrder(ctx, `k7-${Date.now()}`, 3);
    await startPayment(ctx, orderId, `kp7-${Date.now()}`);
    const { rows } = await pool.query('SELECT provider_ref, merchant_request_id FROM payments WHERE order_id = $1', [orderId]);
    const { provider_ref, merchant_request_id } = rows[0];

    await pool.query(
      `UPDATE orders SET status = 'expired', expires_at = NULL WHERE id = $1`,
      [orderId],
    );
    await pool.query(
      `UPDATE ticket_tiers SET reserved = reserved - 3, sold = sold + 3 WHERE id = $1`,
      [ctx.tierId],
    );

    await postMpesaCallback(ctx, provider_ref, merchant_request_id, 0, {
      amountMinor: 150_000,
      receipt: 'RECEIPT-E',
    });

    expect(await orderStatus(orderId)).toBe('refund_pending');
    const refunds = await pool.query('SELECT status, amount_minor, reason FROM refunds');
    expect(refunds.rows).toHaveLength(1);
    expect(refunds.rows[0].status).toBe('pending');
    expect(Number(refunds.rows[0].amount_minor)).toBe(150_000);

    const pay = await pool.query('SELECT status FROM payments WHERE order_id = $1', [orderId]);
    expect(pay.rows[0].status).toBe('succeeded');
  });

  it('handles a callback that arrives before the pay endpoint stored the ref', async () => {
    const ctx = await setup();
    const orderId = await placeOrder(ctx, `k8-${Date.now()}`, 1);

    // Simulate the race by creating a payment row manually without provider_ref.
    const ins = await pool.query(
      `INSERT INTO payments (order_id, provider, status, amount_minor, currency, idempotency_key, phone)
       VALUES ($1, 'mpesa', 'initiated', 100000, 'KES', $2, '+254708374149')
       RETURNING id`,
      [orderId, `manual-${Date.now()}`],
    );
    const paymentId = ins.rows[0].id;
    const checkoutId = `ws_CO_RACE_${Date.now()}`;
    const merchantId = `MR_RACE_${Date.now()}`;

    // Deliver the callback before the payment row has its ref.
    await postMpesaCallback(ctx, checkoutId, merchantId, 0, {
      amountMinor: 100_000,
      receipt: 'RECEIPT-RACE',
    });

    // Event is stored as an orphan.
    const orphan = await pool.query(
      `SELECT payment_id, processed_at FROM payment_events WHERE provider_event_id = $1`,
      [checkoutId],
    );
    expect(orphan.rows[0].payment_id).toBeNull();
    expect(orphan.rows[0].processed_at).toBeNull();
    // Order untouched; reservation still held.
    expect(await orderStatus(orderId)).toBe('awaiting_payment');

    // Now the pay endpoint catches up: store the ref.
    await pool.query(
      `UPDATE payments SET provider_ref = $1, merchant_request_id = $2 WHERE id = $3`,
      [checkoutId, merchantId, paymentId],
    );

    // Drain orphans — this is what startPayment does inline; here we call the
    // worker's public function to prove the safety net works too.
    const drained = await drainAllOrphansOnce(10);
    expect(drained).toBeGreaterThanOrEqual(1);

    expect(await orderStatus(orderId)).toBe('paid');
    const t = await tierCounters(ctx.tierId);
    expect(t.sold).toBe(1);
  });
});