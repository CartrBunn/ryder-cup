-- Ryder Cup — Supabase schema
-- Run this in the Supabase SQL editor (or via the CLI) on a fresh project.
-- RLS policies here are a sensible baseline; review them before a public event.

-- ---------- tables ----------

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  join_code text not null,
  singles_pct int not null default 100,
  altshot_pct int not null default 50,
  scramble_low_pct int not null default 35,
  scramble_high_pct int not null default 15,
  locked boolean not null default false,        -- true once teams/matchups are set
  draft_first_team_id uuid,                      -- coin-toss winner who picks first in the draft (teams.id)
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
-- For existing databases from before the coin toss was persisted (safe to re-run).
-- Plain uuid, no FK: events is created before teams, so a cross-table FK here is awkward.
alter table events add column if not exists draft_first_team_id uuid;
-- The player the organizer is harassing: every hole they lose is posted (patch-2026-10-harass.sql).
alter table events add column if not exists harass_player_id uuid;
-- 'match' (win holes) or 'stroke' (lowest net total over the round) (patch-2026-10-scoring.sql).
alter table events add column if not exists scoring_mode text not null default 'match'
  check (scoring_mode in ('match','stroke'));

create table if not exists courses (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  name text not null,
  holes jsonb not null                          -- [{ "number":1, "par":4, "strokeIndex":7 }, ...]
);

create table if not exists teams (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  name text not null,
  color text not null default '#1E3A5F',
  captain_id uuid                                -- profiles.id of the captain
);

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  event_id uuid references events(id) on delete cascade,
  display_name text not null,
  handicap numeric not null default 0,
  role text not null default 'player',           -- 'organizer' | 'captain' | 'player'
  team_id uuid references teams(id),
  created_at timestamptz not null default now()
);

create table if not exists rounds (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  seq int not null,                              -- 1,2,3
  name text not null,                            -- 'Scramble', 'Alternate Shot', 'Singles'
  format text not null,                          -- 'scramble' | 'alternate_shot' | 'singles'
  course_id uuid references courses(id),
  first_team_id uuid references teams(id),       -- per-round coin-toss winner who picks first
  pending_pick jsonb                             -- in-progress lock-in {team_id, players[]}; null when idle
);
-- For existing databases from before the per-round coin toss (safe to re-run).
alter table rounds add column if not exists first_team_id uuid references teams(id);
-- In-progress matchup pick, persisted so the responder's device and late joiners see it
-- live via realtime (rounds is already published). Cleared when the match is confirmed.
alter table rounds add column if not exists pending_pick jsonb;

create table if not exists matches (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references rounds(id) on delete cascade,
  event_id uuid not null references events(id) on delete cascade,
  seq int not null,
  side_a_players uuid[] not null default '{}',   -- profiles.id[]  (1 for singles, 2 for team formats)
  side_b_players uuid[] not null default '{}',
  status_text text,                              -- e.g. "A 2 up thru 7"  (denormalized for quick reads)
  final text,                                    -- 'A' | 'B' | 'half' | null
  submitted boolean not null default false,
  start_hole int                                 -- shotgun start hole; null = start at hole 1 (normal)
);
-- For existing databases from before the shotgun start (safe to re-run).
alter table matches add column if not exists start_hole int;
-- Concession / agreed halve recorded by hand: 'A' | 'B' | 'half'; null = decided by the scores.
alter table matches add column if not exists result_override text
  check (result_override in ('A','B','half'));

create table if not exists hole_scores (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references matches(id) on delete cascade,
  side text not null check (side in ('A','B')),
  hole int not null,
  gross int not null,
  entered_by uuid references profiles(id),
  updated_at timestamptz not null default now(),
  unique (match_id, side, hole)
);

-- ---------- helpers ----------

-- Is the current user an organizer of this event?
create or replace function is_organizer(evt uuid)
returns boolean language sql stable security definer as $$
  select exists (
    select 1 from profiles p
    where p.id = auth.uid() and p.event_id = evt and p.role = 'organizer'
  );
