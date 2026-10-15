# Supabase setup

1. Create a project at https://supabase.com
2. SQL editor → paste and run `schema.sql`
3. Authentication → Settings → turn off "Confirm email" for a quick event
4. Settings → API → copy the Project URL and anon key into the app's `.env.local`

`schema.sql` is idempotent-ish (uses `create table if not exists` / `create or replace`),
but dropping and re-running policies may error if they already exist — drop them first if so.

## Push notifications

Phones get a notification for match finals, round results, the cup being clinched, aces,
their own "your match is set", organizer announcements (📣 in chat), the organizer's
"Send starting holes" notice (Matchups page), and chat messages that @mention them.
Ordinary chat messages aren't pushed. Each phone opts in on the Chat page; iPhones must add the site to the Home Screen first.

One-time setup:

1. Run `patch-2026-10-chat.sql`, then `patch-2026-10-push.sql`, then
   `patch-2026-10-chat-notify.sql`, in the SQL editor.
   (The push patch has this project's URL in its `notify_push` trigger — change it for another project.)
2. Edge Functions → Deploy a new function → name it **send-push** → paste
   `functions/send-push/index.ts` → deploy. In its settings, turn **Verify JWT off**
   (the trigger calls it without a key; the function only accepts real, fresh, unpushed posts).
3. Edge Functions → Secrets: add `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT`
   from `push-keys.local.txt` (not committed). Then delete that file.
   The public key is also in `src/lib/push.js`; if you ever make new keys, update both, and
   everyone has to turn notifications on again.
