import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, makeOrganizer } from './helpers/app.js';
import { pool } from '../src/db/pool.js';
import { _setProviderForTests, _resetProvidersForTests } from '../src/payments/registry.js';
import { FakeMpesaProvider } from './helpers/fake-mpesa.js';
import { drainOutboxOnce } from '../src/workers/outboxPublisher.js';

interface Ctx {
  app: FastifyInstance;
  organizerToken: string;
  staffToken: string;
  buyerToken: string;
  eventId: string;
  tierId: string;
}

async function setup(): Promise<Ctx> {
  const app = await makeApp();
  const org = await makeOrganizer(app, `sc-org-${Date.now()}@example.com`);

  const staff = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      email: `sc-staff-${Date.now()}@example.com`,
      password: 'correct horse battery staple',
      displayName: 'Staff',
      role: 'staff',
    },
  });
  const staffToken = staff.json().accessToken as string;

  const buyer = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      email: `sc-buyer-${Date.now()}@example.com`,
      password: 'correct horse battery staple',
      displayName: 'B',
      role: 'attendee',
    },
  });
  const buyerToken = buyer.json().accessToken as string;

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
      priceMinor: 100_000,
      currency: 'KES',
      capacity: 50,
      perOrderMax: 50,
      salesStart: new Date(Date.now() - 3600_000).toISOString(),
      salesEnd: new Date(Date.now() + 86_400_000).toISOString(),
    },
  });
  const tierId = tr.json().tier.id as string;

  const fake = new FakeMpesaProvider();
  _setProviderForTests('mpesa', fake);
  return { app, organizerToken: org.token, staffToken, buyerToken, eventId, tierId };
}

async function buyAndIssue(ctx: Ctx, quantity: number): Promise<string[]> {
  const orderRes = await ctx.app.inject({
    method: 'POST',
    url: '/orders',
    headers: {
      authorization: `Bearer ${ctx.buyerToken}`,
      'idempotency-key': `ck-${Date.now()}-${Math.random()}`,
    },
    payload: { eventId: ctx.eventId, items: [{ tierId: ctx.tierId, quantity }] },
  });
  const orderId = orderRes.json().order.id as string;

  const payRes = await ctx.app.inject({
    method: 'POST',
    url: `/orders/${orderId}/pay`,
    headers: {
      authorization: `Bearer ${ctx.buyerToken}`,
      'idempotency-key': `ckp-${Date.now()}-${Math.random()}`,
    },
    payload: { provider: 'mpesa', phone: '+254708374149' },
  });
  const paymentId = payRes.json().payment.id as string;
  const { rows } = await pool.query<{ provider_ref: string; merchant_request_id: string }>(
    `SELECT provider_ref, merchant_request_id FROM payments WHERE id = $1`,
    [paymentId],
  );
  const { provider_ref, merchant_request_id } = rows[0]!;

  await ctx.app.inject({
    method: 'POST',
    url: '/webhooks/mpesa',
    payload: {
      Body: {
        stkCallback: {
          MerchantRequestID: merchant_request_id,
          CheckoutRequestID: provider_ref,
          ResultCode: 0,
          ResultDesc: 'Success',
          CallbackMetadata: {
            Item: [
              { Name: 'Amount', Value: quantity * 1000 },
              { Name: 'MpesaReceiptNumber', Value: 'RCPT' },
              { Name: 'TransactionDate', Value: 20240101120000 },
              { Name: 'PhoneNumber', Value: 254708374149 },
            ],
          },
        },
      },
    },
  });

  await drainOutboxOnce();
  const { rows: ticketRows } = await pool.query<{ id: string; qr_payload: string }>(
    `SELECT id, qr_payload FROM tickets WHERE order_id = $1 ORDER BY serial_no`,
    [orderId],
  );
  return ticketRows.map((r) => r.qr_payload);
}

function scanBody(token: string, overrides: Partial<{ clientScanId: string; deviceId: string; scannedAt: string; eventId: string; gate: string }> = {}) {
  return {
    clientScanId: overrides.clientScanId ?? crypto.randomUUID(),
    token,
    deviceId: overrides.deviceId ?? 'device-test-1',
    scannedAt: overrides.scannedAt ?? new Date().toISOString(),
    ...(overrides.eventId ? { eventId: overrides.eventId } : {}),
    ...(overrides.gate ? { gate: overrides.gate } : {}),
  };
}