$$;

-- Is the current user an organizer OR a captain of this event?
create or replace function is_event_admin(evt uuid)
returns boolean language sql stable security definer as $$
  select exists (
    select 1 from profiles p
    where p.id = auth.uid() and p.event_id = evt and p.role in ('organizer','captain')
  );
$$;

-- Join an event: validates the code, creates/updates the caller's profile.
create or replace function redeem_join_code(p_code text, p_name text, p_handicap numeric)
returns uuid language plpgsql security definer as $$
declare v_event uuid;
begin
  select id into v_event from events where lower(trim(join_code)) = lower(trim(p_code)) limit 1;
  if v_event is null then raise exception 'Invalid join code'; end if;

  -- Names are the login identity within an event, so they must be unique there.
  if exists (
    select 1 from profiles
    where event_id = v_event and lower(display_name) = lower(p_name) and id <> auth.uid()
  ) then
    raise exception 'That name is already taken in this event — add a last initial.';
  end if;

  insert into profiles (id, event_id, display_name, handicap, role)
  values (auth.uid(), v_event, p_name, p_handicap, 'player')
  on conflict (id) do update
    set display_name = excluded.display_name,
        handicap = excluded.handicap,
        event_id = excluded.event_id;

  return v_event;
end;
$$;

-- ---------- row level security ----------

alter table events       enable row level security;
alter table courses      enable row level security;
alter table teams        enable row level security;
alter table profiles     enable row level security;
alter table rounds       enable row level security;
alter table matches      enable row level security;
alter table hole_scores  enable row level security;

-- Everyone signed in can read the event data (leaderboard, draft pool, matchups).
create policy read_events   on events      for select to authenticated using (true);
create policy read_courses  on courses     for select to authenticated using (true);
create policy read_teams    on teams       for select to authenticated using (true);
create policy read_profiles on profiles    for select to authenticated using (true);
create policy read_rounds   on rounds      for select to authenticated using (true);
create policy read_matches  on matches     for select to authenticated using (true);
create policy read_scores   on hole_scores for select to authenticated using (true);

-- Players manage their own profile basics; nobody escalates their own role via the table.
create policy update_own_profile on profiles for update to authenticated
  using (id = auth.uid());

