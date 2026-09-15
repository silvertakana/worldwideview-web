-- Durable billing record: one row per subscription that grants a hub tier.
--
-- Before this table there was NO durable record that "user X paid for plan Y
-- and was granted Z" anywhere in the system. `user_entitlements` is a
-- code-redemption table (no amounts, no Stripe ids, no expiry) and
-- `webhook_events` is a bare idempotency ledger (id, event_id, processed_at).
-- The only Stripe-to-user link lived inside Stripe's own object metadata
-- (metadata['userId']), so subscription state had to be re-derived live from
-- Stripe on every page read (src/lib/billing/tier-fallback.ts) with nothing to
-- reconcile against and nothing to audit.
--
-- `source` is a discriminator:
--   'stripe' -> written by the billing webhook / reconciler from Stripe.
--   'manual' -> written by an operator (support grant, migration, comp).
--
-- MANUAL ROWS ARE LOAD-BEARING AND IMMUTABLE TO AUTOMATION: a reconciler must
-- never update or delete a row whose source = 'manual'. src/lib/billing/records.ts
-- enforces that at the application boundary (upsertSubscriptionFromStripe
-- refuses and reports "manual-protected"); there is deliberately no trigger, so
-- a deliberate operator correction stays possible. Consequence, accepted on
-- purpose: while a manual row stands for an email, Stripe events for that email
-- are reported as protected rather than applied. An operator promoting someone
-- to a real paid subscription clears the manual row first.
--
-- ROW SEMANTICS: one row per CUSTOMER, not per subscription. A customer who
-- cancels and re-subscribes gets the existing row updated to the new
-- stripe_subscription_id. The reconciler's Stripe comparison is then a plain
-- per-email match, and the superseded subscription remains in Stripe (the
-- authority) plus the webhook ledger. Reads and writes both live in
-- src/lib/billing/subscription-store.ts and records.ts and obey this rule.
--
-- CONCURRENCY: this table is written by FOUR web server processes, not one.
-- The Dockerfile runs `pm2-runtime server.js -i 4` (Dockerfile:69), so two
-- deliveries routinely land on different processes with no shared memory
-- between them. A single checkout emits checkout.session.completed and
-- customer.subscription.created within seconds of each other, and a
-- redelivered unfinished event may legitimately be reprocessed, so two
-- upsertSubscriptionFromStripe calls really can interleave: neither finds a row
-- (no stripe_subscription_id yet, no row for the email yet) and both INSERT.
-- Two live rows for one customer, which one-row-per-customer semantics cannot
-- tolerate.
--
-- UNIQUE(email) below is what enforces the semantics. It is NOT in tension with
-- the re-subscribe path: that UPDATE rewrites stripe_subscription_id on the
-- existing row and leaves email untouched, so only a second INSERT of the same
-- email can violate it - exactly the duplicate worth preventing. (email is NOT
-- NULL, so there is no nullable-multiple-NULL complication either.) The losing
-- side of the race is a normal outcome, not an error: src/lib/billing/records.ts
-- catches the 23505 unique violation from the INSERT, re-reads the row by
-- email, and UPDATEs it instead.
--
-- An operator could not construct a failing case for this: within a READ
-- COMMITTED transaction, re-writing a column value the row already holds (as the
-- re-subscribe UPDATE does) cannot violate a unique index, because the same
-- transaction's earlier update already registered that value and no second row
-- enters the picture. What could violate it is the fourth-worker duplicate the
-- index exists to prevent.
--
-- Stripe does not carry the hub's price env vars, so `source` and the payload
-- columns (status, stripe_status, price_id, interval, ...) arrive from the
-- webhook's own mapping. Defaults exist so a Stripe write that only knows the
-- core facts still inserts a row whose later Stripe-driven updates can fill in.
--
-- RLS: a user may SELECT only their own rows. All writes are service-role only
-- (src/lib/supabase/admin.ts), which bypasses RLS.
CREATE TABLE IF NOT EXISTS public.billing_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    email TEXT NOT NULL,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    price_id TEXT,
    plan TEXT,
    interval TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    stripe_status TEXT,
    current_period_end TIMESTAMPTZ,
    trial_ends_at TIMESTAMPTZ,
    cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
    source TEXT NOT NULL DEFAULT 'stripe',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT billing_subscriptions_source_check CHECK (source IN ('stripe', 'manual'))
);

-- Nullable-safe uniqueness: manual rows (and any row that predates a
-- subscription id) may carry no stripe_subscription_id, so the index applies
-- only to rows that have one. Mirrors the partial-index style of
-- 20260705130000_fix_partial_unique_tier.sql.
--
-- A partial index is NOT a usable PostgREST upsert target: an onConflict built
-- from it fails with 42P10 "there is no unique or exclusion constraint matching
-- the ON CONFLICT specification". src/lib/billing/records.ts therefore does an
-- explicit read-then-insert-or-update against this table; keep that in mind
-- before adding .upsert() anywhere.
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_subscriptions_stripe_subscription
    ON public.billing_subscriptions(stripe_subscription_id)
    WHERE stripe_subscription_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_user_id
    ON public.billing_subscriptions(user_id);

-- One row per customer, enforced: UNIQUE(email) is what collapses the
-- four-worker race above onto a single row instead of a duplicate. It doubles as
-- the email lookup index, which is why there is no separate non-unique one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_subscriptions_email_unique
    ON public.billing_subscriptions(email);

ALTER TABLE public.billing_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_subscriptions" ON public.billing_subscriptions
    FOR SELECT USING (user_id = auth.uid());

-- Same omission 20260814000001_grant_user_entitlements_access.sql fixed for
-- user_entitlements: RLS alone leaves table privileges missing, so service-role
-- writes through PostgREST fail with 42501 "permission denied for table".
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.billing_subscriptions TO service_role;
