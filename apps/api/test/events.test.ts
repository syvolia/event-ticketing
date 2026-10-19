import { describe, expect, it, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, makeOrganizer } from './helpers/app.js';
import { pool } from '../src/db/pool.js';

interface Created {
  event: { id: string; status: string; name: string; organizerUserId: string };
}
interface TierResp {
  tier: {
    id: string;
    capacity: number;
    sold: number;
    reserved: number;
    available: number;
    priceMinor: number;
  };
}

async function createEvent(
  app: FastifyInstance,
  token: string,
  name = 'Test Event',
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/events',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      name,
      description: 'desc',
      venue: 'The Venue',
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      endsAt: new Date(Date.now() + 86_400_000 + 4 * 3600_000).toISOString(),
    },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as Created).event.id;
}

async function createTier(
  app: FastifyInstance,
  token: string,
  eventId: string,
  overrides: Partial<{ name: string; priceMinor: number; capacity: number; perOrderMax: number }> = {},
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/events/${eventId}/tiers`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      name: overrides.name ?? 'GA',
      priceMinor: overrides.priceMinor ?? 100_000,
      currency: 'KES',
      capacity: overrides.capacity ?? 10,
      perOrderMax: overrides.perOrderMax ?? 4,
      salesStart: new Date(Date.now() - 3600_000).toISOString(),
      salesEnd: new Date(Date.now() + 86_400_000).toISOString(),
    },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as TierResp).tier.id;
}

describe('events & tiers', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await makeApp();
  });

  it('organizer can create, publish, and see their own event', async () => {
    const org = await makeOrganizer(app, 'e1@example.com');
    const eventId = await createEvent(app, org.token);

    const publish = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/publish`,
      headers: { authorization: `Bearer ${org.token}` },
    });
    expect(publish.statusCode).toBe(200);
    expect(publish.json().event.status).toBe('published');

    const mine = await app.inject({
      method: 'GET',
      url: '/organizer/events',
      headers: { authorization: `Bearer ${org.token}` },
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().events).toHaveLength(1);
  });

  it('public list shows only published events and computes availability in SQL', async () => {
    const org = await makeOrganizer(app, 'pub@example.com');
    const draftId = await createEvent(app, org.token, 'Draft');
    const pubId = await createEvent(app, org.token, 'Published');
    await createTier(app, org.token, pubId, { capacity: 10 });

    await app.inject({
      method: 'POST',
      url: `/events/${pubId}/publish`,
      headers: { authorization: `Bearer ${org.token}` },
    });

    // Simulate 3 sold + 2 reserved, written directly — no order flow yet.
    await pool.query(
      `UPDATE ticket_tiers SET sold = 3, reserved = 2 WHERE event_id = $1`,
      [pubId],
    );

    const list = await app.inject({ method: 'GET', url: '/events' });
    expect(list.statusCode).toBe(200);
    const events = list.json().events as Array<{ id: string; tiers: Array<{ available: number }> }>;
    const ids = events.map((e) => e.id);
    expect(ids).toContain(pubId);
    expect(ids).not.toContain(draftId);
    const pub = events.find((e) => e.id === pubId)!;
    expect(pub.tiers[0]!.available).toBe(5); // 10 - 3 - 2
  });

  it('rejects modification by a non-owner', async () => {
    const owner = await makeOrganizer(app, 'owner@example.com');
    const other = await makeOrganizer(app, 'other@example.com');
    const eventId = await createEvent(app, owner.token);

    const res = await app.inject({
      method: 'PATCH',
      url: `/events/${eventId}`,
      headers: { authorization: `Bearer ${other.token}` },
      payload: { name: 'Hijacked' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('cannot reduce tier capacity below sold + reserved', async () => {
    const org = await makeOrganizer(app, 'cap@example.com');
    const eventId = await createEvent(app, org.token);
    const tierId = await createTier(app, org.token, eventId, { capacity: 10 });

    // Simulate committed inventory.
    await pool.query(
      `UPDATE ticket_tiers SET sold = 4, reserved = 3 WHERE id = $1`,
      [tierId],
    );

    // 6 < 7 → must reject.
    const res = await app.inject({
      method: 'PATCH',
      url: `/tiers/${tierId}`,
      headers: { authorization: `Bearer ${org.token}` },
      payload: { capacity: 6 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('UNPROCESSABLE');
    expect(res.json().error.details).toMatchObject({ sold: 4, reserved: 3 });

    // 7 is fine (sold + reserved == capacity).
    const ok = await app.inject({
      method: 'PATCH',
      url: `/tiers/${tierId}`,
      headers: { authorization: `Bearer ${org.token}` },
      payload: { capacity: 7 },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().tier.capacity).toBe(7);
  });

  it('cannot change price once a ticket has been sold', async () => {
    const org = await makeOrganizer(app, 'price@example.com');
    const eventId = await createEvent(app, org.token);
    const tierId = await createTier(app, org.token, eventId, { priceMinor: 100_000 });

    // No sales → price change allowed.
    const beforeSales = await app.inject({
      method: 'PATCH',
      url: `/tiers/${tierId}`,
      headers: { authorization: `Bearer ${org.token}` },
      payload: { priceMinor: 120_000 },
    });
    expect(beforeSales.statusCode).toBe(200);
    expect(beforeSales.json().tier.priceMinor).toBe(120_000);

    // Simulate one sale.
    await pool.query(`UPDATE ticket_tiers SET sold = 1 WHERE id = $1`, [tierId]);

    const afterSales = await app.inject({
      method: 'PATCH',
      url: `/tiers/${tierId}`,
      headers: { authorization: `Bearer ${org.token}` },
      payload: { priceMinor: 130_000 },
    });
    expect(afterSales.statusCode).toBe(422);
    expect(afterSales.json().error.message).toMatch(/Price cannot be changed/);
  });

  it('allows per-order cap adjustments as long as they fit under capacity', async () => {
    const org = await makeOrganizer(app, 'per@example.com');
    const eventId = await createEvent(app, org.token);
    const tierId = await createTier(app, org.token, eventId, { capacity: 10, perOrderMax: 4 });

    const bad = await app.inject({
      method: 'PATCH',
      url: `/tiers/${tierId}`,
      headers: { authorization: `Bearer ${org.token}` },
      payload: { perOrderMax: 20 },
    });
    expect(bad.statusCode).toBe(422);

    const ok = await app.inject({
      method: 'PATCH',
      url: `/tiers/${tierId}`,
      headers: { authorization: `Bearer ${org.token}` },
      payload: { perOrderMax: 8 },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().tier.perOrderMax).toBe(8);
  });

  it('non-organizer role cannot create events', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'attendee@example.com',
        password: 'correct horse battery staple',
        displayName: 'A',
        role: 'attendee',
      },
    });
    const token = res.json().accessToken as string;
    const created = await app.inject({
      method: 'POST',
      url: '/events',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: 'Nope',
        description: '',
        venue: 'X',
        startsAt: new Date(Date.now() + 3600_000).toISOString(),
        endsAt: new Date(Date.now() + 7200_000).toISOString(),
      },
    });
    expect(created.statusCode).toBe(403);
  });

  it('cancel transitions a published event to cancelled', async () => {
    const org = await makeOrganizer(app, 'cancel@example.com');
    const eventId = await createEvent(app, org.token);
    await app.inject({
      method: 'POST',
      url: `/events/${eventId}/publish`,
      headers: { authorization: `Bearer ${org.token}` },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/cancel`,
      headers: { authorization: `Bearer ${org.token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().event.status).toBe('cancelled');

    // Idempotent-ish: a second cancel returns 422 rather than crashing.
    const again = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/cancel`,
      headers: { authorization: `Bearer ${org.token}` },
    });
    expect(again.statusCode).toBe(422);
    expect(again.json().error.message).toMatch(/cancelled/);
  });
});