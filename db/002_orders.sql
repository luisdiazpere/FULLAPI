-- One row per Stripe Checkout Session that has been paid at least once. Session
-- ids are already the key the rest of the app uses (src/server.ts), so they are
-- the key here too.
CREATE TABLE orders (
  session_id             text PRIMARY KEY,
  email                  text,
  amount_total           integer,
  currency               char(3),
  payment_status         text NOT NULL DEFAULT 'pending',
  -- unfulfilled -> label_created -> in_transit -> delivered (or failed / returned)
  shipping_status        text NOT NULL DEFAULT 'unfulfilled',
  shipping_address       jsonb,
  shippo_shipment_id     text,
  shippo_transaction_id  text,
  tracking_number        text,
  tracking_url           text,
  carrier                text,
  payment_email_sent_at  timestamptz,
  -- Dedupe guard: a shipping-status email is only sent again once this differs
  -- from the current shipping_status.
  last_shipping_email_status text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- Stripe and Shippo both retry webhook delivery. One row per event id processed
-- makes re-delivery a no-op instead of a second email.
CREATE TABLE processed_webhook_events (
  id          text PRIMARY KEY,
  source      text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
