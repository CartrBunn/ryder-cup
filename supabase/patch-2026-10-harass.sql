-- "Harass a player": the organizer picks one player, and every hole their side loses is posted
-- to chat and pushed to everyone. Run after patch-2026-10-chat-all.sql.
-- Safe to run more than once: paste into the Supabase SQL editor and run.
-- Then redeploy the send-push Edge Function with the updated functions/send-push/index.ts.

-- The player being harassed (profiles.id), or null for nobody. Set on the Setup page.
alter table events add column if not exists harass_player_id uuid;

-- 'harass': "<name> has lost hole #X" (see src/lib/automations.js).
alter table messages drop constraint if exists messages_kind_check;
alter table messages add constraint messages_kind_check
  check (kind in ('chat','announce','startholes','final','round','clinch','pairings','ace','eagle','draft','projection','harass'));

drop trigger if exists notify_push on messages;
create trigger notify_push after insert on messages
  for each row when (
    new.kind in ('chat', 'final', 'round', 'clinch', 'ace', 'pairings', 'announce', 'startholes', 'projection', 'harass')
  )
  execute function notify_push();
