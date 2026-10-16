-- Projected round scores every 3 holes. Run after patch-2026-10-chat-notify.sql.
-- Safe to run more than once: paste into the Supabase SQL editor and run.
-- Then redeploy the send-push Edge Function with the updated functions/send-push/index.ts.

-- 'projection': an automated post with a round's score as it stands, made each time every
-- match in the round is through another 3 holes (see src/lib/automations.js).
alter table messages drop constraint if exists messages_kind_check;
alter table messages add constraint messages_kind_check
  check (kind in ('chat','announce','startholes','final','round','clinch','pairings','ace','eagle','draft','projection'));

drop trigger if exists notify_push on messages;
create trigger notify_push after insert on messages
  for each row when (
    new.kind in ('final', 'round', 'clinch', 'ace', 'pairings', 'announce', 'startholes', 'projection')
    or (new.kind = 'chat' and position('@' in new.body) > 0)
  )
  execute function notify_push();
