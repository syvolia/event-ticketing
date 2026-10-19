-- migrations/0001_init.sql
-- All money is stored as BIGINT minor units (KES cents). Currency on every
-- monetary row so a single order cannot mix currencies. Postgres is the source
-- of truth: CHECK constraints are the final fence against oversell / double-issue.

CREATE EXTENSION IF NOT EXISTS citext;

CREATE TYPE event_status     AS ENUM ('draft','published','cancelled');
CREATE TYPE order_status     AS ENUM
  ('pending','awaiting_payment','paid','fulfilled','expired','failed','refunded');
CREATE TYPE ticket_status    AS ENUM ('valid','checked_in','void');
CREATE TYPE payment_provider AS ENUM ('mpesa','stripe');
CREATE TYPE payment_status   AS ENUM ('initiated','pending','succeeded','failed','refunded');

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------
CREATE TABLE organizers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email        citext NOT NULL UNIQUE,
  display_name text   NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER organizers_updated BEFORE UPDATE ON organizers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE buyers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email      citext NOT NULL UNIQUE,
  phone      text CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{6,14}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER buyers_updated BEFORE UPDATE ON buyers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Events & tiers
-- ---------------------------------------------------------------------------
CREATE TABLE events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id uuid NOT NULL REFERENCES organizers(id) ON DELETE RESTRICT,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description  text NOT NULL DEFAULT '',
  venue        text NOT NULL CHECK (length(venue) BETWEEN 1 AND 300),
  starts_at    timestamptz NOT NULL,
  ends_at      timestamptz NOT NULL,
  status       event_status NOT NULL DEFAULT 'draft',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX events_organizer_idx     ON events (organizer_id, starts_at DESC);
CREATE INDEX events_status_starts_idx ON events (status, starts_at);
CREATE TRIGGER events_updated BEFORE UPDATE ON events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE ticket_tiers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  price_minor   bigint NOT NULL CHECK (price_minor >= 0),
  currency      char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  capacity      integer NOT NULL CHECK (capacity > 0),
  per_order_max integer NOT NULL CHECK (per_order_max > 0),
  sold          integer NOT NULL DEFAULT 0 CHECK (sold     >= 0),
  reserved      integer NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  sales_start   timestamptz NOT NULL,
  sales_end     timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (sales_end > sales_start),
  CHECK (per_order_max <= capacity),
  -- The oversell guard. Any UPDATE that would push sold+reserved past
  -- capacity aborts the transaction, running under the row's own lock.
  CHECK (sold + reserved <= capacity),
  UNIQUE (event_id, name)
);
CREATE INDEX ticket_tiers_event_idx ON ticket_tiers (event_id);
CREATE TRIGGER ticket_tiers_updated BEFORE UPDATE ON ticket_tiers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------------
CREATE TABLE orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id        uuid NOT NULL REFERENCES buyers(id) ON DELETE RESTRICT,
  event_id        uuid NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  status          order_status NOT NULL DEFAULT 'pending',
  currency        char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  subtotal_minor  bigint NOT NULL CHECK (subtotal_minor >= 0),
  total_minor     bigint NOT NULL CHECK (total_minor    >= 0),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  expires_at      timestamptz,
  paid_at         timestamptz,
  fulfilled_at    timestamptz,
  failed_reason   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (buyer_id, idempotency_key)
);
CREATE INDEX orders_buyer_idx ON orders (buyer_id, created_at DESC);
CREATE INDEX orders_expiry_idx
  ON orders (expires_at)
  WHERE status IN ('pending','awaiting_payment');
CREATE TRIGGER orders_updated BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE order_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  tier_id           uuid NOT NULL REFERENCES ticket_tiers(id) ON DELETE RESTRICT,
  quantity          integer NOT NULL CHECK (quantity > 0),
  unit_price_minor  bigint NOT NULL CHECK (unit_price_minor >= 0),
  currency          char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  line_total_minor  bigint NOT NULL CHECK (line_total_minor >= 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (line_total_minor = unit_price_minor * quantity),
  UNIQUE (order_id, tier_id)
);
CREATE INDEX order_items_tier_idx ON order_items (tier_id);

