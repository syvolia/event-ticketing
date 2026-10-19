// Transactional outbox consumer.
//
// Every state change that must trigger side effects writes to outbox_events
// inside the same transaction as the change itself. This worker drains the
// table: claim rows with FOR UPDATE SKIP LOCKED (so N replicas each pick a
// disjoint batch), run the handler, mark published_at in the same tx.
//
// Failure handling: if a handler throws, we record `last_error` and leave
// published_at NULL. The next tick retries. Because every handler is
// idempotent (ticket issuance via UNIQUE, email via the dedupe_key on the
// outbox row), retries are safe.
//
// SKIP LOCKED matters: blue/green deploys overlap two replicas for a few
// seconds; without SKIP LOCKED they would contend on the same rows and one
// would waste time waiting. With it, each picks different rows.
import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import { withTransaction } from '../db/tx.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { issueTicketsForOrder } from '../services/tickets.js';
import { getActiveKey } from '../qr/keys.js';
import { sendTicketEmail, type TicketEmailItem } from '../mail/mailer.js';
import { generateDataUrl } from '../qr/generator.js';

interface OutboxRow {
  id: string;
  dedupe_key: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: unknown;
}

const BATCH_SIZE = 25;

export interface DrainResult {
  processed: number;
  insertedTickets: number;
  emailsSent: number;
}

/**
 * One pass. Idempotent. Safe to call from tests without a timer.
 */
