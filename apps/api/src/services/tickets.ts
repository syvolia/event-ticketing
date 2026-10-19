// Ticket issuance and reads.
//
// issueTicketsForOrder() is the critical function. Its correctness does NOT
// depend on being called exactly once — it depends on the DB's
// UNIQUE (order_item_id, serial_no). Every insert carries an
// `ON CONFLICT (order_item_id, serial_no) DO NOTHING`, so:
//
//   - Replaying the order.paid outbox event 100 times inserts 0 extra rows
//     after the first successful pass.
//   - A partial run (process died mid-loop) that is retried completes the
//     missing rows without touching the ones already written.
//   - The QR payload for an existing row is never rewritten, so a ticket the
//     buyer already has keeps working even if the retry signs with a rotated
//     key.
//
// Short-code collision handling: short_code has its own UNIQUE. A collision
// is astronomically unlikely (31^8 ≈ 8.5e11), but we retry up to 5 times to
// avoid ever surfacing a 500 for what is fundamentally a random draw.

import { randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { TicketView } from '@ticketing/shared';
import { pool } from '../db/pool.js';
import { withTransaction } from '../db/tx.js';
import { forbidden, notFound, unprocessable } from '../errors.js';
import { signTicketPayload } from '../qr/signing.js';
import type { SigningKey } from '../qr/keys.js';

// No 0/O/1/I/L — anything that can be misread over a phone call.
const SHORT_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function generateShortCode(): string {
  const bytes = randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) {
    s += SHORT_CODE_ALPHABET[bytes[i]! % SHORT_CODE_ALPHABET.length];
  }
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

// ---------------------------------------------------------------------------
// Issuance
// ---------------------------------------------------------------------------

export interface IssueResult {
  /** Number of rows inserted by this call. Zero on a full replay. */
  inserted: number;
  /** Every ticket belonging to the order, whether this call created it or not. */
  ticketIds: string[];
}

export async function issueTicketsForOrder(
  client: PoolClient,
  orderId: string,
  activeKey: SigningKey,
): Promise<IssueResult> {
  // Lock the order row first. This serializes concurrent issuance attempts for
  // the same order — an outbox worker and, say, a manual admin trigger cannot
  // interleave their loops.
  const { rows: orderRows } = await client.query<{
    id: string;
    event_id: string;
    status: string;
  }>(
    `SELECT id, event_id, status FROM orders WHERE id = $1 FOR UPDATE`,
    [orderId],
  );
  const order = orderRows[0];
  if (!order) throw notFound('Order not found');

  const { rows: items } = await client.query<{
    order_item_id: string;
    tier_id: string;
    quantity: number;
  }>(
    `SELECT id AS order_item_id, tier_id, quantity
       FROM order_items
      WHERE order_id = $1
      ORDER BY tier_id, id`,
    [orderId],
  );

  let inserted = 0;
  const ticketIds: string[] = [];

  for (const item of items) {
    for (let seq = 1; seq <= item.quantity; seq++) {
      // Generate the id client-side so we can sign the payload before the
      // insert. If the row already exists, our freshly signed payload is
      // discarded by ON CONFLICT DO NOTHING — the existing payload wins,
      // which is exactly what we want.
      const ticketId = randomUUID();
      const qrPayload = signTicketPayload(
        { t: ticketId, e: order.event_id, v: 1 },
        activeKey.kid,
        activeKey.secret,
      );

      let attempt = 0;
      // Retry loop for short_code collision only. The ON CONFLICT target is
      // (order_item_id, serial_no); a conflict on tickets_short_code_key is a
      // *different* unique violation that the ON CONFLICT clause does not
      // absorb, so we catch it and try a new code.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        attempt++;
        const shortCode = generateShortCode();
        try {
          const res = await client.query(
            `INSERT INTO tickets
               (id, order_id, order_item_id, tier_id, event_id, serial_no,
                short_code, qr_payload, kid, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'valid')
             ON CONFLICT (order_item_id, serial_no) DO NOTHING`,
            [
              ticketId,
              orderId,
              item.order_item_id,
              item.tier_id,
              order.event_id,
              seq,
              shortCode,
              qrPayload,
              activeKey.kid,
            ],
          );
          if (res.rowCount === 1) {
            inserted++;
            ticketIds.push(ticketId);
          } else {
            // Row already existed. Fetch its id so the caller sees all tickets
            // for the order regardless of who created which.
            const { rows: existing } = await client.query<{ id: string }>(
              `SELECT id FROM tickets WHERE order_item_id = $1 AND serial_no = $2`,
              [item.order_item_id, seq],
            );
            if (existing[0]) ticketIds.push(existing[0].id);
          }
          break;
        } catch (err) {
          const e = err as { code?: string; constraint?: string };
          if (e.code === '23505' && e.constraint === 'tickets_short_code_key' && attempt < 5) {
            continue;
          }
          throw err;
        }
      }
    }
  }

  return { inserted, ticketIds };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

interface TicketJoinRow {
  id: string;
  event_id: string;
  order_id: string;
  tier_id: string;
  tier_name: string;
  event_name: string;
  event_starts_at: Date;
  short_code: string;
  status: 'valid' | 'checked_in' | 'void';
  qr_payload: string;
  checked_in_at: Date | null;
  voided_at: Date | null;
  created_at: Date;
  buyer_user_id: string;
  organizer_user_id: string;
}

function mapTicket(row: TicketJoinRow): TicketView {
  return {
    id: row.id,
    eventId: row.event_id,
    orderId: row.order_id,
    tierId: row.tier_id,
    tierName: row.tier_name,
    eventName: row.event_name,
    eventStartsAt: row.event_starts_at.toISOString(),
    shortCode: row.short_code,
    status: row.status,
    qrPayload: row.qr_payload,
    checkedInAt: row.checked_in_at ? row.checked_in_at.toISOString() : null,
    voidedAt: row.voided_at ? row.voided_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

const TICKET_SELECT = `
  SELECT t.id, t.event_id, t.order_id, t.tier_id,
         tt.name AS tier_name,
         e.name AS event_name, e.starts_at AS event_starts_at,
         t.short_code, t.status, t.qr_payload,
         t.checked_in_at, t.voided_at, t.created_at,
         o.buyer_user_id, e.organizer_user_id
    FROM tickets t
    JOIN orders o ON o.id = t.order_id
    JOIN ticket_tiers tt ON tt.id = t.tier_id
    JOIN events e ON e.id = t.event_id
`;

export async function listTicketsForBuyer(buyerUserId: string): Promise<TicketView[]> {
  const { rows } = await pool.query<TicketJoinRow>(
    `${TICKET_SELECT} WHERE o.buyer_user_id = $1 ORDER BY e.starts_at DESC, t.created_at DESC`,
    [buyerUserId],
  );
  return rows.map(mapTicket);
}

/**
 * Authorized read: buyer sees their own tickets; organizer sees tickets for
 * their events. Staff authorization arrives in Step 7.
 */
export async function getTicketForUser(
  ticketId: string,
  userId: string,
  role: 'organizer' | 'attendee' | 'staff',
): Promise<TicketView> {
  const { rows } = await pool.query<TicketJoinRow>(`${TICKET_SELECT} WHERE t.id = $1`, [ticketId]);
  const row = rows[0];
  if (!row) throw notFound('Ticket not found');
  const isBuyer = row.buyer_user_id === userId;
  const isOrganizer = row.organizer_user_id === userId;
  if (role === 'organizer' && isOrganizer) return mapTicket(row);
  if (isBuyer) return mapTicket(row);
  // Return 404 rather than 403 so existence is not leaked across accounts.
  throw notFound('Ticket not found');
}

// ---------------------------------------------------------------------------
// Void
// ---------------------------------------------------------------------------

export async function voidTicket(
  ticketId: string,
  actorUserId: string,
  reason: string,
): Promise<TicketView> {
  return withTransaction(
    async (client) => {
      // Lock the ticket and validate organizer ownership in one query. Join
      // through events so a race between void and a check-in is serialized on
      // the ticket row alone.
      const { rows } = await client.query<{
        id: string;
        status: 'valid' | 'checked_in' | 'void';
        organizer_user_id: string;
      }>(
        `SELECT t.id, t.status, e.organizer_user_id
           FROM tickets t
           JOIN events e ON e.id = t.event_id
          WHERE t.id = $1
          FOR UPDATE OF t`,
        [ticketId],
      );
      const row = rows[0];
      if (!row) throw notFound('Ticket not found');
      if (row.organizer_user_id !== actorUserId) {
        throw forbidden('You do not own this event');
      }

      if (row.status !== 'void') {
        // The state machine allows valid -> void and checked_in -> void.
        // A second void of an already-void ticket is treated as idempotent.
        await client.query(
          `UPDATE tickets
              SET status = 'void',
                  voided_at = now(),
                  voided_by = $2,
                  voided_reason = $3
            WHERE id = $1`,
          [ticketId, actorUserId, reason],
        );
      }

      const { rows: full } = await client.query<TicketJoinRow>(
        `${TICKET_SELECT} WHERE t.id = $1`,
        [ticketId],
      );
      return mapTicket(full[0]!);
    },
    { label: 'voidTicket' },
  );
}

// Re-exported for the outbox worker so it can decide whether to retry.
export function assertIssuableOrderStatus(status: string): void {
  if (status !== 'paid' && status !== 'fulfilled') {
    throw unprocessable(`Order status ${status} is not eligible for issuance`);
  }
}