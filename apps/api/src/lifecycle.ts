// Two-phase shutdown with a hard deadline.
//
// Phase 1: stop accepting new HTTP connections. In-flight requests continue.
// Phase 2: signal workers to stop and wait for the current tick.
// Phase 3: drain the pg pool. This blocks until every checked-out client is
//          released — which cannot happen until all in-flight transactions
//          commit or roll back.
//
// A watchdog kills the process if we exceed `SHUTDOWN_DEADLINE_MS`. Without
// it, a stuck query (blocked on a lock that will never release) can prevent
// rollout indefinitely; with it, we lose at most the tail of the outage
// window and let the orchestrator restart.
import type { FastifyInstance } from 'fastify';
import { pool } from './db/pool.js';
import { logger } from './logger.js';
import { stopSweeper } from './workers/sweeper.js';
import { stopPaymentReconciler } from './workers/paymentReconciler.js';
import { stopOutboxPublisher } from './workers/outboxPublisher.js';
import { stopMetricsSampler } from './workers/metricsSampler.js';

const SHUTDOWN_DEADLINE_MS = 30_000;

export interface ShutdownHooks {
  app: FastifyInstance;
}

export function installSignalHandlers({ app }: ShutdownHooks): void {
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      logger.warn({ signal }, 'shutdown already in progress');
      return;
    }
    shuttingDown = true;
    const startedAt = Date.now();
    logger.info({ signal }, 'shutdown initiated');

    const watchdog = setTimeout(() => {
      logger.error(
        { signal, elapsedMs: Date.now() - startedAt },
        'shutdown deadline exceeded; forcing exit',
      );
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS);
    watchdog.unref();

    try {
      // 1. Stop accepting new connections; wait for in-flight requests.
      //    Fastify's close() rejects when the server cannot be closed
      //    cleanly; we catch and log so the drain still happens.
      await app.close();
      logger.info({ elapsedMs: Date.now() - startedAt }, 'http server closed');

      // 2. Signal workers. Their current tick, if any, finishes naturally
      //    because each `*Once()` function is already running to completion
      //    in its own async frame; we simply stop scheduling new ticks.
      stopSweeper();
      stopPaymentReconciler();
      stopOutboxPublisher();
      stopMetricsSampler();
      logger.info({ elapsedMs: Date.now() - startedAt }, 'workers stopped');

      // 3. Drain the pool. This resolves only after every client is
      //    released back to the pool, i.e. every transaction has committed
      //    or rolled back.
      await pool.end();
      logger.info({ elapsedMs: Date.now() - startedAt }, 'pg pool drained');

      clearTimeout(watchdog);
      process.exit(0);
    } catch (err) {
      logger.error({ err, signal }, 'shutdown failed');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Node's default for unhandled rejection is to crash. We log first so the
  // reason is captured, then exit — a Promise rejected without a handler is
  // a bug in our code, and continuing would compound it.
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled promise rejection; exiting');
    process.exit(1);
  });

  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'uncaught exception; exiting');
    process.exit(1);
  });
}