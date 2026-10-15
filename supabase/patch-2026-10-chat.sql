-- Event chat + automated posts. Patch for an existing database (also in schema.sql).
-- Safe to run more than once: paste into the Supabase SQL editor and run.

-- The event the signed-in user belongs to (null if none).
create or replace function my_event()
returns uuid language sql stable security definer as $$
  select event_id from profiles where id = auth.uid();
$$;

-- One event-wide chat. kind 'chat' is a person's message; every other kind is an automated
-- post, written only through post_auto_message() below. auto_key makes each automated post
-- happen once per event (e.g. 'final:<match id>'); auto_sig is the result it describes, so a
-- score correction that changes the result edits the post (corrected) instead of reposting.
create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  author_id uuid references profiles(id) on delete set null,
  kind text not null default 'chat'
    check (kind in ('chat','final','round','clinch','pairings','ace','eagle','draft')),
  body text not null check (char_length(body) between 1 and 1000),
  auto_key text,
  auto_sig text,
  corrected boolean not null default false,
  retracted boolean not null default false,    -- automated post whose result no longer holds; hidden
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  unique (event_id, auto_key)
);
create index if not exists messages_event_created on messages (event_id, created_at);

alter table messages enable row level security;

drop policy if exists read_messages on messages;
create policy read_messages on messages for select to authenticated
  using (event_id = my_event());

-- People post plain chat as themselves; automated posts only come from the RPC.
drop policy if exists send_chat on messages;
create policy send_chat on messages for insert to authenticated
  with check (
    event_id = my_event() and author_id = auth.uid() and kind = 'chat'
    and char_length(body) <= 500
    and auto_key is null and auto_sig is null and not corrected and not retracted
  );

-- Authors can delete their own messages; organizers can delete any chat message in their
-- event. Automated posts aren't deletable — the automation would only post them again.
drop policy if exists delete_messages on messages;
create policy delete_messages on messages for delete to authenticated
  using (kind = 'chat' and (author_id = auth.uid() or is_organizer(event_id)));

-- A hash of the scoring state of an event: every hole score plus each match's lineup and
-- start hole. src/lib/automations.js builds the same string, so a device can prove it computed
-- a post from current data — a device that missed an update can't post or "correct" with it.
create or replace function event_fingerprint(p_event uuid)
returns text language sql stable security definer as $$
  select encode(sha256(convert_to(coalesce(string_agg(line, E'\n' order by line collate "C"), ''), 'UTF8')), 'hex')
  from (
    select 'm|' || m.id || '|' || coalesce(m.start_hole::text, '') || '|'
           || array_to_string(m.side_a_players, ',') || '|' || array_to_string(m.side_b_players, ',') as line
    from matches m where m.event_id = p_event
    union all
    select 's|' || s.match_id || '|' || s.side || '|' || s.hole || '|' || s.gross
    from hole_scores s join matches m on m.id = s.match_id where m.event_id = p_event
  ) t;
$$;

-- Create, correct or retract one automated post. Any device in the event may call it; the
-- unique auto_key means racing devices produce one post. Returns what happened:
-- 'posted' | 'updated' | 'unchanged' | 'retracted' | 'stale' (fingerprint mismatch; retry).
create or replace function post_auto_message(
  p_event uuid, p_key text, p_kind text, p_body text, p_sig text,
  p_fingerprint text, p_retract boolean default false)
returns text language plpgsql security definer as $$
declare cur messages%rowtype;
begin
  if my_event() is distinct from p_event then raise exception 'Not authorized'; end if;
  if p_kind = 'chat' then raise exception 'Invalid kind'; end if;
  if p_fingerprint is distinct from event_fingerprint(p_event) then return 'stale'; end if;

  select * into cur from messages where event_id = p_event and auto_key = p_key for update;

  if p_retract then
    if cur.id is null or cur.retracted then return 'unchanged'; end if;
    update messages set retracted = true, edited_at = now() where id = cur.id;
    return 'retracted';
  end if;

  if cur.id is null then
    insert into messages (event_id, kind, body, auto_key, auto_sig)
    values (p_event, p_kind, p_body, p_key, p_sig)
    on conflict (event_id, auto_key) do nothing;
    return 'posted';
  end if;
  if cur.auto_sig is not distinct from p_sig and not cur.retracted then return 'unchanged'; end if;
  update messages set body = p_body, auto_sig = p_sig, retracted = false, corrected = true,
    edited_at = now() where id = cur.id;
  return 'updated';
end;
$$;

-- Live chat on every open device.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table messages;
  end if;
end $$;
