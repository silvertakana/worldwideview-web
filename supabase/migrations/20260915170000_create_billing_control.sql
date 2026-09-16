-- The runtime billing kill switch: one global row an operator can flip, plus the
-- audit trail of who flipped it and why.
--
-- WHY A ROW AND NOT AN ENV VAR. `NEXT_PUBLIC_BILLING_ENABLED` is inlined by Next
-- at BUILD time, so turning billing off today costs a rebuild and a redeploy and
-- reaches neither the webhook nor the tier-sync path at all. This row is read at
-- REQUEST time by src/lib/billing/kill-switch.ts, so the switch takes effect in
-- seconds, survives a redeploy, and - unlike a variable set on one container - is
-- one answer shared by every instance. The row is also where the operator's
-- REASON lives, which is what the API hands back to the customer on a 503.
--
-- WHY A SEPARATE EVENTS TABLE. This switch stops revenue for every customer at
-- once. An operator flipping a global money switch with no trace is unreviewable
-- after the fact, so every pause and resume appends a row here (action, reason,
-- actor, when), and the sequence of rows answers "who turned billing off, for how
-- long, and why". Nothing in the app reads this table yet; it exists so the trail
-- is complete from the FIRST flip rather than from the first time someone needs
-- it - the flips you most want to explain are the ones nobody anticipated.
--
-- ONE ROW, EVER. The seed below inserts the single row only when the table is
-- empty, and nothing deletes it, so the table is the global singleton the app
-- reads with `.limit(1)`. A re-run must not crash-loop the deploy job: every
-- statement here is IF NOT EXISTS or guarded, and the guard also means a re-run
-- can never silently resume billing or discard an operator's pause.
--
-- RLS AND GRANTS. Signed-in users may READ the switch state - the pricing and
-- account surfaces need it to show that billing is paused, and the state is a
-- global, non-secret fact. No role may WRITE it: pausing billing is an operator
-- action taken with the service-role key by the admin action, which is also the
-- only writer of the audit rows. `anon` gets no grant on anything (billing is
-- never a public read), and `authenticated` gets nothing on the events table -
-- the who/why/when of a global money switch is operator data, not customer data.
--
-- `paused_by` / `actor_user_id` carry NO foreign key on purpose: the trail has to
-- survive the deletion of the operator's account, and an actor who no longer
-- exists is exactly the case an audit trail is worth keeping.

CREATE TABLE IF NOT EXISTS public.billing_control (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    billing_paused BOOLEAN NOT NULL DEFAULT false,
    reason TEXT,
    paused_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.billing_control_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    action TEXT NOT NULL CHECK (action IN ('pause', 'resume')),
    reason TEXT,
    actor_user_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The audit view reads newest-first. No index on `action`: it has two possible
-- values, only ever grows by an operator action, and a scan of a table this size
-- is the cheaper mistake.
CREATE INDEX IF NOT EXISTS idx_billing_control_events_created_at
    ON public.billing_control_events(created_at);

-- Exactly one row, seeded once: an empty table gets the single not-paused row, a
-- table that already has it is left untouched.
INSERT INTO public.billing_control (billing_paused)
SELECT false
WHERE NOT EXISTS (SELECT 1 FROM public.billing_control);

ALTER TABLE public.billing_control ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.billing_control_events ENABLE ROW LEVEL SECURITY;

-- service_role writes both tables (the admin action) and bypasses RLS, so it
-- needs privileges but no policy. authenticated may only read the switch state.
-- anon gets nothing.
GRANT SELECT ON TABLE public.billing_control TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.billing_control TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.billing_control_events TO service_role;

-- Re-run safe: DROP before CREATE, as in 20260915150000.
DROP POLICY IF EXISTS "authenticated_read_billing_control" ON public.billing_control;

CREATE POLICY "authenticated_read_billing_control" ON public.billing_control
    FOR SELECT
    TO authenticated
    USING (true);

-- billing_control_events gets NO policy, for any role. RLS is enabled and only
-- service_role (which bypasses RLS) holds a grant, so the table is unreachable
-- from a user JWT: here the deny IS the absence of a policy, which is the point.
