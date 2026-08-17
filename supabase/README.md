# Supabase setup

1. Create a project at https://supabase.com
2. SQL editor → paste and run `schema.sql`
3. Authentication → Settings → turn off "Confirm email" for a quick event
4. Settings → API → copy the Project URL and anon key into the app's `.env.local`

`schema.sql` is idempotent-ish (uses `create table if not exists` / `create or replace`),
but dropping and re-running policies may error if they already exist — drop them first if so.
