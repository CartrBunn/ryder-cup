-- Multi-event organizers. Patch for an existing database (already in schema.sql for fresh
-- installs). Safe to run more than once: paste into the Supabase SQL editor and run.
--
-- An organizer account (email + password) now runs any number of events and switches between
-- them; it no longer has to be a player in the event. Players are still one account per event
-- (name + join code + PIN). Copying an event for next year brings over its course, settings and
-- players (not teams, rounds or matchups); copied players set a new PIN when they join.

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
