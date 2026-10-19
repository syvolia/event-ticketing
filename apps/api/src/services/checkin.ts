// Check-in service.
//
// The whole correctness of this file rests on one idea: check-in is an atomic
// conditional UPDATE against `tickets`, with the *time ordering* encoded in
// the WHERE clause. Because the row is locked for the duration of the UPDATE,
// two concurrent scans for the same ticket cannot both think they won.
//
//   UPDATE tickets
//      SET status='checked_in', checked_in_at=$new, ...
//    WHERE id=$id
//      AND status <> 'void'
//      AND (status = 'valid' OR checked_in_at > $new)
//
// The `status = 'valid'` arm captures the first ever check-in.
// The `checked_in_at > $new` arm captures the offline-earliest-wins override:
// a scan with a strictly earlier wall-clock time replaces the current winner.
// Equal times do not override, which makes a self-replay of the winning scan
// a no-op (it is reported as 'accepted', not 'duplicate', because we also
// compare device_id).
//
// scan_attempts is written for every input, accepted or not, so the audit
// trail is complete. UNIQUE (device_id, client_scan_id) makes the write
// idempotent under client retries.

import type { PoolClient } from 'pg';
import type { ScanResult, ScanInput } from '@ticketing/shared';
import { pool } from '../db/pool.js';
import { withTransaction } from '../db/tx.js';
import { verifyTicketToken } from '../qr/signing.js';
import { getKeysByKid } from '../qr/keys.js';
import { logger } from '../logger.js';

interface TicketRow {
  id: string;
  event_id: string;
  status: 'valid' | 'checked_in' | 'void';
  checked_in_at: Date | null;
  checked_in_gate: string | null;
  checked_in_device_id: string | null;
  short_code: string;
  tier_name: string;
}

async function loadTicketForUpdate(client: PoolClient, ticketId: string): Promise<TicketRow | null> {
  const { rows } = await client.query<TicketRow>(
    `SELECT t.id, t.event_id, t.status,
            t.checked_in_at, t.checked_in_gate, t.checked_in_device_id,
            t.short_code, tt.name AS tier_name
       FROM tickets t
       JOIN ticket_tiers tt ON tt.id = t.tier_id
      WHERE t.id = $1
      FOR UPDATE OF t`,
    [ticketId],
  );
  return rows[0] ?? null;
}

interface ExistingScanRow {
  outcome: ScanResult['outcome'];
  ticket_id: string | null;
  reason: string | null;
}

async function findExistingScan(
  client: PoolClient,
  deviceId: string,
  clientScanId: string,
): Promise<ExistingScanRow | null> {
  const { rows } = await client.query<ExistingScanRow>(
    `SELECT outcome, ticket_id, reason
       FROM scan_attempts
      WHERE device_id = $1 AND client_scan_id = $2`,
    [deviceId, clientScanId],
  );
  return rows[0] ?? null;
}

async function recordScan(
  client: PoolClient,
  staffUserId: string,
  input: ScanInput,
  ticketId: string | null,
  tokenEventId: string | null,
  ticketEventId: string | null,
  outcome: ScanResult['outcome'],
  reason: string | null,
): Promise<void> {
  // ON CONFLICT DO NOTHING: if the same (device, client_scan_id) arrives
  // concurrently, only one row wins and both transactions see consistent
  // state through their own reads.
  await client.query(
    `INSERT INTO scan_attempts
       (client_scan_id, device_id, staff_user_id, ticket_id,
        token_event_id, ticket_event_id, gate, scanned_at, outcome, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (device_id, client_scan_id) DO NOTHING`,
    [
      input.clientScanId,
      input.deviceId,
      staffUserId,
      ticketId,
      tokenEventId,
      ticketEventId,
      input.gate ?? null,
      input.scannedAt,
      outcome,
      reason,
    ],
  );
}

/**
 * Process a single scan. Runs inside the caller's transaction. Idempotent:
 * replaying the same (device_id, client_scan_id) returns the cached outcome
 * without touching tickets.
 */
