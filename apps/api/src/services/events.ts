// Event catalog. Ownership is enforced here, not in the route layer, so any
// future caller (e.g. an admin console) gets the same rules.
//
// All state transitions use single-statement conditional UPDATEs with the
// status embedded in the WHERE clause. That makes them atomic under READ
// COMMITTED: two concurrent publish requests cannot both succeed because the
// second sees status='published' and updates 0 rows.
import type { PoolClient } from 'pg';
import type { CreateEventInput, EventStatus, UpdateEventInput } from '@ticketing/shared';
import { pool } from '../db/pool.js';
import { withTransaction } from '../db/tx.js';
import { forbidden, notFound, unprocessable } from '../errors.js';

export interface EventListItem {
  id: string;
  name: string;
  description: string;
  venue: string;
  startsAt: Date;
  endsAt: Date;
  status: EventStatus;
  organizerUserId: string;
}

export interface TierWithAvailability {
  id: string;
  name: string;
  priceMinor: number;
  currency: string;
  capacity: number;
  perOrderMax: number;
  sold: number;
  reserved: number;
  /** capacity - sold - reserved, computed in SQL — never in JS. */
  available: number;
  salesStart: Date;
  salesEnd: Date;
}

export interface EventDetail extends EventListItem {
  tiers: TierWithAvailability[];
}

interface DbEventRow {
  id: string;
  name: string;
  description: string;
  venue: string;
  starts_at: Date;
  ends_at: Date;
  status: EventStatus;
  organizer_user_id: string;
}

function mapEvent(row: DbEventRow): EventListItem {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    venue: row.venue,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    organizerUserId: row.organizer_user_id,
  };
}

export async function createEvent(
  organizerUserId: string,
  input: CreateEventInput,
): Promise<EventListItem> {
  const { rows } = await pool.query<DbEventRow>(
    `INSERT INTO events (organizer_user_id, name, description, venue, starts_at, ends_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'draft')
     RETURNING id, name, description, venue, starts_at, ends_at, status, organizer_user_id`,
    [
      organizerUserId,
      input.name,
      input.description,
      input.venue,
      input.startsAt,
      input.endsAt,
    ],
  );
  return mapEvent(rows[0]!);
}

export async function updateEvent(
  actorId: string,
  eventId: string,
  patch: UpdateEventInput,
): Promise<EventListItem> {
  return withTransaction(
    async (client) => {
      // Lock the row so a concurrent publish/cancel cannot slip between our
      // status check and our update. FOR UPDATE blocks writers but not
      // readers, so this does not affect public GETs.
      const { rows: existing } = await client.query<{
        organizer_user_id: string;
        status: EventStatus;
      }>(
        `SELECT organizer_user_id, status FROM events WHERE id = $1 FOR UPDATE`,
        [eventId],
      );
      const row = existing[0];
      if (!row) throw notFound('Event not found');
      if (row.organizer_user_id !== actorId) throw forbidden('You do not own this event');
      if (row.status === 'cancelled') {
        throw unprocessable('Cancelled events cannot be edited');
      }

      // Whitelisted dynamic SET list. Never trust the client for status or
      // organizer_user_id; those are not part of UpdateEventInput.
      const sets: string[] = [];
      const values: unknown[] = [];
      let i = 1;
      if (patch.name !== undefined) { sets.push(`name = $${i++}`); values.push(patch.name); }
      if (patch.description !== undefined) { sets.push(`description = $${i++}`); values.push(patch.description); }
      if (patch.venue !== undefined) { sets.push(`venue = $${i++}`); values.push(patch.venue); }
      if (patch.startsAt !== undefined) { sets.push(`starts_at = $${i++}`); values.push(patch.startsAt); }
      if (patch.endsAt !== undefined) { sets.push(`ends_at = $${i++}`); values.push(patch.endsAt); }

      if (sets.length === 0) {
        // Schema already rejects empty updates; this is defense in depth.
        const { rows } = await client.query<DbEventRow>(
          `SELECT id, name, description, venue, starts_at, ends_at, status, organizer_user_id
           FROM events WHERE id = $1`,
          [eventId],
        );
        return mapEvent(rows[0]!);
      }

      values.push(eventId);
      const { rows } = await client.query<DbEventRow>(
        `UPDATE events SET ${sets.join(', ')} WHERE id = $${i}
         RETURNING id, name, description, venue, starts_at, ends_at, status, organizer_user_id`,
        values,
      );
      return mapEvent(rows[0]!);
    },
    { label: 'updateEvent' },
  );
}

export async function publishEvent(actorId: string, eventId: string): Promise<EventListItem> {
  // Single-statement transition. Ownership + current status are in the WHERE
  // clause so there is no read-then-write window. Zero rows returned means we
  // lost to a race or the caller does not own the event; the extra lookup
  // below produces a specific error message for the common cases.
  const { rows } = await pool.query<DbEventRow>(
    `UPDATE events
       SET status = 'published'
     WHERE id = $1 AND organizer_user_id = $2 AND status = 'draft'
     RETURNING id, name, description, venue, starts_at, ends_at, status, organizer_user_id`,
    [eventId, actorId],
  );
  if (rows[0]) return mapEvent(rows[0]);
  await explainEventTransitionFailure(pool, eventId, actorId, 'publish');
  throw new Error('unreachable');
}

export async function cancelEvent(actorId: string, eventId: string): Promise<EventListItem> {
  const { rows } = await pool.query<DbEventRow>(
    `UPDATE events
       SET status = 'cancelled'
     WHERE id = $1 AND organizer_user_id = $2 AND status IN ('draft','published')
     RETURNING id, name, description, venue, starts_at, ends_at, status, organizer_user_id`,
    [eventId, actorId],
  );
  if (rows[0]) return mapEvent(rows[0]);
  await explainEventTransitionFailure(pool, eventId, actorId, 'cancel');
  throw new Error('unreachable');
}

