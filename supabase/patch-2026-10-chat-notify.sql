-- Organizer announcements, @mentions, and the organizer's "starting holes" notice. Run after patch-2026-10-push.sql.
-- Safe to run more than once: paste into the Supabase SQL editor and run.
-- Then redeploy the send-push Edge Function with the updated functions/send-push/index.ts.

-- 'announce': an organizer's message that notifies everyone in the event.
-- 'startholes': an organizer's notice that tells each player their starting hole for a round.
alter table messages drop constraint if exists messages_kind_check;
alter table messages add constraint messages_kind_check
  check (kind in ('chat','announce','startholes','final','round','clinch','pairings','ace','eagle','draft'));

drop policy if exists send_chat on messages;
create policy send_chat on messages for insert to authenticated
  with check (
    event_id = my_event() and author_id = auth.uid()
    and (kind = 'chat' or (kind = 'announce' and is_organizer(event_id)))
    and char_length(body) <= 500
    and auto_key is null and auto_sig is null and not corrected and not retracted
  );

drop policy if exists delete_messages on messages;
create policy delete_messages on messages for delete to authenticated
  using (kind in ('chat','announce') and (author_id = auth.uid() or is_organizer(event_id)));

-- Send the starting holes for a round. Organizer only, once every match in the round has a
-- starting hole. Can be sent again after changes (each send is its own post), but not twice
-- within two minutes, so a double tap doesn't notify everyone twice.
create or replace function send_start_holes(p_round uuid)
returns void language plpgsql security definer as $$
declare r rounds%rowtype;
begin
  select * into r from rounds where id = p_round;
  if r.id is null then raise exception 'Round not found'; end if;
  if not is_organizer(r.event_id) then raise exception 'Only an organizer can send starting holes'; end if;
  if not exists (select 1 from matches where round_id = p_round) then raise exception 'This round has no matchups yet'; end if;
  if exists (select 1 from matches where round_id = p_round and start_hole is null) then
    raise exception 'Give every match a starting hole first';
  end if;
  if exists (select 1 from messages where kind = 'startholes' and auto_key like 'startholes:' || p_round || ':%'
             and created_at > now() - interval '2 minutes') then
    raise exception 'Starting holes for this round were just sent';
  end if;
  insert into messages (event_id, author_id, kind, body, auto_key)
  values (r.event_id, auth.uid(), 'startholes',
          chr(9971) || ' ' || r.name || ' starting holes are set. Check the Leaderboard for yours.',   -- chr(9971) is the flag-in-hole emoji
          'startholes:' || p_round || ':' || floor(extract(epoch from now())));
end;
$$;

-- Push announcements, starting holes, and chat messages that might @mention someone (the function works out
-- who, if anyone, was mentioned). Plain chat without an @ never calls the function.
drop trigger if exists notify_push on messages;
create trigger notify_push after insert on messages
  for each row when (
    new.kind in ('final', 'round', 'clinch', 'ace', 'pairings', 'announce', 'startholes')
    or (new.kind = 'chat' and position('@' in new.body) > 0)
  )
  execute function notify_push();
