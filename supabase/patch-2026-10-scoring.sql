-- Stroke play or match play, chosen per event on the Setup page. Match play (the default) wins
-- holes; stroke play plays every hole and the lower net total takes the match.
-- Safe to run more than once: paste into the Supabase SQL editor and run.

alter table events add column if not exists scoring_mode text not null default 'match'
  check (scoring_mode in ('match','stroke'));
