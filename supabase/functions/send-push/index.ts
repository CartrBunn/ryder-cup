// Sends push notifications for one chat post. Called by the notify_push trigger
// (supabase/patch-2026-10-push.sql, patch-2026-10-chat-all.sql) with just { id }. Deploy
// with "Verify JWT" off: the body is only an id, and the message is re-read and claimed here,
// so a forged call can at most push a real post that was created in the last few minutes and
// hasn't been pushed yet.
//
// Who gets what:
//   final / round / clinch / ace  everyone in the event
//   projection                    everyone (a round's projected score every 3 holes)
//   harass                        everyone (the organizer's chosen player lost a hole)
//   announce                      everyone but the organizer who sent it
//   pairings                      the players in that round, each told their own match
//   startholes                    everyone; players are told their own starting hole
//   chat                          everyone but the sender ("mentioned you" if @mentioned)
//
// Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (your site's https URL).
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2';

const RESULT_KINDS = new Set(['final', 'round', 'clinch', 'ace', 'projection', 'harass']);
const FRESH_MS = 5 * 60 * 1000;   // ignore posts older than this (e.g. a replayed call)

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

type Person = { id: string; name: string };
type Match = { seq: number; side_a_players: string[]; side_b_players: string[]; start_hole: number | null };

// Copy of mentionedIds() in src/lib/mentions.js — keep the two in sync.
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function mentionedIds(body: string, people: Person[]): Set<string> {
  const first = (n: string) => n.trim().split(/\s+/)[0].toLowerCase();
  const firstCount: Record<string, number> = {};
  people.forEach(p => { firstCount[first(p.name)] = (firstCount[first(p.name)] || 0) + 1; });
  const aliases: Record<string, string> = {};
  for (const p of people) {
    aliases[p.name.trim().toLowerCase()] = p.id;
    if (firstCount[first(p.name)] === 1) aliases[first(p.name)] ??= p.id;
  }
  const keys = Object.keys(aliases).filter(Boolean).sort((a, b) => b.length - a.length);
  if (!keys.length) return new Set();
  const regex = new RegExp(`(?<![\\p{L}\\p{N}])@(${keys.map(escape).join('|')})(?![\\p{L}\\p{N}])`, 'giu');
  return new Set([...body.matchAll(regex)].map(x => aliases[x[1].toLowerCase()]));
}

// The match a player is in this round, described from their side.
function matchFor(pid: string, matches: Match[], name: (id: string) => string) {
  const m = matches.find(x => x.side_a_players.includes(pid) || x.side_b_players.includes(pid));
  if (!m) return null;
  const mine = m.side_a_players.includes(pid) ? m.side_a_players : m.side_b_players;
  const theirs = mine === m.side_a_players ? m.side_b_players : m.side_a_players;
  const partners = mine.filter(x => x !== pid).map(name);
  return { m, partners, vs: theirs.map(name).join('/') };
}

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
  if (!msg || msg.retracted) return json({ sent: 0, skipped: true });

  const [{ data: profiles }, { data: organizers }] = await Promise.all([
    db.from('profiles').select('id, display_name').eq('event_id', msg.event_id),
    // Organizer accounts running the event, who usually aren't players in it.
    db.from('event_organizers').select('profiles(id, display_name)').eq('event_id', msg.event_id)
  ]);
  const people: Person[] = [...(profiles || []), ...(organizers || []).map(o => o.profiles).filter(Boolean)]
    .filter((p, i, all) => all.findIndex(q => q.id === p.id) === i)
    .map(p => ({ id: p.id, name: p.display_name }));
  const name = (pid: string) => people.find(p => p.id === pid)?.name || '—';
  const author = msg.author_id ? name(msg.author_id) : '';

  let bodyFor: (pid: string) => string | null;
  let url = '#/chat';
  if (RESULT_KINDS.has(msg.kind)) {
    bodyFor = () => msg.body;
  } else if (msg.kind === 'announce') {
    bodyFor = pid => pid === msg.author_id ? null : `📣 ${author}: ${msg.body}`;
  } else if (msg.kind === 'chat') {
    const mentioned = mentionedIds(msg.body, people);
    bodyFor = pid => pid === msg.author_id ? null
      : mentioned.has(pid) ? `💬 ${author} mentioned you: ${msg.body}` : `💬 ${author}: ${msg.body}`;
  } else if (msg.kind === 'pairings' || msg.kind === 'startholes') {
    const roundId = String(msg.auto_key).split(':')[1];
    const [{ data: matches }, { data: round }] = await Promise.all([
      db.from('matches').select('*').eq('round_id', roundId),
      db.from('rounds').select('name').eq('id', roundId).maybeSingle()
    ]);
    url = '#/';
    if (msg.kind === 'pairings') {
      bodyFor = pid => {
        const f = matchFor(pid, matches || [], name);
        if (!f) return null;
        const who = f.partners.length ? `You and ${f.partners.join(' & ')} are` : "You're";
        const start = f.m.start_hole ? `, starting on hole ${f.m.start_hole}` : '';
        return `📋 ${who} in Match ${f.m.seq} vs ${f.vs}${start}`;
      };
    } else {
      bodyFor = pid => {
        const f = matchFor(pid, matches || [], name);
        if (!f) return msg.body;
        return `⛳ ${round?.name || 'Next round'}: you start on hole ${f.m.start_hole} (Match ${f.m.seq} vs ${f.vs})`;
      };
    }
  } else {
    return json({ sent: 0, skipped: true });
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
