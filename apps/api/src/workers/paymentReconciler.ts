// Reconciliation worker.
//
// Two jobs share one interval:
//
//   1. Orphan drain: any payment_events with payment_id NULL whose
//      provider_event_id now matches a payments.provider_ref gets bound and
//      processed. This catches the race where a callback arrived before the
//      pay endpoint stored the ref (startPayment already drains once; this is
//      the safety net for the case where the process died between STK Push
//      returning and tx2 committing).
//
//   2. STK status query: payments stuck in `initiated` for more than
//      STUCK_AFTER_SECONDS get their status queried. M-Pesa callbacks
//      occasionally never arrive; the query endpoint is the fallback.
//
// Both use FOR UPDATE SKIP LOCKED so multiple replicas can run this worker
// concurrently without contending.

import { pool } from '../db/pool.js';
import { withTransaction } from '../db/tx.js';
import { getProvider } from '../payments/registry.js';
import type { PaymentProvider as PaymentProviderName } from '@ticketing/shared';
import { logger } from '../logger.js';
import { findStuckPayments, drainOrphanEvents } from '../services/payments.js';

const STUCK_AFTER_SECONDS = 120;
const BATCH_SIZE = 50;
const INTERVAL_MS = 30_000;

export async function drainAllOrphansOnce(limit = BATCH_SIZE): Promise<number> {
  // Pick a batch of orphan events, grouped by (provider, provider_event_id).
  // For each, call drainOrphanEvents which re-checks the payment row.
  const { rows } = await pool.query<{
    provider: PaymentProviderName;
    provider_event_id: string;
  }>(
    `SELECT DISTINCT provider, provider_event_id
       FROM payment_events
      WHERE payment_id IS NULL
        AND processed_at IS NULL
        AND received_at > now() - interval '1 day'
      LIMIT $1`,
    [limit],
  );
  let total = 0;
  for (const r of rows) {
    total += await drainOrphanEvents(r.provider, r.provider_event_id);
  }
  return total;
}

export async function reconcileStuckPaymentsOnce(): Promise<number> {
  const stuck = await findStuckPayments(STUCK_AFTER_SECONDS, BATCH_SIZE);
  let reconciled = 0;
  for (const payment of stuck) {
    const provider = getProvider(payment.provider);
    if (!provider.queryStatus || !payment.provider_ref) continue;
    try {
      const result = await provider.queryStatus({
        providerRef: payment.provider_ref,
        amountMinor: payment.amount_minor,
      });
      if (result.status === 'pending') continue;

      // Route the result through the same recordWebhook path so the whole
      // state machine, idempotency fences, and refund policy apply uniformly.
      const syntheticPayload =
        payment.provider === 'mpesa'
          ? {
              Body: {
                stkCallback: {
                  MerchantRequestID: payment.merchant_request_id ?? '',
                  CheckoutRequestID: payment.provider_ref,
                  ResultCode: Number(result.failureCode ?? (result.status === 'succeeded' ? 0 : 1037)),
                  ResultDesc: result.failureReason ?? result.status,
                },
              },
            }
          : { id: `query_${payment.provider_ref}_${Date.now()}`, type: result.status === 'succeeded' ? 'payment_intent.succeeded' : 'payment_intent.payment_failed', data: { object: result.raw } };

      const { recordWebhook } = await import('../services/payments.js');
      await recordWebhook(payment.provider, {
        headers: {},
        rawBody: Buffer.from(JSON.stringify(syntheticPayload)),
        body: syntheticPayload,
      });
      reconciled += 1;
    } catch (err) {
      logger.warn({ err, paymentId: payment.id }, 'reconcile query failed');
    }
  }
  return reconciled;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export async function reconcileTick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const orphans = await drainAllOrphansOnce();
    const reconciled = await reconcileStuckPaymentsOnce();
    if (orphans > 0 || reconciled > 0) {
      logger.info({ orphans, reconciled }, 'payment reconciler tick');
    }
  } catch (err) {
    logger.error({ err }, 'payment reconciler tick failed');
  } finally {
    running = false;
  }
}

export function startPaymentReconciler(intervalMs = INTERVAL_MS): void {
  if (timer) return;
  timer = setInterval(() => void reconcileTick(), intervalMs);
  timer.unref?.();
}

export function stopPaymentReconciler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function _resetReconcilerForTests(): void {
  stopPaymentReconciler();
  running = false;
}

// Silence unused-import warnings when only the individual Once functions are
// imported by tests.
void withTransaction;