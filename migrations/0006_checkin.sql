-- migrations/0006_checkin.sql
-- Check-in state, scan audit log, and the offline-verification surface.
--
-- The tickets table grows three columns recording the *winning* scan for each
-- ticket. The scan_attempts table records every attempted scan (accepted or
-- not) as an audit trail and, crucially, as the idempotency fence for offline
-- batch sync: UNIQUE (device_id, client_scan_id) means a retry of the same
-- batch is a database-level no-op.
--
-- The "earliest scannedAt wins" rule is enforced by the check-in UPDATE's
-- WHERE clause; see services/checkin.ts. Arrival order does not matter.

CREATE TYPE checkin_outcome AS ENUM (
  'accepted',
  'duplicate',
  'void',
  'wrong_event',
  'not_found',
  'invalid_token'
);

ALTER TABLE tickets
  ADD COLUMN checked_in_device_id text,
  ADD COLUMN checked_in_gate      text;

CREATE TABLE scan_attempts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Generated client-side. Two scans from the same device with the same
  -- client_scan_id are the *same* scan; the second is a replay. That is what
  -- makes sync idempotent regardless of how many times the client retries.
  client_scan_id  text NOT NULL CHECK (length(client_scan_id) BETWEEN 8 AND 100),
  device_id       text NOT NULL CHECK (length(device_id) BETWEEN 1 AND 200),
  staff_user_id   uuid NOT NULL REFERENCES users(id)  ON DELETE RESTRICT,
  ticket_id       uuid          REFERENCES tickets(id) ON DELETE RESTRICT,
  -- Both event ids are stored so we can diagnose 'wrong_event' scans without
  -- a second lookup after the fact.
  token_event_id  uuid,
  ticket_event_id uuid          REFERENCES events(id) ON DELETE RESTRICT,
  gate            text,
  scanned_at      timestamptz NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  outcome         checkin_outcome NOT NULL,
  reason          text,
  UNIQUE (device_id, client_scan_id)
);
CREATE INDEX scan_attempts_ticket_idx ON scan_attempts (ticket_id, scanned_at DESC);
CREATE INDEX scan_attempts_event_idx  ON scan_attempts (ticket_event_id, scanned_at DESC);
CREATE INDEX scan_attempts_staff_idx  ON scan_attempts (staff_user_id, scanned_at DESC);

-- A compact view for the live stats endpoint. Kept as a view so the query
-- stays in one place and the API layer never hand-rolls the arithmetic.
CREATE VIEW event_checkin_stats AS
SELECT
  e.id AS event_id,
  COUNT(t.id) FILTER (WHERE t.status = 'valid')      AS valid,
  COUNT(t.id) FILTER (WHERE t.status = 'checked_in') AS checked_in,
  COUNT(t.id) FILTER (WHERE t.status = 'void')       AS voided,
  COUNT(t.id)                                        AS total
FROM events e
LEFT JOIN tickets t ON t.event_id = e.id
GROUP BY e.id;