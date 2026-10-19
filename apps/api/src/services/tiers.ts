// Tier mutations. The two business rules that matter here are:
//   (1) capacity cannot be reduced below sold + reserved;
//   (2) price/currency cannot change once sold > 0.
//
// Both are enforced inside a transaction that first locks the event row
// (ownership + cancel guard) and then the tier row (inventory). Lock order is
// event → tier everywhere in this file so concurrent requests cannot deadlock.
import type { PoolClient } from 'pg';
import type { CreateTierInput, EventStatus, UpdateTierInput } from '@ticketing/shared';
import { withTransaction } from '../db/tx.js';
import { conflict, forbidden, notFound, unprocessable } from '../errors.js';
import type { TierWithAvailability } from './events.js';

interface DbTierRow {
  id: string;
  name: string;
  price_minor: number;
  currency: string;
  capacity: number;
  per_order_max: number;
  sold: number;
  reserved: number;
  sales_start: Date;
  sales_end: Date;
}

interface TierWithEvent extends DbTierRow {
  event_status: EventStatus;
  organizer_user_id: string;
}

function mapTier(row: DbTierRow): TierWithAvailability {
  return {
    id: row.id,
    name: row.name,
    priceMinor: row.price_minor,
    currency: row.currency,
    capacity: row.capacity,
    perOrderMax: row.per_order_max,
    sold: row.sold,
    reserved: row.reserved,
    // Availability is computed here, not stored. The canonical computation
    // in the DB is `capacity - sold - reserved`; exposing it from one place
    // (SQL, in the public reads) means the JSON contract is consistent.
    available: row.capacity - row.sold - row.reserved,
    salesStart: row.sales_start,
    salesEnd: row.sales_end,
  };
}

async function lockEventForTierWrite(
  client: PoolClient,
  actorId: string,
  eventId: string,
): Promise<{ status: EventStatus }> {
  const { rows } = await client.query<{ status: EventStatus; organizer_user_id: string }>(
    `SELECT status, organizer_user_id FROM events WHERE id = $1 FOR UPDATE`,
    [eventId],
  );
  const ev = rows[0];
  if (!ev) throw notFound('Event not found');
  if (ev.organizer_user_id !== actorId) throw forbidden('You do not own this event');
  if (ev.status === 'cancelled') throw unprocessable('Cancelled events cannot be edited');
  return { status: ev.status };
}

export async function createTier(
  actorId: string,
  eventId: string,
  input: CreateTierInput,
): Promise<TierWithAvailability> {
  return withTransaction(
    async (client) => {
      await lockEventForTierWrite(client, actorId, eventId);
      try {
        const { rows } = await client.query<DbTierRow>(
          `INSERT INTO ticket_tiers
             (event_id, name, price_minor, currency, capacity, per_order_max, sales_start, sales_end)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id, name, price_minor, currency, capacity, per_order_max,
                     sold, reserved, sales_start, sales_end`,
          [
            eventId,
            input.name,
            input.priceMinor,
            input.currency,
            input.capacity,
            input.perOrderMax,
            input.salesStart,
            input.salesEnd,
          ],
        );
        return mapTier(rows[0]!);
      } catch (err) {
        const e = err as { code?: string; constraint?: string };
        if (e.code === '23505' && e.constraint === 'ticket_tiers_event_id_name_key') {
          throw conflict(`A tier named "${input.name}" already exists on this event`);
        }
        throw err;
      }
    },
    { label: 'createTier' },
  );
}

