-- Players in any match that starts on the same hole of the same round may score each other's
-- matches (shotgun starts: the groups on a hole watch each other). Safe to run more than once.

create or replace function can_score_match(p_match uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from matches m
    where m.id = p_match
      and ( is_event_admin(m.event_id)
            or auth.uid() = any(m.side_a_players)
            or auth.uid() = any(m.side_b_players)
            or ( m.start_hole is not null and exists (
                   select 1 from matches o
                   where o.round_id = m.round_id and o.start_hole = m.start_hole
                     and ( auth.uid() = any(o.side_a_players) or auth.uid() = any(o.side_b_players) ) ) ) )
  );
$$;

drop policy if exists write_scores on hole_scores;
create policy write_scores on hole_scores for all to authenticated
  using (can_score_match(match_id))
  with check (can_score_match(match_id));
