-- migrations/0004_payments_and_events.sql
-- Payments, payment_events (audit + idempotency), refunds, and the updated
-- order state machine that recognizes the re-claim / refund-pending paths.
--
-- The payments table already exists from 0001 with the shape we need; we add
-- only the columns specific to M-Pesa STK and Stripe PaymentIntents. The
-- unique indexes on (provider, provider_ref) and (provider, merchant_request_id)
-- from 0001 are the fences that make callbacks idempotent.
--
-- payment_events replaces webhook_events. Same role (idempotency fence for
-- async callbacks) plus a permanent audit trail. payment_id is nullable so a
-- callback that arrives before the pay endpoint has written its provider_ref
-- can be stored as an orphan and bound later.

ALTER TABLE payments
  ADD COLUMN phone          text CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{6,14}$'),
  ADD COLUMN client_secret  text,
  ADD COLUMN failure_code   text,
  ADD COLUMN failure_reason text,
  ADD COLUMN succeeded_at   timestamptz;

CREATE INDEX payments_status_created_idx
  ON payments (status, created_at)
  WHERE status IN ('initiated','pending');

CREATE TABLE payment_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Nullable: an orphan event is one that arrived before the payment row had
  -- a provider_ref stored. The reconciler binds it once the ref exists.
  payment_id         uuid REFERENCES payments(id) ON DELETE SET NULL,
  provider           payment_provider NOT NULL,
  -- Dedup key. M-Pesa: CheckoutRequestID (one callback per STK push).
  -- Stripe: event.id (evt_xxx) — stable across redeliveries.
  provider_event_id  text NOT NULL,
  event_type         text NOT NULL,
  payload            jsonb NOT NULL,
  received_at        timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz,
  process_error      text,
  -- This UNIQUE is what makes "same callback delivered 5 times = one state
  -- change" true. The insert is the first thing the webhook handler does; a
  -- conflict means we have already recorded this exact event and can return
  -- 200 without touching any other table.
  UNIQUE (provider, provider_event_id)
);

CREATE INDEX payment_events_unprocessed_idx
  ON payment_events (received_at)
  WHERE processed_at IS NULL;

CREATE INDEX payment_events_orphan_idx
  ON payment_events (provider, provider_event_id)
  WHERE payment_id IS NULL AND processed_at IS NULL;

-- Refunds. Written when a success callback arrives for an order whose
-- reservation already expired and whose inventory could not be re-claimed.
-- The actual provider-side refund is out of scope for this step; the row is
-- the durable record that a refund is owed, and a later job drives it.
CREATE TABLE refunds (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  payment_id    uuid NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  amount_minor  bigint NOT NULL CHECK (amount_minor >= 0),
  currency      char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reason        text NOT NULL,
  status        text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','completed','failed')),
  provider_ref  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- One refund per payment. A duplicate refund request loses here.
  UNIQUE (payment_id)
);
CREATE INDEX refunds_pending_idx ON refunds (created_at) WHERE status = 'pending';
CREATE TRIGGER refunds_updated BEFORE UPDATE ON refunds
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Order state machine v2
-- ---------------------------------------------------------------------------
-- New transitions added relative to 0001:
--   awaiting_payment → refund_pending  (success callback, order not yet expired,
--                                       but a concurrent cancel made the event
--                                       unpurchasable — rare, still recorded)
--   expired          → paid            (success callback after the sweeper ran,
--                                       inventory re-claimed successfully)
--   expired          → refund_pending  (success callback after the sweeper ran,
--                                       inventory could not be re-claimed)
--   paid             → refund_pending  (operator-initiated refund flow)
--   refund_pending   → refunded
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
    ('awaiting_payment','refund_pending'),
    ('paid','fulfilled'),
    ('paid','refunded'),
    ('paid','refund_pending'),
    ('fulfilled','refunded'),
    ('expired','paid'),
    ('expired','refund_pending'),
    ('refund_pending','refunded')
  ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'illegal order transition: % -> %', OLD.status, NEW.status
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;