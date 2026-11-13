-- F6.3 self-serve billing through Stripe (TEST mode in dev). Prices live in Stripe (prices tagged
-- metadata app=medexregai, kind=plan|credits); MedexRegAI never stores card data, only Stripe ids.

-- A firm's plan and credit balance.
CREATE TABLE IF NOT EXISTS firm_billing (
  org_id               uuid PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  stripe_customer_id   varchar(64),
  plan_key             varchar(64),
  plan_price_id        varchar(64),
  subscription_id      varchar(64),
  -- Stripe subscription status: active | trialing | past_due | canceled | incomplete | unpaid ...
  subscription_status  varchar(24),
  current_period_end   timestamptz,
  credit_balance       integer NOT NULL DEFAULT 0,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT firm_billing_balance_chk CHECK (credit_balance >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS firm_billing_customer_uq ON firm_billing (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

-- Every credit movement; a Stripe payment is credited once (stripe_ref unique).
CREATE TABLE IF NOT EXISTS credit_ledger (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  delta       integer NOT NULL CHECK (delta <> 0),
  -- purchase | usage | adjustment
  reason      varchar(16) NOT NULL,
  stripe_ref  varchar(128),
  note        varchar(300),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_ledger_reason_chk CHECK (reason IN ('purchase', 'usage', 'adjustment'))
);
CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_stripe_ref_uq ON credit_ledger (stripe_ref) WHERE stripe_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS credit_ledger_org_created_idx ON credit_ledger (org_id, created_at DESC, id DESC);

-- Stripe events already handled (Stripe may deliver an event more than once).
CREATE TABLE IF NOT EXISTS stripe_events (
  event_id     varchar(128) PRIMARY KEY,
  type         varchar(64) NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now()
);
