// The main() function now lives in a separate file so `buildServer` stays
// testable and the lifecycle wiring is obvious. Anything that runs at boot
// is in one place.
import { config } from './config.js';
import { logger } from './logger.js';
import { buildServer } from './server.js';
import { ensureActiveSigningKey } from './qr/keys.js';
import { installSignalHandlers } from './lifecycle.js';
import { startSweeper } from './workers/sweeper.js';
import { startPaymentReconciler } from './workers/paymentReconciler.js';
import { startOutboxPublisher } from './workers/outboxPublisher.js';
import { startMetricsSampler } from './workers/metricsSampler.js';

async function main(): Promise<void> {
  await ensureActiveSigningKey();

  const app = await buildServer();
  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
  } catch (err) {
    app.log.error({ err }, 'failed to start');
    process.exit(1);
  }

  startSweeper();
  startPaymentReconciler();
  startOutboxPublisher();
  startMetricsSampler();

  installSignalHandlers({ app });
}

void main();