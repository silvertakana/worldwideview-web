-- Grant table-level privileges for access_codes + user_entitlements.
--
-- 20260703000001 enabled RLS and created policies but never issued GRANTs, so
-- table privileges were missing for every role. service_role bypasses RLS, so
-- PostgREST writes through the service-role client (src/lib/supabase/admin.ts:
-- redeem flow, entitlements reads, markEntitlementUsed, admin CRUD; billing-e2e
-- grantProEntitlement) returned 403 Postgres 42501 "permission denied for table
-- user_entitlements". The same latent failure hit access_codes inserts from the
-- admin UI (src/app/admin/codes/actions.ts:46, user-session client).
--
-- Grants mirror what the 20260703 policies intend:
--   service_role   -> full DML on both tables (server-side, RLS-bypassing)
--   authenticated  -> full DML on both tables, gated by RLS:
--                     users_read_own_entitlements (own-row SELECT),
--                     admins_manage_entitlements / admins_manage_access_codes
--                     (FOR ALL, admin JWT only)
--   anon           -> no grants (no policy targets the anon role)

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_entitlements TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.access_codes TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_entitlements TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.access_codes TO authenticated;
