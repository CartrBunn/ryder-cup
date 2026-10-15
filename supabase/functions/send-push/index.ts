// Sends a push notification for one automated chat post. Called by the notify_push trigger
// (supabase/patch-2026-10-push.sql) with just { id }. Deploy with "Verify JWT" off: the body is
// only an id, and the message is re-read and claimed here, so a forged call can at most push a
// real post that was created in the last few minutes and hasn't been pushed yet.
//
// Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (your site's https URL).
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2';

const PUSH_KINDS = new Set(['final', 'round', 'clinch', 'ace', 'pairings']);
const FRESH_MS = 5 * 60 * 1000;   // ignore posts older than this (e.g. a replayed call)

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async req => {
  let id: string | undefined;
  try { ({ id } = await req.json()); } catch { /* fall through */ }
  if (!id) return json({ error: 'id required' }, 400);

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  webpush.setVapidDetails(Deno.env.get('VAPID_SUBJECT')!,
    Deno.env.get('VAPID_PUBLIC_KEY')!, Deno.env.get('VAPID_PRIVATE_KEY')!);

  // Claim the post so it's pushed once, however many times this is called.
  const { data: msg, error } = await db.from('messages')
    .update({ pushed_at: new Date().toISOString() })
    .eq('id', id).is('pushed_at', null)
    .gt('created_at', new Date(Date.now() - FRESH_MS).toISOString())
    .select('*').maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!msg || !PUSH_KINDS.has(msg.kind) || msg.retracted) return json({ sent: 0, skipped: true });

  // Who gets what: everyone in the event gets result posts; for pairings, only the players
  // in that round, each told their own match.
  let bodyFor: (profileId: string) => string | null = () => msg.body;
  let url = '#/chat';
  if (msg.kind === 'pairings') {
    const roundId = String(msg.auto_key).split(':')[1];
    const { data: matches } = await db.from('matches').select('*').eq('round_id', roundId);
    const ids = (matches || []).flatMap(m => [...m.side_a_players, ...m.side_b_players]);
    const { data: people } = await db.from('profiles').select('id, display_name').in('id', ids);
    const name = (pid: string) => people?.find(p => p.id === pid)?.display_name || '—';
    bodyFor = pid => {
      const m = (matches || []).find(x => x.side_a_players.includes(pid) || x.side_b_players.includes(pid));
      if (!m) return null;
      const mine: string[] = m.side_a_players.includes(pid) ? m.side_a_players : m.side_b_players;
      const theirs: string[] = mine === m.side_a_players ? m.side_b_players : m.side_a_players;
      const partners = mine.filter(x => x !== pid).map(name);
      const who = partners.length ? `You and ${partners.join(' & ')} are` : "You're";
      const start = m.start_hole ? `, starting on hole ${m.start_hole}` : '';
      return `📋 ${who} in Match ${m.seq} vs ${theirs.map(name).join('/')}${start}`;
    };
    url = '#/';
  }

  const { data: subs, error: subErr } = await db.from('push_subscriptions')
    .select('*').eq('event_id', msg.event_id);
  if (subErr) return json({ error: subErr.message }, 500);

  let sent = 0;
  const gone: string[] = [];
  await Promise.all((subs || []).map(async s => {
    const body = bodyFor(s.profile_id);
    if (!body) return;
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ body, url, tag: 'rydercup-' + msg.event_id }),
        { TTL: 3600, urgency: 'high' });
      sent++;
    } catch (e) {
      // 404/410: the device unsubscribed or the browser dropped it — forget it.
      if ([404, 410].includes((e as { statusCode?: number }).statusCode ?? 0)) gone.push(s.endpoint);
      else console.error('push failed', (e as Error).message);
    }
  }));
  if (gone.length) await db.from('push_subscriptions').delete().in('endpoint', gone);
  return json({ sent, removed: gone.length });
});