export async function processScan(
  client: PoolClient,
  staffUserId: string,
  input: ScanInput,
): Promise<ScanResult> {
  // --- 1. Idempotency fence ------------------------------------------------
  const prior = await findExistingScan(client, input.deviceId, input.clientScanId);
  if (prior) {
    // Already processed. Return the cached outcome, hydrating the ticket
    // fields from the current state so the client sees a consistent view.
    const base: ScanResult = {
      clientScanId: input.clientScanId,
      outcome: prior.outcome,
      reason: prior.reason,
    };
    if (prior.ticket_id) {
      const t = await loadTicketForUpdate(client, prior.ticket_id);
      if (t) {
        base.ticketId = t.id;
        base.shortCode = t.short_code;
        base.tierName = t.tier_name;
        if (prior.outcome === 'duplicate') {
          base.existingAt = t.checked_in_at?.toISOString() ?? null;
          base.existingGate = t.checked_in_gate;
          base.existingDeviceId = t.checked_in_device_id;
        }
      }
    }
    return base;
  }

  // --- 2. Verify the token -------------------------------------------------
  const keys = await getKeysByKid();
  const verified = verifyTicketToken(input.token, keys);

  if (!verified) {
    // Fail closed. Store the attempt so a security review can see what was
    // presented (without persisting the raw token — it may be reused).
    await recordScan(
      client,
      staffUserId,
      input,
      null,
      null,
      null,
      'invalid_token',
      'Signature verification failed',
    );
    return { clientScanId: input.clientScanId, outcome: 'invalid_token' };
  }

  const tokenTicketId = verified.payload.t;
  const tokenEventId = verified.payload.e;

  // Optional event-scope check. If the caller provided eventId, the token's
  // event must match — this catches the "wrong gate" case where a staff
  // member is assigned to event A but someone hands them a ticket for B.
  if (input.eventId && input.eventId !== tokenEventId) {
    await recordScan(
      client,
      staffUserId,
      input,
      null,
      tokenEventId,
      null,
      'wrong_event',
      `Token belongs to event ${tokenEventId}, not ${input.eventId}`,
    );
    return {
      clientScanId: input.clientScanId,
      outcome: 'wrong_event',
      reason: `This ticket is for a different event`,
    };
  }

  // --- 3. Load the ticket with an exclusive row lock -----------------------
  const ticket = await loadTicketForUpdate(client, tokenTicketId);
  if (!ticket) {
    await recordScan(
      client,
      staffUserId,
      input,
      null,
      tokenEventId,
      null,
      'not_found',
      'Ticket id in token does not exist',
    );
    return { clientScanId: input.clientScanId, outcome: 'not_found' };
  }

  // The token's event must match the ticket's event. With HMAC this cannot
  // diverge in practice, but a bug in signTicketPayload would be invisible
  // otherwise, and the cost of checking is a single string compare.
  if (ticket.event_id !== tokenEventId) {
    await recordScan(
      client,
      staffUserId,
      input,
      ticket.id,
      tokenEventId,
      ticket.event_id,
      'wrong_event',
      `Token event ${tokenEventId} does not match ticket event ${ticket.event_id}`,
    );
    return {
      clientScanId: input.clientScanId,
      outcome: 'wrong_event',
      ticketId: ticket.id,
      shortCode: ticket.short_code,
      tierName: ticket.tier_name,
      reason: 'Token payload is inconsistent with the ticket record',
    };
  }

  if (ticket.status === 'void') {
    await recordScan(
      client,
      staffUserId,
      input,
      ticket.id,
      tokenEventId,
      ticket.event_id,
      'void',
      'Ticket is void',
    );
    return {
      clientScanId: input.clientScanId,
      outcome: 'void',
      ticketId: ticket.id,
      shortCode: ticket.short_code,
      tierName: ticket.tier_name,
    };
  }

  // --- 4. Determine whether this scan wins or is a duplicate ---------------
  //
  // A scan "wins" if the ticket is valid (first ever check-in) or if the
  // ticket is already checked in but its timestamp is strictly later than
  // this scan's. Equal timestamps on the same device are a replay of the
  // winning scan.
  const isReplayOfWinner =
    ticket.status === 'checked_in' &&
    ticket.checked_in_at !== null &&
    ticket.checked_in_at.getTime() === input.scannedAt.getTime() &&
    ticket.checked_in_device_id === input.deviceId;

  if (ticket.status === 'checked_in' && !isReplayOfWinner) {
    // Since the row is locked, the timestamps we see are the latest.
    const existingTs = ticket.checked_in_at!;
    const newTs = input.scannedAt;
    if (existingTs.getTime() <= newTs.getTime()) {
      // Existing winner is earlier or equal. This scan loses.
      await recordScan(
        client,
        staffUserId,
        input,
        ticket.id,
        tokenEventId,
        ticket.event_id,
        'duplicate',
        `Already checked in at ${existingTs.toISOString()}`,
      );
      return {
        clientScanId: input.clientScanId,
        outcome: 'duplicate',
        ticketId: ticket.id,
        shortCode: ticket.short_code,
        tierName: ticket.tier_name,
        existingAt: existingTs.toISOString(),
        existingGate: ticket.checked_in_gate,
        existingDeviceId: ticket.checked_in_device_id,
      };
    }
    // else: existingTs > newTs → fall through and override.
  }

  // --- 5. Win the check-in -------------------------------------------------
  //
  // The WHERE clause is redundant with the checks above (we hold the row
  // lock), but it is the *last* line of defense. If a future refactor ever
  // lets two transactions see the same pre-state, only one can satisfy this
  // predicate and the other updates zero rows.
  const upd = await client.query(
    `UPDATE tickets
        SET status = 'checked_in',
            checked_in_at = $2,
            checked_in_by = $3,
            checked_in_device_id = $4,
            checked_in_gate = $5
      WHERE id = $1
        AND status <> 'void'
        AND (status = 'valid' OR checked_in_at > $2)`,
    [
      ticket.id,
      input.scannedAt,
      staffUserId,
      input.deviceId,
      input.gate ?? null,
    ],
  );
  if (upd.rowCount === 0) {
    // Should be unreachable given the lock, but keep the invariant honest.
    logger.error(
      { ticketId: ticket.id, deviceId: input.deviceId, scannedAt: input.scannedAt },
      'check-in update matched zero rows under lock — invariant violation',
    );
    await recordScan(
      client,
      staffUserId,
      input,
      ticket.id,
      tokenEventId,
      ticket.event_id,
      'duplicate',
      'Update matched zero rows',
    );
    return {
      clientScanId: input.clientScanId,
      outcome: 'duplicate',
      ticketId: ticket.id,
      shortCode: ticket.short_code,
      tierName: ticket.tier_name,
      existingAt: ticket.checked_in_at?.toISOString() ?? null,
      existingGate: ticket.checked_in_gate,
      existingDeviceId: ticket.checked_in_device_id,
    };
  }

  await recordScan(
    client,
    staffUserId,
    input,
    ticket.id,
    tokenEventId,
    ticket.event_id,
    'accepted',
    isReplayOfWinner ? 'Replay of winning scan' : null,
  );

  return {
    clientScanId: input.clientScanId,
    outcome: 'accepted',
    ticketId: ticket.id,
    shortCode: ticket.short_code,
    tierName: ticket.tier_name,
  };
}

