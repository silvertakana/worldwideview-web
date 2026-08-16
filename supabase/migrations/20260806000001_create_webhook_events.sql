-- Idempotency ledger for Stripe webhook events (PMT-008).
--
-- The billing webhook claims an event_id here before processing. The UNIQUE
-- constraint on event_id makes duplicate deliveries (Stripe network retries,
-- dashboard replays) a no-op: ON CONFLICT DO NOTHING means exactly one claim
-- wins and every later claim returns no row, which the handler treats as a
-- duplicate and skips.
--
-- Only the service-role client (src/lib/supabase/admin.ts) writes this table.
-- RLS is enabled with no policies so neither the anon nor the authenticated
-- role can read or write it through PostgREST.
CREATE TABLE IF NOT EXISTS webhook_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id TEXT UNIQUE NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
