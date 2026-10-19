// The post-test audit. Every concurrency test calls checkInvariants() at the
// end. If any row is returned, the test fails with a human-readable listing.
//
// These are the invariants the whole system is designed around. A violation
// means a transactional boundary is wrong, a lock is missing, or a
// compensating action is incomplete.
//
// IMPORTANT: only run this when the DB is quiescent — no in-flight
// transactions. Our tests wait for all promises to resolve first.
import { pool } from '../../src/db/pool.js';

const INVARIANTS_SQL = `
SELECT category, ref, detail FROM (
  -- 1. Every tier's counters are non-negative and never exceed capacity.
  --    This is the CHECK constraint restated, so a violation here means the
  --    CHECK was bypassed by a bug that should be impossible.
  SELECT 'tier_counter'::text AS category,
         tt.id::text AS ref,
         format('cap=%s sold=%s reserved=%s', tt.capacity, tt.sold, tt.reserved) AS detail
    FROM ticket_tiers tt
   WHERE tt.sold < 0
      OR tt.reserved < 0
      OR tt.sold + tt.reserved > tt.capacity

  UNION ALL

  -- 2. No order reaches paid/fulfilled without a succeeded payment.
  SELECT 'paid_without_succeeded_payment',
         o.id::text,
         format('status=%s', o.status)
    FROM orders o
   WHERE o.status IN ('paid','fulfilled')
     AND NOT EXISTS (
       SELECT 1 FROM payments p
        WHERE p.order_id = o.id AND p.status = 'succeeded'
     )

  UNION ALL

  -- 3. Fulfilled orders have exactly the right number of tickets.
  SELECT 'fulfilled_ticket_count_mismatch',
         o.id::text,
         format('have=%s want=%s',
                (SELECT COUNT(*) FROM tickets t WHERE t.order_id = o.id),
                (SELECT COALESCE(SUM(oi.quantity),0) FROM order_items oi WHERE oi.order_id = o.id))
    FROM orders o
   WHERE o.status = 'fulfilled'
     AND (SELECT COUNT(*) FROM tickets t WHERE t.order_id = o.id)
         <> (SELECT COALESCE(SUM(oi.quantity),0) FROM order_items oi WHERE oi.order_id = o.id)

  UNION ALL

  -- 4. No duplicate scan_attempts for the same (device_id, client_scan_id).
  --    Enforced by a unique index; checked here for defense in depth.
  SELECT 'duplicate_scan_attempt',
         device_id || '/' || client_scan_id,
         ''
    FROM scan_attempts
   GROUP BY device_id, client_scan_id
  HAVING COUNT(*) > 1

  UNION ALL

  -- 5. Ticket status matches its timestamp columns.
  SELECT 'ticket_status_inconsistent',
         id::text,
         format('status=%s checked_in_at=%s voided_at=%s', status, checked_in_at, voided_at)
    FROM tickets
   WHERE (status = 'checked_in' AND checked_in_at IS NULL)
      OR (status = 'void' AND voided_at IS NULL)

  UNION ALL

  -- 6. No succeeded payment for a non-existent order. The FK prevents this;
  --    checked anyway because a wrong FK cascade or a manual data edit could
  --    break it.
  SELECT 'succeeded_payment_orphan',
         p.id::text,
         ''
    FROM payments p
   WHERE p.status = 'succeeded'
     AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = p.order_id)
) v
ORDER BY category, ref
`;

export interface InvariantViolation {
  category: string;
  ref: string;
  detail: string;
}

export async function checkInvariants(): Promise<void> {
  const { rows } = await pool.query<InvariantViolation>(INVARIANTS_SQL);
  if (rows.length > 0) {
    const lines = rows.map((r) => `  [${r.category}] ${r.ref}  ${r.detail}`).join('\n');
    throw new Error(`${rows.length} invariant violation(s):\n${lines}`);
  }
}

export async function listInvariants(): Promise<InvariantViolation[]> {
  const { rows } = await pool.query<InvariantViolation>(INVARIANTS_SQL);
  return rows;
}