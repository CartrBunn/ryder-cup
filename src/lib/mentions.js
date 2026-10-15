// @mentions in chat. "@Jason Kenney" always works; "@Jason" works when no one else in the
// event shares that first name. Matching ignores case and needs a word boundary on both sides.
// Keep in sync with the copy in supabase/functions/send-push/index.ts.

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// people: [{ id, name }]. Returns { regex, idOf(matchedText) }, or null if there's no one.
function matcher(people) {
  const first = n => n.trim().split(/\s+/)[0].toLowerCase();
  const firstCount = {};
  people.forEach(p => { firstCount[first(p.name)] = (firstCount[first(p.name)] || 0) + 1; });
  const aliases = {};
  for (const p of people) {
    aliases[p.name.trim().toLowerCase()] = p.id;
    if (firstCount[first(p.name)] === 1) aliases[first(p.name)] ??= p.id;
  }
  const keys = Object.keys(aliases).filter(Boolean).sort((a, b) => b.length - a.length);
  if (!keys.length) return null;
  const regex = new RegExp(`(?<![\\p{L}\\p{N}])@(${keys.map(escape).join('|')})(?![\\p{L}\\p{N}])`, 'giu');
  return { regex, idOf: text => aliases[text.toLowerCase()] };
}

// Profile ids mentioned in a message.
export function mentionedIds(body, people) {
  const m = matcher(people);
  if (!m) return new Set();
  return new Set([...body.matchAll(m.regex)].map(x => m.idOf(x[1])));
}

// The message split into plain text and mentions, for display: [{ text, id? }].
export function splitMentions(body, people) {
  const m = matcher(people);
  if (!m) return [{ text: body }];
  const parts = [];
  let last = 0;
  for (const x of body.matchAll(m.regex)) {
    if (x.index > last) parts.push({ text: body.slice(last, x.index) });
    parts.push({ text: x[0], id: m.idOf(x[1]) });
    last = x.index + x[0].length;
  }
  if (last < body.length) parts.push({ text: body.slice(last) });
  return parts;
}
