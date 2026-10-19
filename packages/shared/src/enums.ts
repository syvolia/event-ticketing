// Mirror of the Postgres enums. Kept as const tuples so Zod can build
// validators and so the generated literal types match the DB exactly.
//
// Every enum here corresponds to a type in migrations/*.sql:
//   - EVENT_STATUSES        → event_status        (0001_init.sql)
//   - ORDER_STATUSES        → order_status        (0001 + 0003)
//   - TICKET_STATUSES       → ticket_status       (0001_init.sql)
//   - PAYMENT_PROVIDERS     → payment_provider    (0001_init.sql)
//   - PAYMENT_STATUSES      → payment_status      (0001_init.sql)
//   - USER_ROLES            → user_role           (0002_auth.sql)
//   - CHECKIN_OUTCOMES      → checkin_outcome     (0006_checkin.sql)
//
// Order matters for ORDER_STATUSES: 'refund_pending' must come after
// 'failed' and before 'refunded' to match the Postgres enum's ordering,
// which was set by migration 0003's `ADD VALUE ... BEFORE 'refunded'`.
// Reordering this tuple without a corresponding migration will not break
// runtime behavior, but it will make DB errors and API responses disagree
// about what "the statuses in order" means — keep them in sync.

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
export const EVENT_STATUSES = ['draft', 'published', 'cancelled'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];
export const eventStatusSchema = z.enum(EVENT_STATUSES);

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------
// `refund_pending` is a terminal-ish intermediate state: money has moved
// (payment.status = 'succeeded') but the tickets could not be fulfilled —
// typically because the reservation expired and inventory could not be
// re-claimed. A refund row is created and a worker eventually moves it to
// `refunded`. The state machine in migration 0004 permits transitions into
// and out of it; see enforce_order_transition().
export const ORDER_STATUSES = [
  'pending',
  'awaiting_payment',
  'paid',
  'fulfilled',
  'expired',
  'failed',
  'refund_pending',
  'refunded',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const orderStatusSchema = z.enum(ORDER_STATUSES);

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------
export const TICKET_STATUSES = ['valid', 'checked_in', 'void'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export const ticketStatusSchema = z.enum(TICKET_STATUSES);

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------
export const PAYMENT_PROVIDERS = ['mpesa', 'stripe'] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];
export const paymentProviderSchema = z.enum(PAYMENT_PROVIDERS);

export const PAYMENT_STATUSES = [
  'initiated',
  'pending',
  'succeeded',
  'failed',
  'refunded',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export const paymentStatusSchema = z.enum(PAYMENT_STATUSES);

// ---------------------------------------------------------------------------
// Users & roles
// ---------------------------------------------------------------------------
// `staff` is the scanner operator role: permitted to call /checkin and
// /checkin/sync, and to read checkin-manifests and checkin-stats, but not
// to modify events or issue refunds.
export const USER_ROLES = ['organizer', 'attendee', 'staff'] as const;
export type UserRole = (typeof USER_ROLES)[number];
export const userRoleSchema = z.enum(USER_ROLES);

// ---------------------------------------------------------------------------
// Check-in outcomes
// ---------------------------------------------------------------------------
// Written to scan_attempts.outcome for every attempted scan, accepted or not.
// The API returns this same value to the scanner so the client can render
// the correct overlay without inventing its own classification.
//
//   accepted       — this scan won the check-in (first ever, or earliest
//                    offline scan overriding a later one)
//   duplicate      — the ticket is already checked in with an earlier-or-equal
//                    timestamp; the response carries the winning scan's details
//   void           — the ticket's status is 'void'
//   wrong_event    — token's event does not match the ticket's event, or the
//                    caller passed a scope eventId that does not match
//   not_found      — the ticket id in the token does not exist
//   invalid_token  — HMAC verification failed or the payload was malformed
export const CHECKIN_OUTCOMES = [
  'accepted',
  'duplicate',
  'void',
  'wrong_event',
  'not_found',
  'invalid_token',
] as const;
export type CheckinOutcome = (typeof CHECKIN_OUTCOMES)[number];
export const checkinOutcomeSchema = z.enum(CHECKIN_OUTCOMES);