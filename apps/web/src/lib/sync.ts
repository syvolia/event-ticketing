// Client-side sync loop. Runs whenever the browser comes online, on a timer,
// and on manual retry. Each pending scan is sent as part of a single batch;
// the server's idempotency (device_id + clientScanId) means we can retry the
// whole batch without worrying about duplicates.
import { api } from './api.js';
import type { ScanResult } from '@ticketing/shared';
import {
  clearSyncedScans,
  listPendingScans,
  markScanSynced,
  type PendingScan,
} from './idb.js';

const SYNC_INTERVAL_MS = 5_000;
let timer: number | null = null;
let inflight = false;

export interface SyncOutcome {
  attempted: number;
  synced: number;
  failed: number;
}

export async function syncOnce(): Promise<SyncOutcome> {
  if (inflight) return { attempted: 0, synced: 0, failed: 0 };
  inflight = true;
  try {
    const pending = await listPendingScans();
    if (pending.length === 0) return { attempted: 0, synced: 0, failed: 0 };

    const body = {
      scans: pending.map((s) => ({
        clientScanId: s.clientScanId,
        token: s.token,
        deviceId: s.deviceId,
        scannedAt: s.scannedAt,
        eventId: s.eventId,
        ...(s.gate ? { gate: s.gate } : {}),
      })),
    };

    try {
      const res = await api<{ results: ScanResult[] }>('/checkin/sync', {
        method: 'POST',
        json: body,
      });
      let synced = 0;
      for (const r of res.results) {
        await markScanSynced(r.clientScanId, r.outcome);
        synced += 1;
      }
      await clearSyncedScans();
      return { attempted: pending.length, synced, failed: pending.length - synced };
    } catch {
      // Network failure: keep the scans queued and try again next tick.
      return { attempted: pending.length, synced: 0, failed: pending.length };
    }
  } finally {
    inflight = false;
  }
}

export function startSyncLoop(onChange?: (outcome: SyncOutcome) => void): () => void {
  const run = async (): Promise<void> => {
    const outcome = await syncOnce();
    if (outcome.attempted > 0) onChange?.(outcome);
  };

  // Immediately, then on the interval, then whenever we come online.
  void run();
  timer = window.setInterval(() => void run(), SYNC_INTERVAL_MS);
  const onOnline = (): void => void run();
  window.addEventListener('online', onOnline);

  return () => {
    if (timer !== null) window.clearInterval(timer);
    window.removeEventListener('online', onOnline);
  };
}

export function triggerSync(): Promise<SyncOutcome> {
  return syncOnce();
}

export type { PendingScan };