export async function drainOutboxOnce(): Promise<DrainResult> {
  return withTransaction(
    async (client) => {
      // Claim a batch. Rows claimed here are invisible to concurrent workers
      // until this tx commits or rolls back — that is the mechanism that makes
      // SKIP LOCKED safe for concurrent consumers.
      const { rows } = await client.query<OutboxRow>(
        `SELECT id, dedupe_key, aggregate_type, aggregate_id, event_type, payload
           FROM outbox_events
          WHERE published_at IS NULL
          ORDER BY id ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [BATCH_SIZE],
      );

      let processed = 0;
      let insertedTickets = 0;
      let emailsSent = 0;

      for (const ev of rows) {
        try {
          const outcome = await handle(client, ev);
          insertedTickets += outcome.insertedTickets;
          emailsSent += outcome.emailsSent;
          await client.query(
            `UPDATE outbox_events
                SET published_at = now(),
                    attempts = attempts + 1,
                    last_error = NULL
              WHERE id = $1`,
            [ev.id],
          );
          processed += 1;
        } catch (err) {
          // Record the failure, leave published_at NULL so the next tick
          // retries. The transaction still commits so subsequent events in
          // this batch are attempted.
          await client.query(
            `UPDATE outbox_events
                SET attempts = attempts + 1,
                    last_error = $2
              WHERE id = $1`,
            [ev.id, (err as Error).message.slice(0, 500)],
          );
          logger.error(
            { err, eventId: ev.id, eventType: ev.event_type },
            'outbox handler failed; will retry',
          );
        }
      }

      return { processed, insertedTickets, emailsSent };
    },
    { label: 'drainOutboxOnce' },
  );
}

interface HandlerOutcome {
  insertedTickets: number;
  emailsSent: number;
}

async function handle(client: PoolClient, ev: OutboxRow): Promise<HandlerOutcome> {
  switch (ev.event_type) {
    case 'order.paid':
    case 'order.paid.after_expiry':
      return handleOrderPaid(client, ev);
    case 'tickets.issued':
      return handleTicketsIssued(client, ev);
    default:
      // Unknown event types are marked published with a warning rather than
      // blocking the queue. If a future step adds handlers, this default is
      // where they would be routed.
      logger.warn({ eventType: ev.event_type, id: ev.id }, 'unknown outbox event');
      return { insertedTickets: 0, emailsSent: 0 };
  }
}

async function handleOrderPaid(client: PoolClient, ev: OutboxRow): Promise<HandlerOutcome> {
  const orderId = ev.aggregate_id;
  const activeKey = await getActiveKey();
  const result = await issueTicketsForOrder(client, orderId, activeKey);

  // Transition paid -> fulfilled. The WHERE keeps this idempotent: on replay
  // the order is already fulfilled and this matches zero rows.
  await client.query(
    `UPDATE orders
        SET status = 'fulfilled',
            fulfilled_at = now()
      WHERE id = $1 AND status = 'paid'`,
    [orderId],
  );

  // Enqueue the email event. dedupe_key is unique per order, so a retry of
  // handleOrderPaid cannot enqueue a second email event.
  await client.query(
    `INSERT INTO outbox_events (dedupe_key, aggregate_type, aggregate_id, event_type, payload)
     VALUES ($1, 'order', $2, 'tickets.issued', $3)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [`tickets.issued:${orderId}`, orderId, JSON.stringify({ orderId })],
  );

  logger.info(
    { orderId, insertedTickets: result.inserted, totalTickets: result.ticketIds.length },
    'tickets issued',
  );
  return { insertedTickets: result.inserted, emailsSent: 0 };
}

async function handleTicketsIssued(client: PoolClient, ev: OutboxRow): Promise<HandlerOutcome> {
  const orderId = ev.aggregate_id;

  // Read everything the email needs in one query. All work happens inside
  // this tx: if the SMTP call throws, the outbox row stays unpublished and
  // the next tick retries. Trade-off: at-least-once delivery. A process crash
  // between SMTP acceptance and the commit causes one duplicate email; the
  // alternative (two-phase send + confirm) buys nothing for a demo and adds
  // a state machine we would then have to test.
  const { rows } = await client.query<{
    buyer_email: string;
    buyer_name: string;
    event_name: string;
    venue: string;
    starts_at: Date;
    ticket_id: string;
    short_code: string;
    tier_name: string;
    mailed_at: Date | null;
  }>(
    `SELECT u.email AS buyer_email,
            u.display_name AS buyer_name,
            e.name AS event_name,
            e.venue,
            e.starts_at,
            t.id AS ticket_id,
            t.short_code,
            tt.name AS tier_name,
            t.mailed_at
       FROM tickets t
       JOIN orders o ON o.id = t.order_id
       JOIN users u ON u.id = o.buyer_user_id
       JOIN events e ON e.id = t.event_id
       JOIN ticket_tiers tt ON tt.id = t.tier_id
      WHERE t.order_id = $1
      ORDER BY tt.name, t.serial_no`,
    [orderId],
  );
  if (rows.length === 0) {
    logger.warn({ orderId }, 'tickets.issued event has no tickets; nothing to email');
    return { insertedTickets: 0, emailsSent: 0 };
  }

  // If every ticket already has mailed_at set, a previous run completed the
  // send and we only lost the outbox commit. Skip re-sending.
  if (rows.every((r) => r.mailed_at !== null)) {
    return { insertedTickets: 0, emailsSent: 0 };
  }

  const items: TicketEmailItem[] = [];
  for (const r of rows) {
    const { rows: payloadRows } = await client.query<{ qr_payload: string }>(
      `SELECT qr_payload FROM tickets WHERE id = $1`,
      [r.ticket_id],
    );
    const qrPngDataUrl = await generateDataUrl(payloadRows[0]!.qr_payload);
    items.push({
      id: r.ticket_id,
      shortCode: r.short_code,
      tierName: r.tier_name,
      qrPngDataUrl,
    });
  }

  await sendTicketEmail({
    to: rows[0]!.buyer_email,
    buyerName: rows[0]!.buyer_name,
    eventName: rows[0]!.event_name,
    venue: rows[0]!.venue,
    startsAt: rows[0]!.starts_at,
    orderId,
    items,
  });

  // Mark all tickets for this order as mailed. Same tx as the send: if the
  // commit fails, we retry and resend (at-least-once); if it succeeds, a
  // subsequent replay sees mailed_at set and skips.
  await client.query(
    `UPDATE tickets SET mailed_at = now() WHERE order_id = $1 AND mailed_at IS NULL`,
    [orderId],
  );

  return { insertedTickets: 0, emailsSent: 1 };
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

let timer: NodeJS.Timeout | null = null;
let running = false;

export async function outboxTick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const r = await drainOutboxOnce();
    if (r.processed > 0) {
      logger.info(r, 'outbox tick');
    }
  } catch (err) {
    logger.error({ err }, 'outbox tick failed');
  } finally {
    running = false;
  }
}

export function startOutboxPublisher(intervalMs = 2_000): void {
  if (timer) return;
  timer = setInterval(() => void outboxTick(), intervalMs);
  timer.unref?.();
}

export function stopOutboxPublisher(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function _resetOutboxForTests(): void {
  stopOutboxPublisher();
  running = false;
}

// Silence unused import warning when only the Once function is imported.
void pool;
void config;