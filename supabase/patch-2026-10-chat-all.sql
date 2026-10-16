-- Push every chat message, not just ones with an @mention. Run after patch-2026-10-reactions.sql.
-- Safe to run more than once: paste into the Supabase SQL editor and run.
-- Then redeploy the send-push Edge Function with the updated functions/send-push/index.ts.

drop trigger if exists notify_push on messages;
create trigger notify_push after insert on messages
  for each row when (
    new.kind in ('chat', 'final', 'round', 'clinch', 'ace', 'pairings', 'announce', 'startholes', 'projection')
  )
  execute function notify_push();
