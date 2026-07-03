-- Fix admin RLS policies to use auth.jwt() instead of querying auth.users
-- The authenticated Postgres role cannot SELECT from auth.users, causing
-- "permission denied for table users" when admin pages query access_codes

DROP POLICY IF EXISTS "admins_manage_access_codes" ON access_codes;
DROP POLICY IF EXISTS "admins_manage_entitlements" ON user_entitlements;

CREATE POLICY "admins_manage_access_codes" ON access_codes
    FOR ALL USING (
        auth.role() = 'authenticated' AND
        (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    );

CREATE POLICY "admins_manage_entitlements" ON user_entitlements
    FOR ALL USING (
        auth.role() = 'authenticated' AND
        (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    );
