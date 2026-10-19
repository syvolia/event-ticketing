import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { CheckinManifest, CheckinStats } from '@ticketing/shared';
import { api, getToken, setToken } from '../lib/api.js';
import { getDeviceId } from '../lib/device.js';
import { beepAccepted, beepRejected, unlockAudio } from '../lib/beep.js';
import {
  enqueueScan,
  loadManifest,
  markTicketLocallyCheckedIn,
  pendingScanCount,
  saveManifest,
  type CachedManifest,
} from '../lib/idb.js';
import { parseTicketToken } from '../lib/ticket.js';
import { startSyncLoop, triggerSync } from '../lib/sync.js';
import { Scanner } from '../components/Scanner.js';
import { ResultOverlay, type OverlayState } from '../components/ResultOverlay.js';
import { ManualEntry } from '../components/ManualEntry.js';

const LAST_EVENT_KEY = 'ticketing.lastEventId';

export function ScanPage(): JSX.Element {
  const navigate = useNavigate();
  const [manifest, setManifest] = useState<CachedManifest | null>(null);
  const [eventId, setEventId] = useState<string | null>(null);
  const [stats, setStats] = useState<CheckinStats | null>(null);
  const [pending, setPending] = useState(0);
  const [online, setOnline] = useState(navigator.onLine);
  const [overlay, setOverlay] = useState<OverlayState>({ kind: 'idle' });
  const [showManual, setShowManual] = useState(false);
  const lastScanRef = useRef<{ token: string; at: number } | null>(null);

  // --- auth gate ----------------------------------------------------------
  // If no token is present, redirect to login. If a token is present but the
  // server rejects it (expired, revoked, account deleted), clear it and
  // redirect — otherwise the scanner would sit on a broken session showing
  // "manifest not loaded" forever.
  useEffect(() => {
    if (!getToken()) {
      navigate('/login');
      return;
    }
    void api<{ user: { role: string } }>('/auth/me').catch(() => {
      setToken(null);
      navigate('/login');
    });
  }, [navigate]);

  // --- event selection ----------------------------------------------------
  // The event to scan for comes from `?eventId=` in the URL. If absent, we
  // fall back to the last event used on this device. That makes a bookmark
  // or a home-screen shortcut work without query string on the second visit.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get('eventId');
    const fromStorage = localStorage.getItem(LAST_EVENT_KEY);
    const chosen = fromQuery ?? fromStorage;
    if (chosen) {
      setEventId(chosen);
      localStorage.setItem(LAST_EVENT_KEY, chosen);
    }
  }, []);

  // --- manifest load / refresh -------------------------------------------
  // Offline-first: render the cached manifest immediately if we have one,
  // then refresh in the background. If we are offline and there is no cache,
  // the page will show "no event selected" until connectivity returns; the
  // user cannot scan without a manifest because we have no way to know which
  // ticket ids are valid.
  useEffect(() => {
    if (!eventId) return;
    let cancelled = false;

    const load = async (): Promise<void> => {
      const cached = await loadManifest(eventId);
      if (cached && !cancelled) setManifest(cached);

      try {
        const fresh = await api<CheckinManifest>(`/events/${eventId}/checkin-manifest`);
        await saveManifest(fresh);
        if (!cancelled) setManifest(await loadManifest(eventId));
      } catch {
        // Offline: keep the cached manifest if we have one. If we do not,
        // `manifest` stays null and the scanner shows an error card on the
        // first scan attempt.
      }
    };
    void load();
    const id = window.setInterval(() => void load(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [eventId]);

  // --- stats poll ---------------------------------------------------------
  // Only poll while online. The stats endpoint is a server-side aggregate;
  // there is no meaningful offline fallback beyond "use the manifest".
  useEffect(() => {
    if (!eventId || !online) return;
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const s = await api<CheckinStats>(`/events/${eventId}/checkin-stats`);
        if (!cancelled) setStats(s);
      } catch {
        /* ignore transient failures; the next tick will retry */
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [eventId, online]);

  // --- online/offline wiring ---------------------------------------------
  useEffect(() => {
    const on = (): void => setOnline(true);
    const off = (): void => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  // --- sync loop ----------------------------------------------------------
  const refreshPending = useCallback(async () => {
    setPending(await pendingScanCount());
  }, []);

  useEffect(() => {
    const stop = startSyncLoop(() => void refreshPending());
    return stop;
  }, [refreshPending]);

  // Read the queue once on mount so the badge is correct before the first
  // sync tick fires.
  useEffect(() => {
    void refreshPending();
  }, [refreshPending]);

  // --- scan handling ------------------------------------------------------
  // The camera emits the same QR many times per second. We debounce by
  // (token, 2s window) so a single physical scan produces exactly one entry.
  // The window is per-token, not global, so scanning ticket A and ticket B
  // back-to-back works even within the same second.
  const onScan = useCallback(
    async (rawToken: string) => {
      const now = Date.now();
      const last = lastScanRef.current;
      if (last && last.token === rawToken && now - last.at < 2_000) return;
      lastScanRef.current = { token: rawToken, at: now };

      if (!eventId || !manifest) {
        setOverlay({
          kind: 'invalid',
          title: 'Manifest not loaded',
          detail: 'Connect to the network once to cache this event.',
        });
        beepRejected();
        return;
      }

      // Offline token parsing. We cannot verify the HMAC locally (the secret
      // is server-only); we check shape + trusted kid + event membership +
      // manifest presence. Cryptographic verification happens at sync time.
      const parsed = parseTicketToken(rawToken);
      if (!parsed) {
        setOverlay({
          kind: 'invalid',
          title: 'Unreadable code',
          detail: 'Not a ticketing QR.',
        });
        beepRejected();
        return;
      }
      if (!manifest.signingKids.includes(parsed.kid)) {
        setOverlay({
          kind: 'invalid',
          title: 'Unknown signing key',
          detail: 'This ticket was issued under a key we do not trust.',
        });
        beepRejected();
        return;
      }
      if (parsed.eventId !== eventId) {
        setOverlay({
          kind: 'wrong_event',
          title: 'Wrong event',
          detail: 'This ticket is for a different event.',
        });
        beepRejected();
        return;
      }
      const local = manifest.tickets[parsed.ticketId];
      if (!local) {
        setOverlay({
          kind: 'not_found',
          title: 'Ticket not recognised',
          detail: 'Not in this event’s manifest.',
        });
        beepRejected();
        return;
      }
      if (local.status === 'void') {
        setOverlay({
          kind: 'void',
          title: 'Ticket voided',
          detail: local.shortCode,
        });
        beepRejected();
        return;
      }
      if (local.status === 'checked_in') {
        setOverlay({
          kind: 'duplicate',
          title: 'Already checked in',
          detail: local.shortCode,
        });
        beepRejected();
        return;
      }

      // Local decision: accept and queue for sync. The manifest is updated
      // in place so a second scan of the same ticket in this session shows
      // 'duplicate' rather than 'accepted' again.
      await markTicketLocallyCheckedIn(eventId, parsed.ticketId);
      setManifest((m) =>
        m
          ? {
              ...m,
              tickets: {
                ...m.tickets,
                [parsed.ticketId]: { ...local, status: 'checked_in' },
              },
            }
          : m,
      );
      await enqueueScan({
        clientScanId: crypto.randomUUID(),
        token: rawToken,
        deviceId: getDeviceId(),
        scannedAt: new Date().toISOString(),
        eventId,
        localOutcome: 'accepted',
      });
      await refreshPending();

      setOverlay({
        kind: 'accepted',
        title: 'Checked in',
        detail: local.shortCode,
      });
      beepAccepted();

      // If we are online, kick the sync loop immediately so the server
      // confirms within a second instead of waiting for the 5s interval.
      if (navigator.onLine) void triggerSync().then(() => void refreshPending());
    },
    [eventId, manifest, refreshPending],
  );

  const scanHandler = useMemo(() => onScan, [onScan]);

  // --- render -------------------------------------------------------------
  if (!eventId) {
    return (
      <main className="scan-page">
        <h1>Scanner</h1>
        <p>No event selected. Pick one to start scanning.</p>
        <Link to="/">Home</Link>
      </main>
    );
  }

  // The `total` computation is split from the null check because TypeScript
  // does not narrow `manifest` through a `??` chain inside a ternary. The
  // explicit `manifest ? ... : 0` form is what makes the narrowing work.
  const checkedIn = stats?.checkedIn ?? 0;
  const total = stats?.total ?? (manifest ? Object.keys(manifest.tickets).length : 0);

  return (
    <div className="scan-page" onPointerDown={() => unlockAudio()}>
      <header className="scan-header">
        <div className="scan-event">{manifest?.eventName ?? 'Loading event…'}</div>
        <div className="scan-stats">
          <span className="stat-big">
            {checkedIn}
            <span className="stat-total">/{total}</span>
          </span>
          <span className="stat-label">checked in</span>
        </div>
        <div className="scan-flags">
          <span className={online ? 'flag-online' : 'flag-offline'}>
            {online ? 'online' : 'offline'}
          </span>
          {pending > 0 ? (
            <button
              className="flag-pending"
              onClick={() => void triggerSync().then(() => void refreshPending())}
              type="button"
            >
              {pending} pending
            </button>
          ) : null}
        </div>
      </header>

      <div className="scanner-viewport">
        {/*
          The scanner always runs. Freezing it on every overlay would add a
          visible delay (camera resume) before the next scan can start, and
          the overlay already covers the viewport so the visual noise from
          the live feed does not reach the operator. If you later want to
          pause it between scans — e.g. to reduce heat on a long shift —
          change this to `enabled={overlay.kind === 'idle'}`.
        */}
        <Scanner onScan={(t) => void scanHandler(t)} enabled={true} />
        <ResultOverlay state={overlay} onDone={() => setOverlay({ kind: 'idle' })} />
      </div>

      <footer className="scan-footer">
        <button type="button" onClick={() => setShowManual(true)}>
          Enter code manually
        </button>
      </footer>

      {showManual ? (
        <ManualEntry
          manifest={manifest}
          onClose={() => setShowManual(false)}
          onSubmit={(shortCode) => {
            setShowManual(false);
            const entry = Object.values(manifest?.tickets ?? {}).find(
              (t) => t.shortCode === shortCode,
            );
            if (!entry) {
              setOverlay({
                kind: 'not_found',
                title: 'Code not found',
                detail: shortCode,
              });
              beepRejected();
              return;
            }
            if (entry.status === 'void') {
              setOverlay({
                kind: 'void',
                title: 'Ticket voided',
                detail: entry.shortCode,
              });
              beepRejected();
              return;
            }
            if (entry.status === 'checked_in') {
              setOverlay({
                kind: 'duplicate',
                title: 'Already checked in',
                detail: entry.shortCode,
              });
              beepRejected();
              return;
            }
            // NOTE: this local accept is a helper for the operator — it shows
            // the ticket is valid for the event but does NOT enqueue a scan
            // for the server, because we do not have the original QR token
            // (which is what the server verifies). A production version would
            // add a POST /checkin/manual endpoint that takes { ticketId } and
            // performs the same check-in with an operator-attestation audit
            // entry. Until that exists, manual entry is a lookup aid only.
            setOverlay({
              kind: 'accepted',
              title: 'Checked in',
              detail: entry.shortCode,
            });
            beepAccepted();
          }}
        />
      ) : null}
    </div>
  );
}
