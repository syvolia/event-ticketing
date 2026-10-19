// k6 burst test: 1,000 virtual users, each attempts to buy 1 ticket from a
// tier with capacity 10. Exactly 10 orders must be created; the remaining
// 990 must be rejected with 409. Any 5xx is a bug.
//
// k6 doesn't have DB access, so the summary prints the psql command to run
// afterward. The threshold `orders_created: ['count<=10']` fails the run if
// more than 10 orders are created, which is the oversell assertion at the
// HTTP layer.
//
// Install:  brew install k6
// Run:      k6 run apps/api/test/load/k6-buyers.js
// Env:      API_URL=http://localhost:3000 (default)
//           API_URL=https://api.staging.example.com k6 run ...
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const ordersCreated = new Counter('orders_created');
const ordersRejected = new Counter('orders_rejected');
const ordersErrored = new Counter('orders_errored');

export const options = {
  scenarios: {
    burst: {
      // Every VU runs exactly one iteration, all firing as close to
      // simultaneously as k6 can schedule.
      executor: 'per-vu-iterations',
      vus: 1000,
      iterations: 1,
      maxDuration: '3m',
    },
  },
  thresholds: {
    // The oversell assertion at the HTTP layer.
    orders_created: ['count<=10'],
    // No unexpected server-side failures.
    orders_errored: ['count==0'],
    // No request should take longer than 10s. A long tail indicates lock
    // queue buildup worth investigating.
    http_req_duration: ['p(99)<10000'],
  },
};

const BASE = __ENV.API_URL || 'http://localhost:3000';

export function setup() {
  const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();

  // --- organizer --------------------------------------------------------
  const orgRes = http.post(
    `${BASE}/auth/register`,
    JSON.stringify({
      email: `k6-org-${uniq}@example.com`,
      password: 'correct horse battery staple',
      displayName: 'K6 Org',
      role: 'organizer',
    }),
    { headers: { 'content-type': 'application/json' } },
  );
  if (orgRes.status !== 201) {
    throw new Error(`org register failed: ${orgRes.status} ${orgRes.body}`);
  }
  const orgToken = orgRes.json('accessToken');

  // --- event ------------------------------------------------------------
  const evRes = http.post(
    `${BASE}/events`,
    JSON.stringify({
      name: `K6 Burst ${uniq}`,
      description: '',
      venue: 'Load Test Venue',
      startsAt: new Date(now + 86_400_000).toISOString(),
      endsAt: new Date(now + 86_400_000 + 3_600_000).toISOString(),
    }),
    {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${orgToken}` },
    },
  );
  if (evRes.status !== 201) {
    throw new Error(`event create failed: ${evRes.status} ${evRes.body}`);
  }
  const eventId = evRes.json('event.id');

  // --- tier (capacity 10, per-order max 1) ------------------------------
  const tierRes = http.post(
    `${BASE}/events/${eventId}/tiers`,
    JSON.stringify({
      name: 'K6-GA',
      priceMinor: 50_000,
      currency: 'KES',
      capacity: 10,
      perOrderMax: 1,
      salesStart: new Date(now - 3_600_000).toISOString(),
      salesEnd: new Date(now + 86_400_000).toISOString(),
    }),
    {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${orgToken}` },
    },
  );
  if (tierRes.status !== 201) {
    throw new Error(`tier create failed: ${tierRes.status} ${tierRes.body}`);
  }
  const tierId = tierRes.json('tier.id');

  // --- publish ----------------------------------------------------------
  const pubRes = http.post(`${BASE}/events/${eventId}/publish`, null, {
    headers: { authorization: `Bearer ${orgToken}` },
  });
  if (pubRes.status < 200 || pubRes.status >= 300) {
    throw new Error(`publish failed: ${pubRes.status} ${pubRes.body}`);
  }

  // --- buyer (one buyer; each VU uses a different idempotency key) ------
  const buyRes = http.post(
    `${BASE}/auth/register`,
    JSON.stringify({
      email: `k6-buyer-${uniq}@example.com`,
      password: 'correct horse battery staple',
      displayName: 'K6 Buyer',
      role: 'attendee',
    }),
    { headers: { 'content-type': 'application/json' } },
  );
  if (buyRes.status !== 201) {
    throw new Error(`buyer register failed: ${buyRes.status} ${buyRes.body}`);
  }
  const buyerToken = buyRes.json('accessToken');

  return { eventId, tierId, buyerToken, startedAt: now };
}

export default function (data) {
  const key = `k6-${data.startedAt}-${__VU}`;
  const res = http.post(
    `${BASE}/orders`,
    JSON.stringify({
      eventId: data.eventId,
      items: [{ tierId: data.tierId, quantity: 1 }],
    }),
    {
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${data.buyerToken}`,
        'idempotency-key': key,
      },
    },
  );

  if (res.status === 201) ordersCreated.add(1);
  else if (res.status === 409) ordersRejected.add(1);
  else ordersErrored.add(1);

  check(res, {
    'created or rejected': (r) => r.status === 201 || r.status === 409,
  });
}

export function handleSummary(data) {
  const m = data.metrics;
  const created = m.orders_created ? m.orders_created.values.count : 0;
  const rejected = m.orders_rejected ? m.orders_rejected.values.count : 0;
  const errored = m.orders_errored ? m.orders_errored.values.count : 0;
  const total = m.http_reqs.values.count;
  const avg = m.http_req_duration.values.avg;
  const p95 = m.http_req_duration.values['p(95)'];
  const p99 = m.http_req_duration.values['p(99)'];
  const max = m.http_req_duration.values.max;

  const verdict = created === 10 && rejected === 990 && errored === 0 ? 'PASS' : 'FAIL';

  const text = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Ticket burst test — 1000 VUs, tier capacity 10, quantity 1 per request
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Orders created  (201):   ${String(created).padStart(5)}   expected: 10
 Orders rejected (409):   ${String(rejected).padStart(5)}   expected: 990
 Other responses:         ${String(errored).padStart(5)}   expected: 0
 Total HTTP requests:     ${String(total).padStart(5)}

 Latency (ms):
   avg ${avg.toFixed(1).padStart(8)}   p95 ${p95.toFixed(1).padStart(8)}
   p99 ${p99.toFixed(1).padStart(8)}   max ${max.toFixed(1).padStart(8)}

 Result: ${verdict}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Verify the DB invariant:
   docker exec ticketing-db psql -U ticketing -d ticketing -c \\
     "SELECT capacity, sold, reserved, sold + reserved AS used
        FROM ticket_tiers WHERE name = 'K6-GA'
        ORDER BY created_at DESC LIMIT 1"

 Expect: capacity=10, sold=0, reserved=10, used=10.
 Any 'used' greater than 10 means the oversell protection is broken.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;
  return { stdout: text };
}