export async function updateTier(
  actorId: string,
  tierId: string,
  patch: UpdateTierInput,
): Promise<TierWithAvailability> {
  return withTransaction(
    async (client) => {
      // Lock order: event first (ownership + cancel guard), then the tier
      // row (inventory state). This matches createTier's order and any other
      // mutator, so two concurrent requests cannot form a lock cycle.
      const { rows: evs } = await client.query<{ id: string; status: EventStatus; organizer_user_id: string }>(
        `SELECT e.id, e.status, e.organizer_user_id
           FROM events e
           JOIN ticket_tiers tt ON tt.event_id = e.id
          WHERE tt.id = $1
          FOR UPDATE OF e`,
        [tierId],
      );
      const ev = evs[0];
      if (!ev) throw notFound('Tier not found');
      if (ev.organizer_user_id !== actorId) throw forbidden('You do not own this event');
      if (ev.status === 'cancelled') throw unprocessable('Cancelled events cannot be edited');

      const { rows: tierRows } = await client.query<TierWithEvent>(
        `SELECT tt.id, tt.name, tt.price_minor, tt.currency, tt.capacity,
                tt.per_order_max, tt.sold, tt.reserved,
                tt.sales_start, tt.sales_end,
                e.status AS event_status, e.organizer_user_id
           FROM ticket_tiers tt
           JOIN events e ON e.id = tt.event_id
          WHERE tt.id = $1
          FOR UPDATE OF tt`,
        [tierId],
      );
      const tier = tierRows[0]!;

      // Rule 1: capacity cannot dip below committed inventory.
      const committed = tier.sold + tier.reserved;
      if (patch.capacity !== undefined && patch.capacity < committed) {
        throw unprocessable(
          `Capacity cannot be less than sold + reserved (${committed})`,
          { sold: tier.sold, reserved: tier.reserved },
        );
      }
      const newCapacity = patch.capacity ?? tier.capacity;
      const newPerOrderMax = patch.perOrderMax ?? tier.per_order_max;
      if (newPerOrderMax > newCapacity) {
        throw unprocessable('perOrderMax cannot exceed capacity');
      }

      // Rule 2: no price/currency change once any ticket has been sold.
      // Reserved-only rows are safe to change because order_items snapshots
      // the price at reservation time, so an in-flight reservation still pays
      // the old amount and the new price applies only to future orders.
      if (patch.priceMinor !== undefined && patch.priceMinor !== tier.price_minor && tier.sold > 0) {
        throw unprocessable(
          'Price cannot be changed after tickets have been sold. Create a new tier instead.',
          { sold: tier.sold },
        );
      }
      if (patch.currency !== undefined && patch.currency !== tier.currency && tier.sold > 0) {
        throw unprocessable(
          'Currency cannot be changed after tickets have been sold.',
          { sold: tier.sold },
        );
      }

      const sets: string[] = [];
      const values: unknown[] = [];
      let i = 1;
      if (patch.name !== undefined) { sets.push(`name = $${i++}`); values.push(patch.name); }
      if (patch.priceMinor !== undefined) { sets.push(`price_minor = $${i++}`); values.push(patch.priceMinor); }
      if (patch.currency !== undefined) { sets.push(`currency = $${i++}`); values.push(patch.currency); }
      if (patch.capacity !== undefined) { sets.push(`capacity = $${i++}`); values.push(patch.capacity); }
      if (patch.perOrderMax !== undefined) { sets.push(`per_order_max = $${i++}`); values.push(patch.perOrderMax); }
      if (patch.salesStart !== undefined) { sets.push(`sales_start = $${i++}`); values.push(patch.salesStart); }
      if (patch.salesEnd !== undefined) { sets.push(`sales_end = $${i++}`); values.push(patch.salesEnd); }

      if (sets.length === 0) return mapTier(tier);

      values.push(tierId);
      try {
        const { rows } = await client.query<DbTierRow>(
          `UPDATE ticket_tiers SET ${sets.join(', ')}
            WHERE id = $${i}
            RETURNING id, name, price_minor, currency, capacity, per_order_max,
                      sold, reserved, sales_start, sales_end`,
          values,
        );
        return mapTier(rows[0]!);
      } catch (err) {
        // Belt-and-braces: if a concurrent reservation sneaks in between our
        // rule check and the UPDATE (possible if a future code path forgot
        // the FOR UPDATE), the CHECK constraint stops the write. Translate
        // it to the same user-facing error rather than a 500.
        const e = err as { code?: string };
        if (e.code === '23514') {
          throw unprocessable('Capacity cannot be less than sold + reserved');
        }
        throw err;
      }
    },
    { label: 'updateTier' },
  );
}