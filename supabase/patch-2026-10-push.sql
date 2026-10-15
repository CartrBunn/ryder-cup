-- Push notifications. Patch for an existing database; run after patch-2026-10-chat.sql.
-- Safe to run more than once: paste into the Supabase SQL editor and run.
-- Also deploy the send-push Edge Function and set its secrets — see supabase/README.md.

-- One row per device that turned on notifications. Written only through the RPCs below,
-- so a shared phone that changes hands moves its subscription to whoever is signed in.
create table if not exists push_subscriptions (
  endpoint text primary key,
  profile_id uuid not null references profiles(id) on delete cascade,
  event_id uuid not null references events(id) on delete cascade,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
alter table push_subscriptions enable row level security;
-- No policies: only the security-definer RPCs and the Edge Function (service role) touch it.

create or replace function save_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
returns void language plpgsql security definer as $$
begin
  if auth.uid() is null or my_event() is null then raise exception 'Not signed in to an event'; end if;
  insert into push_subscriptions (endpoint, profile_id, event_id, p256dh, auth)
  values (p_endpoint, auth.uid(), my_event(), p_p256dh, p_auth)
  on conflict (endpoint) do update
    set profile_id = excluded.profile_id, event_id = excluded.event_id,
        p256dh = excluded.p256dh, auth = excluded.auth;
end;
$$;

create or replace function delete_push_subscription(p_endpoint text)
returns void language sql security definer as $$
  delete from push_subscriptions where endpoint = p_endpoint and profile_id = auth.uid();
$$;

-- Each automated post is pushed at most once: the Edge Function claims it by setting pushed_at.
alter table messages add column if not exists pushed_at timestamptz;

-- When a post that pops up in the app is created, ask the send-push Edge Function to push it.
-- Only the message id is sent; the function re-reads the message itself, so a forged call
-- can't push made-up text.
create extension if not exists pg_net;

create or replace function notify_push()
returns trigger language plpgsql security definer as $$
begin
  perform net.http_post(
    url := 'https://tqoijkovsfzputpzftng.supabase.co/functions/v1/send-push',
    body := jsonb_build_object('id', new.id),
    headers := '{"Content-Type": "application/json"}'::jsonb
  );
  return new;
end;
$$;

drop trigger if exists notify_push on messages;
create trigger notify_push after insert on messages
  for each row when (new.kind in ('final', 'round', 'clinch', 'ace', 'pairings'))
  execute function notify_push();