-- Organizers can update any profile in their own event (e.g. editing a player's handicap).
create policy organizer_update_profiles on profiles for update to authenticated
  using (is_organizer(event_id));

-- Organizer/captain manage structure.
create policy admin_write_events  on events   for all to authenticated
  using (is_organizer(id)) with check (is_organizer(id));
create policy admin_write_courses on courses  for all to authenticated
  using (is_organizer(event_id)) with check (is_organizer(event_id));
create policy admin_write_teams   on teams    for all to authenticated
  using (is_event_admin(event_id)) with check (is_event_admin(event_id));
create policy admin_write_rounds  on rounds   for all to authenticated
  using (is_event_admin(event_id)) with check (is_event_admin(event_id));
create policy admin_write_matches on matches  for all to authenticated
  using (is_event_admin(event_id)) with check (is_event_admin(event_id));

-- Organizers assign players to any team in their event; captains only to the team they captain.
-- (Un-assigning/removing a player goes through the guarded undo_pick/remove_player RPCs below,
-- not this policy, so a captain can't null out team_id directly and skip the matchup check.)
create policy captain_assign_team on profiles for update to authenticated
  using (is_event_admin(event_id))
  with check (
    is_organizer(event_id)
    or team_id in (select id from teams where captain_id = auth.uid())
  );

-- The update policies above say who may touch a profile row, not which columns. Guard the
-- sensitive ones for direct API writes: only an organizer may change a role or event, and
-- only a captain/organizer may change a team. The security-definer RPCs run as their owner,
-- not 'authenticated', and do their own checks, so they pass through.
create or replace function guard_profile_update()
returns trigger language plpgsql as $$
begin
  if current_user <> 'authenticated' then return new; end if;
  if (new.role is distinct from old.role or new.event_id is distinct from old.event_id)
     and not is_organizer(old.event_id) then
    raise exception 'Only an organizer can change roles';
  end if;
  if new.team_id is distinct from old.team_id and not is_event_admin(old.event_id) then
    raise exception 'Only a captain or organizer can change teams';
  end if;
  return new;
end;
$$;
drop trigger if exists guard_profile_update on profiles;
create trigger guard_profile_update before update on profiles
  for each row execute function guard_profile_update();

-- Score entry: any player listed on the match may write that match's scores; captains/organizer too.
create policy write_scores on hole_scores for all to authenticated
  using (
    exists (
      select 1 from matches m
      where m.id = hole_scores.match_id
        and ( is_event_admin(m.event_id)
              or auth.uid() = any(m.side_a_players)
              or auth.uid() = any(m.side_b_players) )
    )
  )
  with check (
    exists (
      select 1 from matches m
      where m.id = hole_scores.match_id
        and ( is_event_admin(m.event_id)
              or auth.uid() = any(m.side_a_players)
              or auth.uid() = any(m.side_b_players) )
    )
  );

-- Bootstrap: create an event and make the caller its organizer (no join code needed).
create or replace function create_event(p_name text, p_join_code text, p_organizer_name text)
returns uuid language plpgsql security definer as $$
declare v_event uuid;
begin
  insert into events (name, join_code, created_by)
  values (p_name, p_join_code, auth.uid())
  returning id into v_event;

  insert into profiles (id, event_id, display_name, handicap, role)
  values (auth.uid(), v_event, p_organizer_name, 0, 'organizer')
  on conflict (id) do update
    set event_id = excluded.event_id, role = 'organizer', display_name = excluded.display_name;

  return v_event;
end;
$$;

-- Raise if a player is already referenced by a matchup, so undoing/removing them can't
-- silently desync matches.side_a_players / side_b_players.
create or replace function assert_player_not_matched(p_player_id uuid, p_event uuid)
returns void language plpgsql stable as $$
begin
  if exists (
    select 1 from matches m
    where m.event_id = p_event
      and (p_player_id = any(m.side_a_players) or p_player_id = any(m.side_b_players))
  ) then
    raise exception 'Player is already in a matchup — remove them from matchups first';
  end if;
end;
$$;

-- Undo a draft pick: send a drafted player back to the pool.
create or replace function undo_pick(p_player_id uuid)
returns void language plpgsql security definer as $$
declare v_event uuid;
begin
  select event_id into v_event from profiles where id = p_player_id;
  if v_event is null then raise exception 'Player not found'; end if;
  if not is_event_admin(v_event) then raise exception 'Not authorized'; end if;

  perform assert_player_not_matched(p_player_id, v_event);

  update profiles set team_id = null where id = p_player_id;
end;
$$;

-- Remove a player from the event entirely (mis-signup, duplicate join, etc).
-- Leaves their auth.users account intact; they can rejoin later with the join code.
create or replace function remove_player(p_player_id uuid)
returns void language plpgsql security definer as $$
declare v_event uuid;
begin
  select event_id into v_event from profiles where id = p_player_id;
  if v_event is null then raise exception 'Player not found'; end if;
  if not is_event_admin(v_event) then raise exception 'Not authorized'; end if;

  perform assert_player_not_matched(p_player_id, v_event);

  update teams set captain_id = null where captain_id = p_player_id;
  delete from profiles where id = p_player_id;
end;
$$;

-- Swap a player out for a substitute who has no team yet (e.g. someone dropped out).
-- The substitute takes over the outgoing player's team, captaincy, and every matchup slot
-- (including an in-progress pick), so the schedule and any entered scores stay intact.
-- The outgoing player is left in the event with no team; remove them separately if wanted.
-- Organizer only.
create or replace function swap_player(p_out uuid, p_in uuid)
returns void language plpgsql security definer as $$
declare
  v_event uuid;
  v_in_event uuid;
  v_team uuid;
  v_role text;
begin
  select event_id, team_id, role into v_event, v_team, v_role from profiles where id = p_out;
  select event_id into v_in_event from profiles where id = p_in;
  if v_event is null or v_in_event is null then raise exception 'Player not found'; end if;
  if v_event <> v_in_event then raise exception 'Players are in different events'; end if;
  if not is_organizer(v_event) then raise exception 'Not authorized'; end if;
  if p_out = p_in then raise exception 'Pick a different player'; end if;
  if exists (select 1 from profiles where id = p_in and team_id is not null) then
    raise exception 'Substitute is already on a team';
  end if;

  update matches set
    side_a_players = array_replace(side_a_players, p_out, p_in),
    side_b_players = array_replace(side_b_players, p_out, p_in)
  where event_id = v_event
    and (p_out = any(side_a_players) or p_out = any(side_b_players));

  update rounds set pending_pick = jsonb_set(
    pending_pick, '{players}',
    (select coalesce(jsonb_agg(case when e #>> '{}' = p_out::text then to_jsonb(p_in::text) else e end), '[]'::jsonb)
       from jsonb_array_elements(pending_pick->'players') e)
  )
  where event_id = v_event
    and pending_pick is not null and jsonb_typeof(pending_pick->'players') = 'array';

  update hole_scores set entered_by = p_in where entered_by = p_out;

  update profiles set team_id = v_team where id = p_in;
  if v_role = 'captain' then
    update teams set captain_id = p_in where captain_id = p_out;
    update profiles set role = 'captain' where id = p_in and role = 'player';
    update profiles set role = 'player' where id = p_out;
  end if;
  update profiles set team_id = null where id = p_out;
end;
$$;

-- Record a concession or agreed halve ('A' | 'B' | 'half'; null clears it). Players in the
-- match can do this from the course, so it's an RPC — matches is otherwise admin-only.
create or replace function set_match_result(p_match_id uuid, p_result text)
returns void language plpgsql security definer as $$
declare m matches%rowtype;
begin
  select * into m from matches where id = p_match_id;
  if m.id is null then raise exception 'Match not found'; end if;
  if not (is_event_admin(m.event_id)
          or auth.uid() = any(m.side_a_players) or auth.uid() = any(m.side_b_players)) then
    raise exception 'Not authorized';
  end if;
  if p_result is not null and p_result not in ('A','B','half') then
    raise exception 'Invalid result';
  end if;
  update matches set result_override = p_result where id = p_match_id;
end;
$$;

-- Record the draft coin-toss winner (the team that picks first in the snake order).
-- Organizer/captain only, and locked once the draft has started so the order can't change
-- mid-draft. Uses a security-definer function so captains can write it (events is
-- organizer-only under RLS).
create or replace function set_draft_first_team(p_event uuid, p_team_id uuid)
returns void language plpgsql security definer as $$
begin
  if not is_event_admin(p_event) then raise exception 'Not authorized'; end if;
  if exists (select 1 from profiles where event_id = p_event and team_id is not null) then
    raise exception 'Draft has already started — the toss is locked';
  end if;
  if not exists (select 1 from teams where id = p_team_id and event_id = p_event) then
    raise exception 'Team is not in this event';
  end if;
  update events set draft_first_team_id = p_team_id where id = p_event;
end;
$$;

-- Record a round's matchup coin-toss winner (who submits their lineup first that round).
-- Organizer/captain only, and locked once that round has any match.
create or replace function set_round_first_team(p_round_id uuid, p_team_id uuid)
returns void language plpgsql security definer as $$
declare v_event uuid;
begin
  select event_id into v_event from rounds where id = p_round_id;
  if v_event is null then raise exception 'Round not found'; end if;
  if not is_event_admin(v_event) then raise exception 'Not authorized'; end if;
  if exists (select 1 from matches where round_id = p_round_id) then
    raise exception 'Round has already started — the toss is locked';
  end if;
  if not exists (select 1 from teams where id = p_team_id and event_id = v_event) then
    raise exception 'Team is not in this event';
  end if;
  update rounds set first_team_id = p_team_id where id = p_round_id;
end;
$$;

-- Reset a player's PIN. A player's PIN is their Supabase auth password (derived in
-- src/lib/playerAuth.js); the client passes the freshly derived password string and this
-- re-hashes it. Organizer-only, scoped to the organizer's own event.
create extension if not exists pgcrypto;

create or replace function admin_reset_player_pin(p_player_id uuid, p_new_password text)
returns void language plpgsql security definer as $$
declare v_event uuid;
begin
  select event_id into v_event from profiles where id = p_player_id;
  if v_event is null then raise exception 'Player not found'; end if;
  if not is_organizer(v_event) then raise exception 'Not authorized'; end if;

  update auth.users
    set encrypted_password = crypt(p_new_password, gen_salt('bf')), updated_at = now()
    where id = p_player_id;
end;
$$;

-- Rename a player: updates both the synthetic auth email (so they can still log in
-- with the new name) and profiles.display_name. Uses the same slug logic as playerAuth.js.
-- Organizer-only, scoped to the organizer's own event.
create or replace function admin_rename_player(p_player_id uuid, p_new_name text)
returns void language plpgsql security definer as $$
declare
  v_event uuid;
  v_join_code text;
  v_name_slug text;
  v_code_slug text;
  v_new_email text;
begin
  select event_id into v_event from profiles where id = p_player_id;
  if v_event is null then raise exception 'Player not found'; end if;
  if not is_organizer(v_event) then raise exception 'Not authorized'; end if;

  select join_code into v_join_code from events where id = v_event;
  v_name_slug := lower(regexp_replace(trim(p_new_name), '[^a-zA-Z0-9]+', '', 'g'));
  v_code_slug := lower(regexp_replace(trim(v_join_code), '[^a-zA-Z0-9]+', '', 'g'));
  v_new_email := v_name_slug || '.' || v_code_slug || '@players.rydercup.app';

  update auth.users set email = v_new_email, updated_at = now() where id = p_player_id;
  update profiles set display_name = trim(p_new_name) where id = p_player_id;
end;
$$;

-- Promote or demote a player to/from organizer. Organizer-only, scoped to their event.
-- Guards against removing the last organizer.
create or replace function set_organizer_role(p_player_id uuid, p_make_organizer boolean)
returns void language plpgsql security definer as $$
declare
  v_event uuid;
  v_organizer_count int;
begin
  select event_id into v_event from profiles where id = p_player_id;
  if v_event is null then raise exception 'Player not found'; end if;
  if not is_organizer(v_event) then raise exception 'Not authorized'; end if;

  if not p_make_organizer then
    select count(*) into v_organizer_count
    from profiles where event_id = v_event and role = 'organizer';
    if v_organizer_count <= 1 then
      raise exception 'Cannot remove the last organizer';
    end if;
  end if;

  update profiles
    set role = case when p_make_organizer then 'organizer' else 'player' end
  where id = p_player_id and event_id = v_event;
end;
$$;

-- ---------- realtime ----------

-- Broadcast live changes to every open device without a manual reload:
--   profiles/teams  -> Draft picks and the alternating turn-lock
--   hole_scores     -> co-scorers see each other's hole entries live
--   matches         -> a submitted result / status update reflects everywhere
--   events          -> the draft coin-toss winner reflects on every device
--   rounds          -> the per-round matchup coin-toss winner reflects everywhere
-- RLS still applies; the read_* policies already allow authenticated reads.
-- Guarded so re-running this file is a no-op if the tables are already published.
do $$
declare tbl text;
begin
  foreach tbl in array array['profiles','teams','hole_scores','matches','events','rounds'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = tbl
    ) then
      execute format('alter publication supabase_realtime add table %I', tbl);
    end if;
  end loop;
end $$;

-- ---------- chat ----------


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

-- ---------- chat reactions ----------

-- Emoji reactions on chat messages: one row per person per emoji per message. The emoji set
-- matches REACTIONS in src/context/ChatContext.jsx.
create table if not exists message_reactions (
  message_id uuid not null references messages(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  event_id uuid not null references events(id) on delete cascade,
  emoji text not null check (emoji in ('👍','👎','😂','❤️','🔥','😮','😢')),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);
create index if not exists message_reactions_event on message_reactions (event_id);

alter table message_reactions enable row level security;

drop policy if exists read_reactions on message_reactions;
create policy read_reactions on message_reactions for select to authenticated
  using (event_id = my_event());

-- React as yourself, to a message in your own event.
drop policy if exists add_reaction on message_reactions;
create policy add_reaction on message_reactions for insert to authenticated
  with check (
    user_id = auth.uid() and event_id = my_event()
    and exists (select 1 from messages m where m.id = message_id and m.event_id = my_event())
  );

drop policy if exists remove_reaction on message_reactions;
create policy remove_reaction on message_reactions for delete to authenticated
  using (user_id = auth.uid());

-- Live reactions on every open device. DELETE payloads carry the primary key, which is
-- every column the app needs.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'message_reactions'
  ) then
    alter publication supabase_realtime add table message_reactions;
  end if;
end $$;

-- ---------- multi-event organizers ----------
-- (Same as patch-2026-10-multi-event.sql; redefines a few functions above.)


create extension if not exists pgcrypto;

-- One row per organizer account: the event it's working on right now.
create table if not exists organizers (
  user_id uuid primary key references auth.users(id) on delete cascade,
  active_event_id uuid references events(id) on delete set null
);
-- Which organizer accounts run which events. (References profiles so the app can fetch
-- organizers' names in the same query.)
create table if not exists event_organizers (
  event_id uuid not null references events(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  primary key (event_id, user_id)
);
-- false for a player copied from an earlier event who hasn't joined (set a PIN) yet.
alter table profiles add column if not exists claimed boolean not null default true;

alter table organizers enable row level security;
alter table event_organizers enable row level security;
-- Written only by the RPCs below.
drop policy if exists read_own_organizer on organizers;
create policy read_own_organizer on organizers for select to authenticated using (user_id = auth.uid());
drop policy if exists read_event_organizers on event_organizers;
create policy read_event_organizers on event_organizers for select to authenticated using (true);

-- Existing organizer accounts (email logins, not player logins) run the event they're in and
-- any event they created.
insert into organizers (user_id, active_event_id)
select p.id, p.event_id from profiles p join auth.users u on u.id = p.id
where p.role = 'organizer' and u.email not like '%@players.rydercup.app'
on conflict (user_id) do nothing;
insert into event_organizers (event_id, user_id)
select p.event_id, p.id from profiles p join organizers o on o.user_id = p.id
where p.event_id is not null
on conflict do nothing;
insert into event_organizers (event_id, user_id)
select e.id, e.created_by from events e join organizers o on o.user_id = e.created_by
on conflict do nothing;

-- ---------- who's in charge ----------

create or replace function is_organizer(evt uuid)
returns boolean language sql stable security definer as $$
  select exists (
    select 1 from profiles p
    where p.id = auth.uid() and p.event_id = evt and p.role = 'organizer'
  ) or exists (
    select 1 from event_organizers o where o.event_id = evt and o.user_id = auth.uid()
  );
$$;

create or replace function is_event_admin(evt uuid)
returns boolean language sql stable security definer as $$
  select exists (
    select 1 from profiles p
    where p.id = auth.uid() and p.event_id = evt and p.role in ('organizer','captain')
  ) or exists (
    select 1 from event_organizers o where o.event_id = evt and o.user_id = auth.uid()
  );
$$;

-- The event the signed-in user is in: an organizer account's active event, else their
-- player profile's event. Chat, reactions, automated posts and push all key off this.
create or replace function my_event()
returns uuid language sql stable security definer as $$
  select coalesce(
    (select active_event_id from organizers where user_id = auth.uid()),
    (select event_id from profiles where id = auth.uid()));
$$;

-- Join codes are how players find their event, so no two events may share one.
create or replace function guard_join_code()
returns trigger language plpgsql security definer as $$
begin
  if exists (select 1 from events
             where lower(trim(join_code)) = lower(trim(new.join_code)) and id <> new.id) then
    raise exception 'That join code is already used by another event — pick another.';
  end if;
  return new;
end;
$$;
drop trigger if exists guard_join_code on events;
create trigger guard_join_code before insert or update of join_code on events
  for each row execute function guard_join_code();

-- ---------- creating and switching events ----------

-- Make the caller an organizer of an event and switch them to it. Internal: called by
-- create_event / copy_event only.
create or replace function become_organizer(p_event uuid, p_name text)
returns void language plpgsql security definer as $$
begin
  -- An organizer's own profile isn't in any event (so they're not in the draft pool); it
  -- carries their name for chat. An existing profile is left where it is.
  insert into profiles (id, event_id, display_name, handicap, role)
  values (auth.uid(), null, coalesce(nullif(trim(p_name), ''), 'Organizer'), 0, 'organizer')
  on conflict (id) do nothing;
  insert into event_organizers (event_id, user_id) values (p_event, auth.uid()) on conflict do nothing;
  insert into organizers (user_id, active_event_id) values (auth.uid(), p_event)
    on conflict (user_id) do update set active_event_id = excluded.active_event_id;
end;
$$;
revoke execute on function become_organizer(uuid, text) from public, anon, authenticated;

create or replace function create_event(p_name text, p_join_code text, p_organizer_name text)
returns uuid language plpgsql security definer as $$
declare v_event uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if nullif(trim(p_join_code), '') is null then raise exception 'Pick a join code'; end if;
  insert into events (name, join_code, created_by)
  values (trim(p_name), trim(p_join_code), auth.uid())
  returning id into v_event;
  perform become_organizer(v_event, p_organizer_name);
  return v_event;
end;
$$;

-- A new event with an existing one's settings and course (no teams, rounds or matchups).
-- The client then copies the players (see src/lib/copyPlayers.js).
create or replace function copy_event(p_source uuid, p_name text, p_join_code text)
returns uuid language plpgsql security definer as $$
declare
  v_event uuid;
  s events%rowtype;
begin
  if not exists (select 1 from event_organizers where event_id = p_source and user_id = auth.uid()) then
    raise exception 'Not authorized';
  end if;
  if nullif(trim(p_join_code), '') is null then raise exception 'Pick a join code'; end if;
  select * into s from events where id = p_source;
  insert into events (name, join_code, created_by,
                      singles_pct, altshot_pct, scramble_low_pct, scramble_high_pct, scoring_mode)
  values (trim(p_name), trim(p_join_code), auth.uid(),
          s.singles_pct, s.altshot_pct, s.scramble_low_pct, s.scramble_high_pct, s.scoring_mode)
  returning id into v_event;
  insert into courses (event_id, name, holes)
  select v_event, name, holes from courses where event_id = p_source;
  perform become_organizer(v_event, (select display_name from profiles where id = auth.uid()));
  return v_event;
end;
$$;

create or replace function switch_event(p_event uuid)
returns void language plpgsql security definer as $$
begin
  if not exists (select 1 from event_organizers where event_id = p_event and user_id = auth.uid()) then
    raise exception 'Not authorized';
  end if;
  update organizers set active_event_id = p_event where user_id = auth.uid();
end;
$$;

-- ---------- copied players ----------

-- A copied player joins with the new code, their name and a PIN of their choice: this sets
-- that PIN, once. Called signed out (from the Join page), so it's open to anon — the same
-- trust as joining, where anyone can take an unused name. The organizer can reset a PIN.
create or replace function claim_player(p_code text, p_name text, p_password text)
returns boolean language plpgsql security definer as $$
declare
  v_event uuid;
  v_join_code text;
  v_email text;
  v_id uuid;
begin
  select id, join_code into v_event, v_join_code from events
  where lower(trim(join_code)) = lower(trim(p_code)) limit 1;
  if v_event is null then return false; end if;
  -- Same derivation as src/lib/playerAuth.js.
  v_email := lower(regexp_replace(trim(p_name), '[^a-zA-Z0-9]+', '', 'g')) || '.'
          || lower(regexp_replace(trim(v_join_code), '[^a-zA-Z0-9]+', '', 'g')) || '@players.rydercup.app';
  select p.id into v_id from profiles p join auth.users u on u.id = p.id
  where u.email = v_email and p.event_id = v_event and not p.claimed;
  if v_id is null then return false; end if;
  update auth.users set encrypted_password = crypt(p_password, gen_salt('bf')), updated_at = now()
  where id = v_id;
  update profiles set claimed = true where id = v_id;
  return true;
end;
$$;
grant execute on function claim_player(text, text, text) to anon, authenticated;

-- Only an organizer may mark a player as claimed or not (a copied player's PIN is up for grabs
-- until they claim it).
create or replace function guard_profile_update()
returns trigger language plpgsql as $$
begin
  if current_user <> 'authenticated' then return new; end if;
  if (new.role is distinct from old.role or new.event_id is distinct from old.event_id
      or new.claimed is distinct from old.claimed)
     and not is_organizer(old.event_id) then
    raise exception 'Only an organizer can change roles';
  end if;
  if new.team_id is distinct from old.team_id and not is_event_admin(old.event_id) then
    raise exception 'Only a captain or organizer can change teams';
  end if;
  return new;
end;
$$;

-- A PIN the organizer sets also claims the player, so nobody else can set one after.
create or replace function admin_reset_player_pin(p_player_id uuid, p_new_password text)
returns void language plpgsql security definer as $$
declare v_event uuid;
begin
  select event_id into v_event from profiles where id = p_player_id;
  if v_event is null then raise exception 'Player not found'; end if;
  if not is_organizer(v_event) then raise exception 'Not authorized'; end if;

  update auth.users
    set encrypted_password = crypt(p_new_password, gen_salt('bf')), updated_at = now()
    where id = p_player_id;
  update profiles set claimed = true where id = p_player_id;
end;
$$;

-- Removing a copied player who never joined deletes their placeholder account too (nobody
-- knows its password, so it could never be used, and it would block re-adding the name).
create or replace function remove_player(p_player_id uuid)
returns void language plpgsql security definer as $$
declare
  v_event uuid;
  v_claimed boolean;
begin
  select event_id, claimed into v_event, v_claimed from profiles where id = p_player_id;
  if v_event is null then raise exception 'Player not found'; end if;
  if not is_event_admin(v_event) then raise exception 'Not authorized'; end if;

  perform assert_player_not_matched(p_player_id, v_event);

  update teams set captain_id = null where captain_id = p_player_id;
  if not v_claimed then
    delete from auth.users where id = p_player_id;   -- cascades to the profile
  else
    delete from profiles where id = p_player_id;
  end if;
end;
$$;

-- The last organizer can't be demoted — an organizer account running the event counts.
create or replace function set_organizer_role(p_player_id uuid, p_make_organizer boolean)
returns void language plpgsql security definer as $$
declare
  v_event uuid;
  v_organizer_count int;
begin
  select event_id into v_event from profiles where id = p_player_id;
  if v_event is null then raise exception 'Player not found'; end if;
  if not is_organizer(v_event) then raise exception 'Not authorized'; end if;

  if not p_make_organizer then
    select count(*) into v_organizer_count from (
      select id from profiles where event_id = v_event and role = 'organizer'
      union
      select user_id from event_organizers where event_id = v_event
    ) o where o.id <> p_player_id;
    if v_organizer_count < 1 then
      raise exception 'Cannot remove the last organizer';
    end if;
  end if;

  update profiles
    set role = case when p_make_organizer then 'organizer' else 'player' end
  where id = p_player_id and event_id = v_event;
end;
$$;
