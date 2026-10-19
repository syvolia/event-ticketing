// Samples pg pool health into Prometheus gauges on a fixed interval.
//
// Why a sampler and not per-request instrumentation: the gauges answer
// "how saturated is the pool right now?" — a query-time view is enough, and
// pushing values on every query adds a metric write to every DB call. A 5s
// sample cadence gives a smooth-enough graph for alerting without loading
// the process.
//
// The running flag prevents overlapping samples if a tick ever takes longer
// than the interval (unlikely — pg's pool object reads are synchronous — but
// the guard is free and makes the invariant explicit).
import { pool } from '../db/pool.js';
import { poolIdle, poolInUse, poolWaiting } from '../metrics.js';
import { logger } from '../logger.js';

let timer: NodeJS.Timeout | null = null;
let running = false;

function sample(): void {
  if (running) return;
  running = true;
  try {
    // pg's Pool exposes live counters. `totalCount` is everything the pool
    // has open (idle + checked-out); `idleCount` is the subset sitting in
    // the free list; `waitingCount` is callers blocked because no client
    // was available. The three together tell you:
    //   - in_use rising with throughput flat → transactions are too long
    //   - waiting rising at all → pool size is too small for the workload
    //   - idle == total, in_use == 0, waiting == 0 → healthy and underused
    poolInUse.set(pool.totalCount - pool.idleCount);
    poolIdle.set(pool.idleCount);
    poolWaiting.set(pool.waitingCount);
  } catch (err) {
    // Never let the sampler crash the process. A failed metric write is a
    // silent observability gap, not a reason to take down the API.
    logger.error({ err }, 'metrics sampler failed');
  } finally {
    running = false;
  }
}

export function startMetricsSampler(intervalMs = 5_000): void {
  if (timer) return;
  // Sample once immediately so a scrape right after boot sees real values
  // instead of zeros.
  sample();
  timer = setInterval(sample, intervalMs);
  // Do not hold the process open — the HTTP listener is what keeps us alive.
  timer.unref?.();
}

export function stopMetricsSampler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Test helper — resets module state so a fresh suite starts clean. */
export function _resetMetricsSamplerForTests(): void {
  stopMetricsSampler();
  running = false;
}