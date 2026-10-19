-- migrations/0005_tickets_qr.sql
-- Ticket issuance output: replace the placeholder qr_token_hash with a real,
-- signed payload; add a human-readable short code; add key identifiers so
-- rotation works; add voided_by for audit.
--
-- Also creates qr_signing_keys: multiple keys can exist, exactly one is active
-- at a time (enforced by a partial unique index). Retired keys stay in the
-- table so previously issued tickets continue to verify.

ALTER TABLE tickets DROP COLUMN qr_token_hash;

ALTER TABLE tickets
  ADD COLUMN short_code  text NOT NULL
    CHECK (short_code ~ '^[A-Z0-9]{4}-[A-Z0-9]{4}$'),
  ADD COLUMN qr_payload  text NOT NULL,
  ADD COLUMN kid         text NOT NULL,
  ADD COLUMN voided_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN mailed_at   timestamptz;

ALTER TABLE tickets ADD CONSTRAINT tickets_short_code_key UNIQUE (short_code);
CREATE INDEX tickets_mailed_pending_idx ON tickets (created_at) WHERE mailed_at IS NULL;

CREATE TABLE qr_signing_keys (
  kid         text PRIMARY KEY,
  algorithm   text NOT NULL DEFAULT 'hmac-sha256'
    CHECK (algorithm IN ('hmac-sha256','ed25519')),
  secret      bytea NOT NULL CHECK (octet_length(secret) >= 32),
  is_active   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  retired_at  timestamptz
);

-- Exactly one active key. Postgres treats `(true)` as a constant expression
-- in a partial unique index, which is the canonical way to enforce
-- "at most one row matches this predicate".
CREATE UNIQUE INDEX qr_signing_keys_one_active
  ON qr_signing_keys ((true))
  WHERE is_active;