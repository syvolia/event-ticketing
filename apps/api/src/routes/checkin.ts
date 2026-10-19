import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { checkinInputSchema, syncInputSchema } from '@ticketing/shared';
import { requireRole } from '../auth/hooks.js';
import { RATE_LIMITS } from '../plugins/rateLimit.js';
import {
  buildCheckinManifest,
  checkin,
  getCheckinStats,
  syncScans,
} from '../services/checkin.js';
import {
  checkinAccepted,
  checkinDuration,
  checkinRejects,
} from '../metrics.js';

const uuidParam = z.string().uuid();

export async function registerCheckinRoutes(app: FastifyInstance): Promise<void> {
  // Single scan. Rate-limited per staff user (the JWT sub is the key).
  app.post(
    '/checkin',
    { preHandler: requireRole('staff', 'organizer'), config: { rateLimit: RATE_LIMITS.checkin } },
    async (req) => {
      const body = checkinInputSchema.parse(req.body);
      req.attachLogContext({
        userId: req.user.sub,
        deviceId: body.deviceId,
      });

      const timer = checkinDuration.startTimer();
      try {
        const result = await checkin(req.user.sub, body);
        req.attachLogContext({
          outcome: result.outcome,
          ...(result.ticketId ? { ticketId: result.ticketId } : {}),
        });
        if (result.outcome === 'accepted') {
          checkinAccepted.inc();
        } else {
          checkinRejects.inc({ outcome: result.outcome });
        }
        return result;
      } finally {
        timer();
      }
    },
  );

  // Batch sync. Per-scan metrics are aggregated into a small set of label
  // combinations — one increment per outcome, not per scan — to keep
  // cardinality predictable when a device uploads 500 scans at once.
  app.post(
    '/checkin/sync',
    {
      preHandler: requireRole('staff', 'organizer'),
      config: { rateLimit: RATE_LIMITS.checkinSync },
    },
    async (req) => {
      const body = syncInputSchema.parse(req.body);
      req.attachLogContext({
        userId: req.user.sub,
        scanCount: body.scans.length,
      });

      const results = await syncScans(req.user.sub, body.scans);

      // Aggregate once per batch. If you ever want per-scan detail, iterate
      // `results` and increment for each — but expect the metric count to
      // scale linearly with scan volume.
      const counts = new Map<string, number>();
      let accepted = 0;
      for (const r of results) {
        if (r.outcome === 'accepted') accepted += 1;
        else counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1);
      }
      if (accepted > 0) checkinAccepted.inc(accepted);
      for (const [outcome, n] of counts) checkinRejects.inc({ outcome }, n);

      req.attachLogContext({ acceptedCount: accepted });
      return { results };
    },
  );

  // Compact manifest for offline verification. Contains every ticket id for
  // the event and the set of signing key ids currently trusted. This payload
  // is deliberately small (a few hundred KB for a large event) and
  // aggressively cacheable.
  app.get<{ Params: { id: string } }>(
    '/events/:id/checkin-manifest',
    { preHandler: requireRole('staff', 'organizer') },
    async (req) => {
      const id = uuidParam.parse(req.params.id);
      req.attachLogContext({ userId: req.user.sub, eventId: id });
      return await buildCheckinManifest(id);
    },
  );

  // Live stats for the scanner header. Cheap enough to poll every few seconds.
  app.get<{ Params: { id: string } }>(
    '/events/:id/checkin-stats',
    { preHandler: requireRole('staff', 'organizer') },
    async (req) => {
      const id = uuidParam.parse(req.params.id);
      req.attachLogContext({ userId: req.user.sub, eventId: id });
      return await getCheckinStats(id);
    },
  );
}