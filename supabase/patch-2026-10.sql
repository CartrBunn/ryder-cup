-- Patch for an existing database (already in schema.sql for fresh installs).
-- Safe to run more than once: paste into the Supabase SQL editor and run.

-- 1) Join codes match regardless of case/surrounding spaces, so a phone auto-capitalizing
--    the code doesn't fail the join (logins were already case-insensitive).
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

-- 2) Profile updates made directly through the API can't escalate: only an organizer may
--    change a role or event, and only a captain/organizer may change a team. (The RLS
--    update policies say who may touch a row, not which columns.) The security-definer
--    RPCs run as their owner, not 'authenticated', and do their own checks, so they pass.
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

-- 3) Concessions / agreed halves. A result recorded by hand ('A' | 'B' | 'half') ends a
--    match the hole scores haven't decided; once the scores decide it, the scores win.
--    Players in the match can record it from the course, so it goes through an RPC
--    (matches is otherwise writable only by organizers/captains). null clears it.
alter table matches add column if not exists result_override text
  check (result_override in ('A','B','half'));

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
