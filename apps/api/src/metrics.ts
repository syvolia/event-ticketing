// A single module owns every metric. Route handlers and workers import named
// functions; nothing calls the registry directly. That keeps the surface
// small and makes it obvious what is being measured.
//
// Cardinality discipline:
//   - Labels are finite: no order ids, no ticket ids, no user ids.
//   - Where a "reason" exists (conflict reason, check-in outcome) it comes
//     from a closed enum, so the label space is bounded by construction.
import client from 'prom-client';

const register = new client.Registry();

// Default Node process metrics: heap, GC, event loop lag, CPU. Useful for
// the "why did p99 spike" question that counters alone cannot answer.
client.collectDefaultMetrics({
  register,
  prefix: 'ticketing_',
});

// --- counters --------------------------------------------------------------

export const ordersCreated = new client.Counter({
  name: 'ticketing_orders_created_total',
  help: 'Orders successfully created with a reservation held',
  labelNames: ['event_tier_count'] as const,
  registers: [register],
});

export const reservationConflicts = new client.Counter({
  name: 'ticketing_reservation_conflicts_total',
  help: 'Reservation attempts rejected by the inventory predicate',
  // reason ∈ {INSUFFICIENT_INVENTORY, EXCEEDS_PER_ORDER_MAX, SALES_CLOSED,
  //           SALES_NOT_OPEN, TIER_NOT_FOUND} — closed set.
  labelNames: ['reason'] as const,
  registers: [register],
});

export const expiredReservationsReleased = new client.Counter({
  name: 'ticketing_expired_reservations_released_total',
  help: 'Reservations released by the sweeper after expiry',
  registers: [register],
});

export const webhookDuplicates = new client.Counter({
  name: 'ticketing_webhook_duplicates_total',
  help: 'Webhook deliveries rejected as duplicates by the idempotency fence',
  labelNames: ['provider'] as const,
  registers: [register],
});

export const checkinRejects = new client.Counter({
  name: 'ticketing_checkin_rejects_total',
  help: 'Check-in attempts that did not result in a new check-in',
  // outcome ∈ {duplicate, void, wrong_event, not_found, invalid_token}
  labelNames: ['outcome'] as const,
  registers: [register],
});

export const checkinAccepted = new client.Counter({
  name: 'ticketing_checkin_accepted_total',
  help: 'Check-in attempts that won the atomic transition',
  registers: [register],
});

// --- histograms ------------------------------------------------------------

export const orderCreateDuration = new client.Histogram({
  name: 'ticketing_order_create_duration_seconds',
  help: 'Wall-clock time for POST /orders',
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [register],
});

export const checkinDuration = new client.Histogram({
  name: 'ticketing_checkin_duration_seconds',
  help: 'Wall-clock time for POST /checkin',
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register],
});

export const paymentInitiateDuration = new client.Histogram({
  name: 'ticketing_payment_initiate_duration_seconds',
  help: 'Wall-clock time for provider.initiate() call',
  labelNames: ['provider'] as const,
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

// --- gauges ----------------------------------------------------------------

// In-flight transactions across the pool. A rising trend with flat throughput
// usually means locks are being held too long.
export const poolInUse = new client.Gauge({
  name: 'ticketing_pg_pool_in_use',
  help: 'pg pool clients currently checked out',
  registers: [register],
});
export const poolIdle = new client.Gauge({
  name: 'ticketing_pg_pool_idle',
  help: 'pg pool clients currently idle',
  registers: [register],
});
export const poolWaiting = new client.Gauge({
  name: 'ticketing_pg_pool_waiting',
  help: 'callers waiting for a pg pool client',
  registers: [register],
});

export { register };