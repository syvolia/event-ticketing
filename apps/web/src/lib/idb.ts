// IndexedDB stores. Two databases:
//   - 'ticketing-manifest' caches the check-in manifest per event.
//   - 'ticketing-queue'    holds pending scans until they sync.
import { openDB, type IDBPDatabase } from 'idb';
import type { CheckinManifest, ManifestTicket } from '@ticketing/shared';

export interface CachedManifest {
  eventId: string;
  eventName: string;
  fetchedAt: number;
  signingKids: string[];
  tickets: Record<string, ManifestTicket>;
}

export interface PendingScan {
  clientScanId: string;
  token: string;
  deviceId: string;
  scannedAt: string;
  eventId: string;
  gate?: string;
  /** Local outcome shown to the user while offline. */
  localOutcome: 'accepted' | 'duplicate' | 'void' | 'unknown';
  /** Server outcome once synced. */
  serverOutcome?: string;
  syncedAt?: number;
}

const MANIFEST_DB = 'ticketing-manifest';
const QUEUE_DB = 'ticketing-queue';

let manifestDbPromise: Promise<IDBPDatabase> | null = null;
let queueDbPromise: Promise<IDBPDatabase> | null = null;

function manifestDb(): Promise<IDBPDatabase> {
  if (!manifestDbPromise) {
    manifestDbPromise = openDB(MANIFEST_DB, 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('manifests')) {
          db.createObjectStore('manifests', { keyPath: 'eventId' });
        }
      },
    });
  }
  return manifestDbPromise;
}

function queueDb(): Promise<IDBPDatabase> {
  if (!queueDbPromise) {
    queueDbPromise = openDB(QUEUE_DB, 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('scans')) {
          const s = db.createObjectStore('scans', { keyPath: 'clientScanId' });
          s.createIndex('synced', 'syncedAt');
        }
      },
    });
  }
  return queueDbPromise;
}

// --- manifest --------------------------------------------------------------

export async function saveManifest(m: CheckinManifest): Promise<void> {
  const db = await manifestDb();
  const tickets: Record<string, ManifestTicket> = {};
  for (const t of m.tickets) tickets[t.id] = t;
  const record: CachedManifest = {
    eventId: m.eventId,
    eventName: m.eventName,
    fetchedAt: Date.now(),
    signingKids: m.signing.kids,
    tickets,
  };
  await db.put('manifests', record);
}

export async function loadManifest(eventId: string): Promise<CachedManifest | null> {
  const db = await manifestDb();
  const m = (await db.get('manifests', eventId)) as CachedManifest | undefined;
  return m ?? null;
}

/** Mark a ticket as locally checked in so a second scan shows 'duplicate'. */
export async function markTicketLocallyCheckedIn(
  eventId: string,
  ticketId: string,
): Promise<void> {
  const db = await manifestDb();
  const m = (await db.get('manifests', eventId)) as CachedManifest | undefined;
  if (!m) return;
  const t = m.tickets[ticketId];
  if (!t) return;
  m.tickets[ticketId] = { ...t, status: 'checked_in' };
  await db.put('manifests', m);
}

// --- pending scans ---------------------------------------------------------

export async function enqueueScan(scan: PendingScan): Promise<void> {
  const db = await queueDb();
  await db.put('scans', scan);
}

export async function listPendingScans(): Promise<PendingScan[]> {
  const db = await queueDb();
  const all = (await db.getAll('scans')) as PendingScan[];
  return all.filter((s) => s.syncedAt === undefined);
}

export async function pendingScanCount(): Promise<number> {
  return (await listPendingScans()).length;
}

export async function markScanSynced(
  clientScanId: string,
  serverOutcome: string,
): Promise<void> {
  const db = await queueDb();
  const scan = (await db.get('scans', clientScanId)) as PendingScan | undefined;
  if (!scan) return;
  scan.syncedAt = Date.now();
  scan.serverOutcome = serverOutcome;
  await db.put('scans', scan);
}

export async function clearSyncedScans(): Promise<void> {
  const db = await queueDb();
  const all = (await db.getAll('scans')) as PendingScan[];
  const tx = db.transaction('scans', 'readwrite');
  for (const s of all) {
    if (s.syncedAt !== undefined) await tx.store.delete(s.clientScanId);
  }
  await tx.done;
}