// Multi-tier orders touching overlapping pairs. Without deterministic lock
// ordering, two orders touching {A,B} and {B,A} would deadlock. Our
// reserveTiers() sorts by tier id, so all callers acquire in the same order.
//
// The proof is negative: zero 5xx responses. A deadlock in Postgres aborts
// one transaction with SQLSTATE 40P01 and our error handler maps any
// unhandled error to a 500. So "no 5xx" == "no deadlock".
import { beforeEach, describe, expect, it } from 'vitest';
import {
  getTierCounters,
  postOrder,
  setupBurstContext,
  type ConcurrencyContext,
} from './helpers.js';
import { checkInvariants } from './invariants.js';
import { pool } from '../../src/db/pool.js';

describe('concurrency — deadlock freedom on overlapping tiers', () => {
  let ctx: ConcurrencyContext;
  let tierIds: string[];

  beforeEach(async () => {
    ctx = await setupBurstContext({
      tiers: [
        { name: 'A', capacity: 40, perOrderMax: 5 },
        { name: 'B', capacity: 40, perOrderMax: 5 },
        { name: 'C', capacity: 40, perOrderMax: 5 },
        { name: 'D', capacity: 40, perOrderMax: 5 },
      ],
    });
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM ticket_tiers WHERE event_id = $1 ORDER BY name`,
      [ctx.eventId],
    );
    tierIds = rows.map((r) => r.id);
  });

  it('200 orders on random overlapping tier pairs finish without deadlock', async () => {
    const N = 200;

    // Deterministic pseudo-random pairing so the test is reproducible.
    const pairs: Array<[number, number]> = [];
    for (let i = 0; i < N; i++) {
      const a = i % tierIds.length;
      const b = (i * 7 + 3) % tierIds.length;
      pairs.push(a === b ? [a, (b + 1) % tierIds.length] : [a, b]);
    }

    const results = await Promise.all(
      pairs.map((pair, i) =>
        postOrder(
          ctx.app,
          ctx.buyerToken,
          {
            eventId: ctx.eventId,
            items: [
              // Deliberately include the pair in an order that does not match
              // the sorted order, so the request-level list is unsorted —
              // reserveTiers() must still acquire locks in a fixed order.
              { tierId: tierIds[pair[0]]!, quantity: 1 },
              { tierId: tierIds[pair[1]]!, quantity: 1 },
            ],
          },
          `pair-${i}-${Date.now()}`,
        ),
      ),
    );

    // The deadlock-freedom assertion.
    const serverErrors = results.filter((r) => r.status >= 500);
    expect(
      serverErrors,
      `expected no 5xx (deadlock would surface here): ${JSON.stringify(
        serverErrors.slice(0, 3),
      )}`,
    ).toEqual([]);

    // Every request landed in one of the two expected buckets.
    const created = results.filter((r) => r.status === 201).length;
    const conflicts = results.filter((r) => r.status === 409).length;
    expect(created + conflicts).toBe(N);
    // With 4 tiers × capacity 40 and ~100 touches per tier, we expect roughly
    // half to succeed and half to hit capacity. Bounds, not exact values —
    // the interleaving is nondeterministic by design.
    expect(created).toBeGreaterThan(0);
    expect(created).toBeLessThan(N);

    // Every tier within bounds.
    for (const tierId of tierIds) {
      const c = await getTierCounters(tierId);
      expect(c.sold + c.reserved).toBeLessThanOrEqual(c.capacity);
      expect(c.sold).toBeGreaterThanOrEqual(0);
      expect(c.reserved).toBeGreaterThanOrEqual(0);
    }

    await checkInvariants();
  });
});