async function explainEventTransitionFailure(
  client: Pick<PoolClient, 'query'> & { query: PoolClient['query'] },
  eventId: string,
  actorId: string,
  action: 'publish' | 'cancel',
): Promise<never> {
  const { rows } = await client.query<{ organizer_user_id: string; status: EventStatus }>(
    `SELECT organizer_user_id, status FROM events WHERE id = $1`,
    [eventId],
  );
  const row = rows[0];
  if (!row) throw notFound('Event not found');
  if (row.organizer_user_id !== actorId) throw forbidden('You do not own this event');
  if (action === 'publish' && row.status === 'published') {
    throw unprocessable('Event is already published');
  }
  if (row.status === 'cancelled') throw unprocessable('Event is cancelled');
  throw unprocessable(`Event cannot be ${action}ed from status "${row.status}"`);
}

// ---------------------------------------------------------------------------
// Public reads
// ---------------------------------------------------------------------------

export async function listPublicEvents(): Promise<EventDetail[]> {
  // One query with a JSON aggregate; availability per tier is computed by
  // Postgres, never by JS, so a bug in application code cannot desync the
  // number a buyer sees from the number the reservation path will enforce.
  const { rows } = await pool.query<{
    id: string;
    name: string;
    description: string;
    venue: string;
    starts_at: Date;
    ends_at: Date;
    status: EventStatus;
    organizer_user_id: string;
    tiers: TierWithAvailability[];
  }>(
    `SELECT
       e.id, e.name, e.description, e.venue, e.starts_at, e.ends_at, e.status,
       e.organizer_user_id,
       COALESCE(
         json_agg(
           json_build_object(
             'id', tt.id,
             'name', tt.name,
             'priceMinor', tt.price_minor,
             'currency', tt.currency,
             'capacity', tt.capacity,
             'perOrderMax', tt.per_order_max,
             'sold', tt.sold,
             'reserved', tt.reserved,
             'available', tt.capacity - tt.sold - tt.reserved,
             'salesStart', tt.sales_start,
             'salesEnd', tt.sales_end
           ) ORDER BY tt.sales_start, tt.name
         ) FILTER (WHERE tt.id IS NOT NULL),
         '[]'::json
       ) AS tiers
     FROM events e
     LEFT JOIN ticket_tiers tt ON tt.event_id = e.id
     WHERE e.status = 'published'
     GROUP BY e.id
     ORDER BY e.starts_at ASC`,
  );

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    venue: r.venue,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    status: r.status,
    organizerUserId: r.organizer_user_id,
    tiers: r.tiers,
  }));
}

export async function getPublicEvent(eventId: string): Promise<EventDetail> {
  const { rows } = await pool.query<{
    id: string;
    name: string;
    description: string;
    venue: string;
    starts_at: Date;
    ends_at: Date;
    status: EventStatus;
    organizer_user_id: string;
    tiers: TierWithAvailability[];
  }>(
    `SELECT
       e.id, e.name, e.description, e.venue, e.starts_at, e.ends_at, e.status,
       e.organizer_user_id,
       COALESCE(
         json_agg(
           json_build_object(
             'id', tt.id,
             'name', tt.name,
             'priceMinor', tt.price_minor,
             'currency', tt.currency,
             'capacity', tt.capacity,
             'perOrderMax', tt.per_order_max,
             'sold', tt.sold,
             'reserved', tt.reserved,
             'available', tt.capacity - tt.sold - tt.reserved,
             'salesStart', tt.sales_start,
             'salesEnd', tt.sales_end
           ) ORDER BY tt.sales_start, tt.name
         ) FILTER (WHERE tt.id IS NOT NULL),
         '[]'::json
       ) AS tiers
     FROM events e
     LEFT JOIN ticket_tiers tt ON tt.event_id = e.id
     WHERE e.id = $1 AND e.status = 'published'
     GROUP BY e.id`,
    [eventId],
  );
  const r = rows[0];
  if (!r) throw notFound('Event not found');
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    venue: r.venue,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    status: r.status,
    organizerUserId: r.organizer_user_id,
    tiers: r.tiers,
  };
}

export async function listOrganizerEvents(organizerUserId: string): Promise<EventDetail[]> {
  const { rows } = await pool.query<{
    id: string;
    name: string;
    description: string;
    venue: string;
    starts_at: Date;
    ends_at: Date;
    status: EventStatus;
    organizer_user_id: string;
    tiers: TierWithAvailability[];
  }>(
    `SELECT
       e.id, e.name, e.description, e.venue, e.starts_at, e.ends_at, e.status,
       e.organizer_user_id,
       COALESCE(
         json_agg(
           json_build_object(
             'id', tt.id,
             'name', tt.name,
             'priceMinor', tt.price_minor,
             'currency', tt.currency,
             'capacity', tt.capacity,
             'perOrderMax', tt.per_order_max,
             'sold', tt.sold,
             'reserved', tt.reserved,
             'available', tt.capacity - tt.sold - tt.reserved,
             'salesStart', tt.sales_start,
             'salesEnd', tt.sales_end
           ) ORDER BY tt.sales_start, tt.name
         ) FILTER (WHERE tt.id IS NOT NULL),
         '[]'::json
       ) AS tiers
     FROM events e
     LEFT JOIN ticket_tiers tt ON tt.event_id = e.id
     WHERE e.organizer_user_id = $1
     GROUP BY e.id
     ORDER BY e.starts_at DESC`,
    [organizerUserId],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    venue: r.venue,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    status: r.status,
    organizerUserId: r.organizer_user_id,
    tiers: r.tiers,
  }));
}