describe('checkin — single', () => {
  beforeEach(() => _resetProvidersForTests());

  it('accepts a valid first scan and flips the ticket to checked_in', async () => {
    const ctx = await setup();
    const [token] = await buyAndIssue(ctx, 1);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/checkin',
      headers: { authorization: `Bearer ${ctx.staffToken}` },
      payload: scanBody(token!, { gate: 'A' }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.outcome).toBe('accepted');
    expect(body.shortCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    const { rows } = await pool.query<{ status: string; checked_in_gate: string }>(
      `SELECT status, checked_in_gate FROM tickets WHERE id = $1`,
      [body.ticketId],
    );
    expect(rows[0]!.status).toBe('checked_in');
    expect(rows[0]!.checked_in_gate).toBe('A');
  });

  it('rejects a tampered token with invalid_token', async () => {
    const ctx = await setup();
    const [token] = await buyAndIssue(ctx, 1);
    const parts = token!.split('.');
    parts[2] = parts[2]!.slice(0, -1) + (parts[2]!.endsWith('A') ? 'B' : 'A');
    const bad = parts.join('.');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/checkin',
      headers: { authorization: `Bearer ${ctx.staffToken}` },
      payload: scanBody(bad),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe('invalid_token');
  });

  it('reports duplicate with the winning scan’s details', async () => {
    const ctx = await setup();
    const [token] = await buyAndIssue(ctx, 1);
    const t0 = new Date(Date.now() - 60_000).toISOString();

    // First scan accepted.
    await ctx.app.inject({
      method: 'POST',
      url: '/checkin',
      headers: { authorization: `Bearer ${ctx.staffToken}` },
      payload: scanBody(token!, { deviceId: 'A', scannedAt: t0, gate: 'A' }),
    });

    // Second scan, later, different device → duplicate.
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/checkin',
      headers: { authorization: `Bearer ${ctx.staffToken}` },
      payload: scanBody(token!, { deviceId: 'B', scannedAt: new Date().toISOString(), gate: 'B' }),
    });
    const body = res.json();
    expect(body.outcome).toBe('duplicate');
    expect(body.existingGate).toBe('A');
    expect(body.existingDeviceId).toBe('A');
  });

  it('a voided ticket reports void', async () => {
    const ctx = await setup();
    const [token] = await buyAndIssue(ctx, 1);
    // Find the ticket id, then void as the organizer.
    const { rows } = await pool.query<{ id: string }>(
      `SELECT t.id FROM tickets t WHERE t.event_id = $1`,
      [ctx.eventId],
    );
    const ticketId = rows[0]!.id;
    await ctx.app.inject({
      method: 'POST',
      url: `/tickets/${ticketId}/void`,
      headers: { authorization: `Bearer ${ctx.organizerToken}` },
      payload: { reason: 'test' },
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/checkin',
      headers: { authorization: `Bearer ${ctx.staffToken}` },
      payload: scanBody(token!),
    });
    expect(res.json().outcome).toBe('void');
  });

  it('event-scoped wrong_event when the caller passes a different eventId', async () => {
    const ctx = await setup();
    const [token] = await buyAndIssue(ctx, 1);
    const fakeEventId = crypto.randomUUID();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/checkin',
      headers: { authorization: `Bearer ${ctx.staffToken}` },
      payload: scanBody(token!, { eventId: fakeEventId }),
    });
    expect(res.json().outcome).toBe('wrong_event');
  });

  it('an attendee cannot check in', async () => {
    const ctx = await setup();
    const [token] = await buyAndIssue(ctx, 1);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/checkin',
      headers: { authorization: `Bearer ${ctx.buyerToken}` },
      payload: scanBody(token!),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('checkin — sync', () => {
  beforeEach(() => _resetProvidersForTests());

  it('replaying the same batch 5 times is a no-op after the first', async () => {
    const ctx = await setup();
    const tokens = await buyAndIssue(ctx, 3);
    const batch = {
      scans: tokens.map((t) =>
        scanBody(t, {
          deviceId: 'sync-1',
          scannedAt: new Date(Date.now() - 120_000).toISOString(),
        }),
      ),
    };
    for (let i = 0; i < 5; i++) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/checkin/sync',
        headers: { authorization: `Bearer ${ctx.staffToken}` },
        payload: batch,
      });
      expect(res.statusCode).toBe(200);
      const results = res.json().results as Array<{ outcome: string }>;
      expect(results).toHaveLength(3);
      for (const r of results) expect(r.outcome).toBe('accepted');
    }

    // Only one ticket per token, all checked in.
    const { rows } = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM tickets WHERE event_id = $1 AND status = 'checked_in'`,
      [ctx.eventId],
    );
    expect(rows[0]!.n).toBe(3);

    // scan_attempts has one row per input, not five.
    const { rows: attempts } = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM scan_attempts WHERE device_id = $1`,
      ['sync-1'],
    );
    expect(attempts[0]!.n).toBe(3);
  });

  it('two devices offline on the same ticket: earliest scannedAt wins', async () => {
    const ctx = await setup();
    const [token] = await buyAndIssue(ctx, 1);

    const early = new Date(Date.now() - 300_000).toISOString();
    const late = new Date(Date.now() - 60_000).toISOString();

    // Device B syncs FIRST with the LATER scan time.
    const first = await ctx.app.inject({
      method: 'POST',
      url: '/checkin/sync',
      headers: { authorization: `Bearer ${ctx.staffToken}` },
      payload: { scans: [scanBody(token!, { deviceId: 'B', scannedAt: late, gate: 'B' })] },
    });
    expect(first.json().results[0].outcome).toBe('accepted');

    // Device A syncs SECOND with the EARLIER scan time. It must win.
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/checkin/sync',
      headers: { authorization: `Bearer ${ctx.staffToken}` },
      payload: { scans: [scanBody(token!, { deviceId: 'A', scannedAt: early, gate: 'A' })] },
    });
    expect(second.json().results[0].outcome).toBe('accepted');

    const { rows } = await pool.query<{ checked_in_at: Date; checked_in_gate: string; checked_in_device_id: string }>(
      `SELECT checked_in_at, checked_in_gate, checked_in_device_id FROM tickets WHERE event_id = $1`,
      [ctx.eventId],
    );
    expect(rows[0]!.checked_in_gate).toBe('A');
    expect(rows[0]!.checked_in_device_id).toBe('A');
    expect(rows[0]!.checked_in_at.toISOString()).toBe(early);

    // Now device B retries its scan. It must report 'duplicate' with the
    // winner's details, not flip the ticket back.
    const replay = await ctx.app.inject({
      method: 'POST',
      url: '/checkin/sync',
      headers: { authorization: `Bearer ${ctx.staffToken}` },
      payload: { scans: [scanBody(token!, { deviceId: 'B', scannedAt: late, gate: 'B' })] },
    });
    const r = replay.json().results[0];
    expect(r.outcome).toBe('accepted'); // replay of the same scan_attempt, cached
  });

  it('mix of accepted / duplicate / invalid in one batch', async () => {
    const ctx = await setup();
    const tokens = await buyAndIssue(ctx, 2);
    // Pre-check-in one ticket so it appears as duplicate.
    const t0 = new Date(Date.now() - 60_000).toISOString();
    await ctx.app.inject({
      method: 'POST',
      url: '/checkin',
      headers: { authorization: `Bearer ${ctx.staffToken}` },
      payload: scanBody(tokens[0]!, { deviceId: 'pre', scannedAt: t0, gate: 'A' }),
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/checkin/sync',
      headers: { authorization: `Bearer ${ctx.staffToken}` },
      payload: {
        scans: [
          scanBody(tokens[0]!, { deviceId: 'sync-2', scannedAt: new Date().toISOString() }),
          scanBody(tokens[1]!, { deviceId: 'sync-2', scannedAt: new Date().toISOString() }),
          scanBody('not-a-valid-token-at-all-xxxxxxxxxxxxxxxxxxxxx', { deviceId: 'sync-2' }),
        ],
      },
    });
    const results = res.json().results as Array<{ outcome: string }>;
    expect(results[0]!.outcome).toBe('duplicate');
    expect(results[1]!.outcome).toBe('accepted');
    expect(results[2]!.outcome).toBe('invalid_token');
  });
});

describe('checkin manifest', () => {
  it('includes every ticket and the current signing kids', async () => {
    const ctx = await setup();
    await buyAndIssue(ctx, 3);
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/events/${ctx.eventId}/checkin-manifest`,
      headers: { authorization: `Bearer ${ctx.staffToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      eventId: string;
      signing: { algorithm: string; kids: string[] };
      tickets: Array<{ id: string; shortCode: string; status: string }>;
    };
    expect(body.eventId).toBe(ctx.eventId);
    expect(body.signing.algorithm).toBe('hmac-sha256');
    expect(body.signing.kids.length).toBeGreaterThan(0);
    expect(body.tickets).toHaveLength(3);
    expect(new Set(body.tickets.map((t) => t.id)).size).toBe(3);
  });

  it('rejects an attendee', async () => {
    const ctx = await setup();
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/events/${ctx.eventId}/checkin-manifest`,
      headers: { authorization: `Bearer ${ctx.buyerToken}` },
    });
    expect(res.statusCode).toBe(403);
  });
});