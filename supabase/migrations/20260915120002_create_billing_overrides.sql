-- Operator tier override with a real audit trail.
--
-- `user_entitlements` records a CODE redemption and carries no author; admin
-- actions elsewhere in the hub leave no durable trace at all. This table is the
-- operator's per-customer override plus the who/why/when that makes it
-- reviewable after the fact.
--
-- `reason` is NOT NULL on purpose: an override without a stated reason is not
-- acceptable, and the database refuses one rather than trusting the caller.
-- `created_by` / `revoked_by` may be NULL only because a service-role job has
-- no auth.uid(); they are written by src/lib/billing/records.ts from the
-- caller's own id, never inferred.
--
-- One ACTIVE override per user: a partial unique index on (user_id) WHERE
-- revoked_at IS NULL, matching 20260705130000_fix_partial_unique_tier.sql.
-- A plain UNIQUE(user_id) is wrong — it would also block the history rows this
-- table exists to keep. Revoking then inserting can still race two concurrent
-- admins, so the index (not application code) is what makes two active rows
-- impossible.
--
-- RLS: service-role only, no user-facing policy at all. An override is an
-- operator artifact, never something a user reads or writes.
CREATE TABLE IF NOT EXISTS public.billing_overrides (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    tier TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ,
    revoked_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_overrides_active_user
    ON public.billing_overrides(user_id)
    WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_billing_overrides_user_id
    ON public.billing_overrides(user_id);

ALTER TABLE public.billing_overrides ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.billing_overrides TO service_role;
