-- Emoji reactions on chat messages. Patch for an existing database (also in schema.sql).
-- Run after patch-2026-10-chat.sql. Safe to run more than once: paste into the Supabase SQL editor and run.

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
