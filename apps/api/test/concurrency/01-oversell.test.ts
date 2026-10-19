// THE flagship test. This is the one to show in a portfolio review.
//
// 200 concurrent POST /orders against a tier with capacity 10. Exactly 10
// must succeed. The rest must get a clean 409. The DB invariant
// `sold + reserved <= capacity` must hold. No negative counters.
//
// The second describe block runs the SAME load against a deliberately naive
// implementation and demonstrates that it oversells. The side-by-side
// comparison is the point.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  getTierCounters,
  postOrder,
  setupBurstContext,
  type ConcurrencyContext,
} from './helpers.js';
import { checkInvariants } from './invariants.js';
import {
  readNaiveCounters,
  reserveTierNaive,
  setupNaiveTable,
  setupNaiveTier,
} from './naive-inventory.js';

describe('concurrency — oversell protection (correct implementation)', () => {
  let ctx: ConcurrencyContext;

  beforeEach(async () => {
    ctx = await setupBurstContext({ capacity: 10 });
  });

  it('200 concurrent orders on capacity 10: exactly 10 succeed', async () => {
    const N = 200;
    const startedAt = Date.now();

    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        postOrder(
          ctx.app,
          ctx.buyerToken,
          { eventId: ctx.eventId, items: [{ tierId: ctx.tierId, quantity: 1 }] },
          `burst-${i}-${startedAt}`,
        ),
      ),
    );

    const created = results.filter((r) => r.status === 201).length;
    const conflicts = results.filter((r) => r.status === 409).length;
    const unexpected = results.filter((r) => r.status !== 201 && r.status !== 409);

    // Any 5xx, 4xx other than 409, or non-JSON response indicates a bug
    // elsewhere — the reservation path is supposed to be silent on the wire
    // except for the 201/409 split.
    expect(
      unexpected,
      `unexpected statuses: ${JSON.stringify(
        unexpected.slice(0, 3).map((r) => ({ status: r.status, body: r.body })),
      )}`,
    ).toEqual([]);

    expect(created).toBe(10);
    expect(conflicts).toBe(N - 10);

    const counters = await getTierCounters(ctx.tierId);
    // The core invariant: capacity is never exceeded.
    expect(counters.sold + counters.reserved).toBeLessThanOrEqual(counters.capacity);
    // No negative values.
    expect(counters.sold).toBeGreaterThanOrEqual(0);
    expect(counters.reserved).toBeGreaterThanOrEqual(0);
    // Exactly the capacity was reserved by winners.
    expect(counters.reserved).toBe(10);
    expect(counters.sold).toBe(0);

    // The full audit — checks every invariant across the DB.
    await checkInvariants();
  });

  it('capacity 1, 50 concurrent requests: exactly one succeeds', async () => {
    const small = await setupBurstContext({ capacity: 1 });
    const N = 50;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        postOrder(
          small.app,
          small.buyerToken,
          { eventId: small.eventId, items: [{ tierId: small.tierId, quantity: 1 }] },
          `one-${i}-${Date.now()}`,
        ),
      ),
    );

    expect(results.filter((r) => r.status === 201).length).toBe(1);
    expect(results.filter((r) => r.status === 409).length).toBe(N - 1);

    const counters = await getTierCounters(small.tierId);
    expect(counters.reserved).toBe(1);
    expect(counters.sold).toBe(0);

    await checkInvariants();
  });
});

describe('concurrency — naive implementation oversells (for comparison)', () => {
  beforeEach(async () => {
    await setupNaiveTable();
  });

  it('the naive read-then-write implementation oversells on capacity 10', async () => {
    const tierId = await setupNaiveTier(10);
    const N = 200;

    await Promise.all(
      Array.from({ length: N }, () => reserveTierNaive(tierId, 1)),
    );

    const counters = await readNaiveCounters(tierId);

    // The naive implementation cannot uphold the invariant. If this
    // assertion ever fails, the load generator was too slow to interleave —
    // unlikely with 200 parallel calls, but possible on an idle machine with
    // a fast loop. Re-run; the failure mode is not "the naive code got
    // better".
    expect(counters.reserved).toBeGreaterThan(counters.capacity);

    // Diagnostic for the log — this is the money line for the portfolio.
    // eslint-disable-next-line no-console
    console.log(
      `[naive oversell] capacity=${counters.capacity} reserved=${counters.reserved} ` +
        `→ oversold by ${counters.reserved - counters.capacity}`,
    );
  });
});