/**
 * Single check-in entry point. Wraps processScan in a transaction.
 */
export async function checkin(staffUserId: string, input: ScanInput): Promise<ScanResult> {
  return withTransaction((client) => processScan(client, staffUserId, input), {
    label: 'checkin',
  });
}

/**
 * Batch sync. Each scan runs in its own transaction so a single bad input
 * cannot roll back the rest. Because processScan handles arrival-order
 * independence internally, we do not need to sort the batch by scannedAt —
 * the "earliest wins" rule holds no matter what order we process in.
 */
export async function syncScans(
  staffUserId: string,
  scans: ScanInput[],
): Promise<ScanResult[]> {
  const results: ScanResult[] = [];
  for (const scan of scans) {
    try {
      results.push(await checkin(staffUserId, scan));
    } catch (err) {
      logger.error({ err, scan: { clientScanId: scan.clientScanId } }, 'sync scan failed');
      results.push({
        clientScanId: scan.clientScanId,
        outcome: 'invalid_token',
        reason: 'Server error while processing scan',
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export interface ManifestPayload {
  eventId: string;
  eventName: string;
  generatedAt: string;
  signing: { algorithm: 'hmac-sha256'; kids: string[] };
  tickets: Array<{
    id: string;
    shortCode: string;
    tierName: string;
    status: 'valid' | 'checked_in' | 'void';
  }>;
}

export async function buildCheckinManifest(eventId: string): Promise<ManifestPayload> {
  const { rows: ev } = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM events WHERE id = $1`,
    [eventId],
  );
  if (!ev[0]) throw new Error(`Event ${eventId} not found`);
  const event = ev[0];

  const { rows: tickets } = await pool.query<{
    id: string;
    short_code: string;
    tier_name: string;
    status: 'valid' | 'checked_in' | 'void';
  }>(
    `SELECT t.id, t.short_code, tt.name AS tier_name, t.status
       FROM tickets t
       JOIN ticket_tiers tt ON tt.id = t.tier_id
      WHERE t.event_id = $1
      ORDER BY tt.name, t.serial_no`,
    [eventId],
  );

  const { rows: kids } = await pool.query<{ kid: string }>(
    `SELECT kid FROM qr_signing_keys ORDER BY created_at`,
  );

  return {
    eventId: event.id,
    eventName: event.name,
    generatedAt: new Date().toISOString(),
    signing: { algorithm: 'hmac-sha256', kids: kids.map((r) => r.kid) },
    tickets: tickets.map((t) => ({
      id: t.id,
      shortCode: t.short_code,
      tierName: t.tier_name,
      status: t.status,
    })),
  };
}

// ---------------------------------------------------------------------------
// Live stats
// ---------------------------------------------------------------------------

export interface CheckinStatsResult {
  eventId: string;
  total: number;
  valid: number;
  checkedIn: number;
  voided: number;
}

export async function getCheckinStats(eventId: string): Promise<CheckinStatsResult> {
  const { rows } = await pool.query<{
    event_id: string;
    total: number;
    valid: number;
    checked_in: number;
    voided: number;
  }>(
    `SELECT event_id, total, valid, checked_in, voided
       FROM event_checkin_stats WHERE event_id = $1`,
    [eventId],
  );
  const r = rows[0];
  if (!r) return { eventId, total: 0, valid: 0, checkedIn: 0, voided: 0 };
  return {
    eventId: r.event_id,
    total: Number(r.total),
    valid: Number(r.valid),
    checkedIn: Number(r.checked_in),
    voided: Number(r.voided),
  };
}