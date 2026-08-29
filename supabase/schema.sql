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
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

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
  course_id uuid references courses(id)
);

create table if not exists matches (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references rounds(id) on delete cascade,
  event_id uuid not null references events(id) on delete cascade,
  seq int not null,
  side_a_players uuid[] not null default '{}',   -- profiles.id[]  (1 for singles, 2 for team formats)
  side_b_players uuid[] not null default '{}',
  status_text text,                              -- e.g. "A 2 up thru 7"  (denormalized for quick reads)
  final text,                                    -- 'A' | 'B' | 'half' | null
  submitted boolean not null default false
);

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
  select id into v_event from events where join_code = p_code limit 1;
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

-- ---------- realtime ----------

-- Broadcast live changes to every open device without a manual reload:
--   profiles/teams  -> Draft picks and the alternating turn-lock
--   hole_scores     -> co-scorers see each other's hole entries live
--   matches         -> a submitted result / status update reflects everywhere
-- RLS still applies; the read_* policies already allow authenticated reads.
-- Guarded so re-running this file is a no-op if the tables are already published.
do $$
declare tbl text;
begin
  foreach tbl in array array['profiles','teams','hole_scores','matches'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = tbl
    ) then
      execute format('alter publication supabase_realtime add table %I', tbl);
    end if;
  end loop;
end $$;
