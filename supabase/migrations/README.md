# Migrations

Run the SQL files in order in the Supabase SQL Editor (Dashboard > SQL Editor) or via `psql`.
Files are named `<timestamp>_<description>.sql`, and "in order" means filename order:

```bash
psql "$SUPABASE_DB_URL" -f supabase/migrations/20260703000001_create_access_codes.sql
```

`20260703000001_create_access_codes.sql` is the oldest file and creates `access_codes` and
`user_entitlements`. Those two tables are no longer part of the customer-facing path - paying
is the way in, see [adr-0009](../../docs/architecture/decisions/adr-0009-payment-only-access.md)
- but they are still live and still read, so do not drop them.

## Setting an admin user

Run this in Supabase SQL Editor (replace the email):

```sql
UPDATE auth.users
SET raw_app_meta_data = jsonb_set(COALESCE(raw_app_meta_data, '{}'), '{role}', '"admin"')
WHERE email = 'your-email@example.com';
```

The change takes effect on the user's next sign-in. The existing session cookie still reflects the old metadata until the user re-authenticates.
