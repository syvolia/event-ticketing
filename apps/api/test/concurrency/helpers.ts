import type { FastifyInstance } from 'fastify';
import { makeApp, makeOrganizer } from '../helpers/app.js';
import { pool } from '../../src/db/pool.js';
import { drainOutboxOnce } from '../../src/workers/outboxPublisher.js';
import { FakeMpesaProvider } from '../helpers/fake-mpesa.js';
import { _setProviderForTests } from '../../src/payments/registry.js';

export interface ConcurrencyContext {
  app: FastifyInstance;
  organizerToken: string;
  buyerToken: string;
  staffToken: string;
  eventId: string;
  tierId: string;
  tierCapacity: number;
}

export interface TierSpec {
  name: string;
  capacity: number;
  priceMinor?: number;
  perOrderMax?: number;
}

export async function setupBurstContext(
  opts: { capacity?: number; tiers?: TierSpec[] } = {},
): Promise<ConcurrencyContext> {
  const app = await makeApp();
  const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const org = await makeOrganizer(app, `burst-org-${uniq}@example.com`);

  const buyerRes = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      email: `burst-buyer-${uniq}@example.com`,
      password: 'correct horse battery staple',
      displayName: 'Buyer',
      role: 'attendee',
    },
  });
  const buyerToken = buyerRes.json().accessToken as string;

  const staffRes = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      email: `burst-staff-${uniq}@example.com`,
      password: 'correct horse battery staple',
      displayName: 'Staff',
      role: 'staff',
    },
  });
  const staffToken = staffRes.json().accessToken as string;

  const evRes = await app.inject({
    method: 'POST',
    url: '/events',
    headers: { authorization: `Bearer ${org.token}` },
    payload: {
      name: `Burst Event ${uniq}`,
      description: '',
      venue: 'V',
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      endsAt: new Date(Date.now() + 86_400_000 + 3_600_000).toISOString(),
    },
  });
  const eventId = evRes.json().event.id as string;

  await app.inject({
    method: 'POST',
    url: `/events/${eventId}/publish`,
    headers: { authorization: `Bearer ${org.token}` },
  });

  const specs: TierSpec[] = opts.tiers ?? [
    { name: 'GA', capacity: opts.capacity ?? 10, priceMinor: 50_000, perOrderMax: 50 },
  ];

  let firstTierId = '';
  for (const spec of specs) {
    const res = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/tiers`,
      headers: { authorization: `Bearer ${org.token}` },
      payload: {
        name: spec.name,
        priceMinor: spec.priceMinor ?? 50_000,
        currency: 'KES',
        capacity: spec.capacity,
        perOrderMax: spec.perOrderMax ?? spec.capacity,
        salesStart: new Date(Date.now() - 3_600_000).toISOString(),
        salesEnd: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    if (!res.ok()) throw new Error(`tier ${spec.name} create failed: ${res.statusCode} ${res.body}`);
    if (!firstTierId) firstTierId = res.json().tier.id as string;
  }

  const fake = new FakeMpesaProvider();
  _setProviderForTests('mpesa', fake);

  return {
    app,
    organizerToken: org.token,
    buyerToken,
    staffToken,
    eventId,
    tierId: firstTierId,
    tierCapacity: specs[0]!.capacity,
  };
}

export async function postOrder(
  app: FastifyInstance,
  buyerToken: string,
  body: { eventId: string; items: Array<{ tierId: string; quantity: number }> },
  idempotencyKey: string,
): Promise<{ status: number; body: unknown }> {
  const res = await app.inject({
    method: 'POST',
    url: '/orders',
    headers: {
      authorization: `Bearer ${buyerToken}`,
      'idempotency-key': idempotencyKey,
    },
    payload: body,
  });
  return { status: res.statusCode, body: res.json() };
}

export interface TierCounters {
  capacity: number;
  sold: number;
  reserved: number;
}

export async function getTierCounters(tierId: string): Promise<TierCounters> {
  const { rows } = await pool.query<TierCounters>(
    `SELECT capacity, sold, reserved FROM ticket_tiers WHERE id = $1`,
    [tierId],
  );
  return rows[0]!;
}

export interface StartedPayment {
  paymentId: string;
  providerRef: string;
  merchantRequestId: string;
}

export async function startMpesaPayment(
  app: FastifyInstance,
  buyerToken: string,
  orderId: string,
  phone = '+254708374149',
): Promise<StartedPayment> {
  const res = await app.inject({
    method: 'POST',
    url: `/orders/${orderId}/pay`,
    headers: {
      authorization: `Bearer ${buyerToken}`,
      'idempotency-key': `pay-${Date.now()}-${Math.random()}`,
    },
    payload: { provider: 'mpesa', phone },
  });
  if (!res.ok()) throw new Error(`pay failed: ${res.statusCode} ${res.body}`);
  const paymentId = res.json().payment.id as string;

  const { rows } = await pool.query<{
    provider_ref: string;
    merchant_request_id: string;
  }>(
    `SELECT provider_ref, merchant_request_id FROM payments WHERE id = $1`,
    [paymentId],
  );
  return {
    paymentId,
    providerRef: rows[0]!.provider_ref,
    merchantRequestId: rows[0]!.merchant_request_id,
  };
}

export function mpesaSuccessCallback(
  checkoutRequestId: string,
  merchantRequestId: string,
  amountMinor: number,
): Record<string, unknown> {
  return {
    Body: {
      stkCallback: {
        MerchantRequestID: merchantRequestId,
        CheckoutRequestID: checkoutRequestId,
        ResultCode: 0,
        ResultDesc: 'Success',
        CallbackMetadata: {
          Item: [
            { Name: 'Amount', Value: amountMinor / 100 },
            { Name: 'MpesaReceiptNumber', Value: `R${Date.now()}${Math.floor(Math.random() * 1000)}` },
            { Name: 'TransactionDate', Value: 20240101120000 },
            { Name: 'PhoneNumber', Value: 254708374149 },
          ],
        },
      },
    },
  };
}

export async function drainOutboxAll(maxIterations = 10): Promise<void> {
  for (let i = 0; i < maxIterations; i++) {
    const r = await drainOutboxOnce();
    if (r.processed === 0) return;
  }
}

export async function issuePaidOrder(
  app: FastifyInstance,
  buyerToken: string,
  eventId: string,
  tierId: string,
  quantity: number,
): Promise<{ orderId: string; ticketIds: string[]; qrPayloads: string[] }> {
  const idem = `issue-${Date.now()}-${Math.random()}`;
  const order = await postOrder(
    app,
    buyerToken,
    { eventId, items: [{ tierId, quantity }] },
    idem,
  );
  if (order.status !== 201) {
    throw new Error(`order failed: ${order.status} ${JSON.stringify(order.body)}`);
  }
  const orderId = (order.body as { order: { id: string } }).order.id;

  const started = await startMpesaPayment(app, buyerToken, orderId);
  const amountMinor = quantity * 50_000;
  const cb = mpesaSuccessCallback(started.providerRef, started.merchantRequestId, amountMinor);
  const cbRes = await app.inject({ method: 'POST', url: '/webhooks/mpesa', payload: cb });
  if (cbRes.statusCode !== 200) throw new Error(`callback failed: ${cbRes.statusCode}`);

  await drainOutboxAll();

  const { rows: tickets } = await pool.query<{ id: string; qr_payload: string }>(
    `SELECT id, qr_payload FROM tickets WHERE order_id = $1 ORDER BY serial_no`,
    [orderId],
  );
  return {
    orderId,
    ticketIds: tickets.map((t) => t.id),
    qrPayloads: tickets.map((t) => t.qr_payload),
  };
}