-- ---------------------------------------------------------------------------
-- Payments
-- ---------------------------------------------------------------------------
CREATE TABLE payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  provider            payment_provider NOT NULL,
  status              payment_status   NOT NULL DEFAULT 'initiated',
  amount_minor        bigint NOT NULL CHECK (amount_minor >= 0),
  currency            char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  merchant_request_id text,
  provider_ref        text,
  idempotency_key     text NOT NULL,
  raw_request         jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_response        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, provider, idempotency_key)
);
CREATE UNIQUE INDEX payments_provider_merchant_ref_uniq
  ON payments (provider, merchant_request_id)
  WHERE merchant_request_id IS NOT NULL;
CREATE UNIQUE INDEX payments_provider_ref_uniq
  ON payments (provider, provider_ref)
  WHERE provider_ref IS NOT NULL;
CREATE INDEX payments_order_idx ON payments (order_id);
CREATE TRIGGER payments_updated BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Webhook log (idempotency fence for async callbacks)
-- ---------------------------------------------------------------------------
CREATE TABLE webhook_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      payment_provider NOT NULL,
  event_id      text NOT NULL,
  event_type    text NOT NULL,
  payload       jsonb NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  process_error text,
  UNIQUE (provider, event_id)
);
CREATE INDEX webhook_events_unprocessed_idx
  ON webhook_events (received_at)
  WHERE processed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Tickets
-- ---------------------------------------------------------------------------
CREATE TABLE tickets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       uuid NOT NULL REFERENCES orders(id)       ON DELETE RESTRICT,
  order_item_id  uuid NOT NULL REFERENCES order_items(id)  ON DELETE RESTRICT,
  tier_id        uuid NOT NULL REFERENCES ticket_tiers(id) ON DELETE RESTRICT,
  event_id       uuid NOT NULL REFERENCES events(id)       ON DELETE RESTRICT,
  serial_no      integer NOT NULL CHECK (serial_no > 0),
  status         ticket_status NOT NULL DEFAULT 'valid',
  qr_token_hash  text NOT NULL CHECK (length(qr_token_hash) = 64),
  checked_in_at  timestamptz,
  checked_in_by  uuid,
  voided_at      timestamptz,
  voided_reason  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'checked_in' OR checked_in_at IS NOT NULL),
  CHECK (status <> 'void'       OR voided_at     IS NOT NULL),
  UNIQUE (order_item_id, serial_no),
  UNIQUE (qr_token_hash)
);
CREATE INDEX tickets_order_idx ON tickets (order_id);
CREATE INDEX tickets_event_idx ON tickets (event_id);
CREATE INDEX tickets_tier_idx  ON tickets (tier_id);
CREATE TRIGGER tickets_updated BEFORE UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- State machine enforcement
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_order_transition() RETURNS trigger AS $$
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF (OLD.status, NEW.status) IN (
    ('pending','awaiting_payment'),
    ('pending','failed'),
    ('pending','expired'),
    ('awaiting_payment','paid'),
    ('awaiting_payment','failed'),
    ('awaiting_payment','expired'),
    ('paid','fulfilled'),
    ('paid','refunded'),
    ('fulfilled','refunded')
  ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'illegal order transition: % -> %', OLD.status, NEW.status
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER orders_state_machine
  BEFORE UPDATE OF status ON orders
  FOR EACH ROW EXECUTE FUNCTION enforce_order_transition();

CREATE OR REPLACE FUNCTION enforce_ticket_transition() RETURNS trigger AS $$
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF (OLD.status, NEW.status) IN (
    ('valid','checked_in'),
    ('valid','void'),
    ('checked_in','void')
  ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'illegal ticket transition: % -> %', OLD.status, NEW.status
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tickets_state_machine
  BEFORE UPDATE OF status ON tickets
  FOR EACH ROW EXECUTE FUNCTION enforce_ticket_transition();

-- ---------------------------------------------------------------------------
-- Outbox
-- ---------------------------------------------------------------------------
CREATE TABLE outbox_events (
  id             bigserial PRIMARY KEY,
  dedupe_key     text NOT NULL UNIQUE,
  aggregate_type text NOT NULL,
  aggregate_id   uuid NOT NULL,
  event_type     text NOT NULL,
  payload        jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz,
  attempts       integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error     text
);
CREATE INDEX outbox_unpublished_idx
  ON outbox_events (created_at)
  WHERE published_at IS NULL;
