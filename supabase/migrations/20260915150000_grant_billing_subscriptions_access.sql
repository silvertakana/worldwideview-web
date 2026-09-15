-- Read access on billing_subscriptions, and a read policy that actually serves
-- the customer it exists for.
--
-- 20260915120001 created the table, enabled RLS and wrote the policy
-- `users_read_own_subscriptions`, but never issued a GRANT to `authenticated`.
-- RLS and table privileges are separate gates and BOTH have to open: a signed-in
-- user's own SELECT fails with 42501 "permission denied for table
-- billing_subscriptions" before the policy is ever consulted.
-- 20260814000001_grant_user_entitlements_access.sql is the same omission for
-- user_entitlements/access_codes; this mirrors it for the new table.
--
-- The policy also has to match on EMAIL, not on user_id alone. `user_id` is
-- nullable on purpose: a marketplace-originated subscriber has no hub user id
-- (the marketplace writes its own Prisma cuid into Stripe metadata, which
-- src/lib/billing/hub-user.ts refuses to store), so a user_id-only predicate
-- hides a paying customer their own subscription - precisely the person the
-- policy exists to serve. Email is the record's real identity (UNIQUE(email)),
-- and lower() is applied to both sides because the two sides come from different
-- systems and the case of an email carries no meaning. That does forgo the index
-- on email; at one row per customer the scan is the cheaper mistake.
--
-- Grants mirror what the policies intend:
--   service_role   -> full DML, already granted by 20260915120001 (server-side
--                     webhook/reconciler writes, RLS-bypassing)
--   authenticated  -> SELECT only, gated by the two policies below. There is no
--                     authenticated write path: every write is service-role
--   anon           -> no grants (no policy targets the anon role)

GRANT SELECT ON TABLE public.billing_subscriptions TO authenticated;

-- Supersedes the user_id-only policy from 20260915120001.
DROP POLICY IF EXISTS "users_read_own_subscriptions" ON public.billing_subscriptions;

CREATE POLICY "users_read_own_subscriptions" ON public.billing_subscriptions
    FOR SELECT
    TO authenticated
    USING (
        user_id = auth.uid()
        OR lower(email) = lower(auth.jwt() ->> 'email')
    );

-- The operator's view of everyone's rows, using the repo's established admin
-- predicate (20260703000002_fix_admin_rls_policies.sql): a JWT app_metadata role
-- of 'admin', set via the auth.users UPDATE documented in this directory's
-- README. No consumer exists yet - app/admin holds only the codes page - so this
-- is the read path the reconciler and its operator surface will need, not one in
-- use today.
CREATE POLICY "admins_read_billing_subscriptions" ON public.billing_subscriptions
    FOR SELECT
    TO authenticated
    USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');
