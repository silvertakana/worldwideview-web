-- Durable record of BUSINESS-LOGIC failures that a Stripe retry will not fix.
--
-- `webhook_events` only answers "did we see this event id". When provisioning
-- or the tier-sync call fails for a reason inside our control (no user for the
-- metadata userId, missing price id, globe rejecting the request), the webhook
-- ends up echoing that failure in a response body Stripe keeps retrying — the
-- failure itself is not recorded anywhere, and nothing is left to alert on or
-- replay. This table is that record.
--
-- `stage` is deliberately a small closed set, mirroring the webhook's phases:
-- provision -> globe workspace creation, tier_sync -> pushing the paid tier to
-- the globe. The CHECK lists exactly those two; widening it is a deliberate
-- migration, not an accident.
--
-- One row per unresolved (event_id, stage): the partial unique index below lets
-- recordFailure() upsert onto it so a repeatedly failing stage accumulates
-- `attempts` and a fresh `last_attempt_at` instead of inserting duplicates,
-- while a later re-failure after resolution inserts a new row and keeps the
-- history.
--
-- RLS: service-role only, no user-facing policy at all.
CREATE TABLE IF NOT EXISTS public.billing_failures (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID,
    email TEXT,
    event_id TEXT,
    event_type TEXT,
    stage TEXT NOT NULL,
    error TEXT,
    attempts INT NOT NULL DEFAULT 0,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ,
    CONSTRAINT billing_failures_stage_check CHECK (stage IN ('provision', 'tier_sync'))
);

-- "Show me everything unresolved" is the operator's primary query.
CREATE INDEX IF NOT EXISTS idx_billing_failures_resolved_at
    ON public.billing_failures(resolved_at);

-- The upsert key for recordFailure(). Partial, so resolution frees the key and
-- a later failure of the same stage for the same event starts a new row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_failures_unresolved_event_stage
    ON public.billing_failures(event_id, stage)
    WHERE resolved_at IS NULL;

ALTER TABLE public.billing_failures ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.billing_failures TO service_role;
