// Automated chat posts. Every device works out the same list of posts from the loaded event
// (see loadEvent); AutoPoster.jsx syncs that list into the messages table. Each post has a
// stable key so it happens once, and a sig (the result it describes) so a score correction
// edits the post rather than adding a new one.
import { computeEvent, plannedMatches, tournamentTotals } from './matchcompute';
import { matchState, orderedHoles } from './scoring';

// Kinds that pop up for everyone when posted. 'pairings' pops up only for the players in
// that round (see Alerts.jsx); 'eagle' and 'draft' are chat-only.
export const TOAST_KINDS = new Set(['final', 'round', 'clinch', 'ace', 'projection']);

// A round's projected score is posted each time its slowest match gets this many more holes in.
const PROJECTION_EVERY = 3;

// Kinds whose post is withdrawn (hidden) if the scores stop backing it up. Pairings and the
// draft stay posted once they've happened.
const RETRACTABLE = new Set(['final', 'round', 'clinch', 'ace', 'eagle']);

const pts = n => {
  const whole = Math.floor(n), half = n - whole >= 0.5;
  return half ? (whole ? `${whole}½` : '½') : String(whole);
};

export function desiredPosts(data) {
  const { teams, profiles, rounds, matches, courses, scores } = data;
  const [teamA, teamB] = teams;
  if (!teamA || !teamB) return [];

  const ctxById = computeEvent(data);
  const totals = tournamentTotals(matches, ctxById);
  const { plannedForRound, plannedTotal } = plannedMatches(data);
  const profilesById = Object.fromEntries(profiles.map(p => [p.id, p]));
  const teamsById = Object.fromEntries(teams.map(t => [t.id, t]));
  const names = ids => ids.map(id => profilesById[id]?.display_name || '—').join('/');

  const a = totals[teamA.id] || 0, b = totals[teamB.id] || 0;
  const scoreLine = a > b ? `${teamA.name} leads ${pts(a)}–${pts(b)}`
    : b > a ? `${teamB.name} leads ${pts(b)}–${pts(a)}`
    : `All square ${pts(a)}–${pts(b)}`;

  const roundById = Object.fromEntries(rounds.map(r => [r.id, r]));
  const courseById = Object.fromEntries(courses.map(c => [c.id, c]));
  const scoresByMatch = {};
  for (const s of scores) (scoresByMatch[s.match_id] ||= []).push(s);
  const grossOf = mid => {
    const g = { A: {}, B: {} };
    for (const s of scoresByMatch[mid] || []) g[s.side][s.hole] = s.gross;
    return g;
  };
  // A match's points for [teamA, teamB] if it ended where it stands: the leader gets the
  // point, all square is a half each. A decided match counts its result.
  const standing = (c, st) => {
    const [pa, pb] = st.decided ? [st.pointsA, st.pointsB] : st.up > 0 ? [1, 0] : st.up < 0 ? [0, 1] : [0.5, 0.5];
    return c.teamAId === teamA.id ? [pa, pb] : [pb, pa];
  };

  const draft = [], pairings = [], shots = [], projections = [], finals = [], roundsDone = [], clinch = [];

  // Draft complete: everyone in the event is on a team (same rule as the Draft page).
  if (profiles.length && profiles.every(p => p.team_id)) {
    const size = t => profiles.filter(p => p.team_id === t.id).length;
    draft.push({ key: 'draft', kind: 'draft', sig: 'done',
      body: `📝 The draft is done: ${teamA.name} (${size(teamA)}) vs ${teamB.name} (${size(teamB)}). Teams are set.` });
  }

  for (const r of rounds) {
    const inRound = matches.filter(m => m.round_id === r.id);
    const planned = plannedForRound(r);
    const allSet = planned > 0 && inRound.length >= planned && !r.pending_pick;

    // Pairings set — only before anyone has teed off, so a round set up long ago
    // isn't announced after the fact.
    if (allSet && inRound.every(m => ctxById[m.id]?.state.played === 0)) {
      pairings.push({ key: `pairings:${r.id}`, kind: 'pairings', sig: 'set',
        body: `📋 ${r.name} pairings are set. Check the Leaderboard for your match.` });
    }

    // Projected round score every few holes: once every match is through the next mark,
    // each match is scored as it stood after that many of its holes, so the post doesn't
    // shift as faster groups play on. Only the latest mark is posted (a device that comes
    // back after a gap doesn't post the ones it missed), and not the last hole — the
    // round result covers that.
    const holes = courseById[r.course_id]?.holes || [];
    const live = inRound.filter(m => ctxById[m.id]?.teamAId && ctxById[m.id]?.teamBId);
    if (allSet && live.length === inRound.length && !inRound.every(m => ctxById[m.id].state.decided)) {
      const thru = Math.min(...inRound.map(m => ctxById[m.id].state.decided ? Infinity : ctxById[m.id].state.played));
      const mark = Math.floor(thru / PROJECTION_EVERY) * PROJECTION_EVERY;
      if (mark > 0 && mark < holes.length) {
        let ra = 0, rb = 0;
        for (const m of inRound) {
          const c = ctxById[m.id], g = grossOf(m.id);
          const upTo = new Set(orderedHoles(holes, m.start_hole).slice(0, mark).map(h => h.number));
          const pick = side => Object.fromEntries(Object.entries(g[side]).filter(([h]) => upTo.has(Number(h))));
          const st = matchState({ holes, grossA: pick('A'), grossB: pick('B'),
            aStrokes: c.strokeMap.aStrokes, bStrokes: c.strokeMap.bStrokes, startHole: m.start_hole });
          const [pa, pb] = standing(c, st);
          ra += pa; rb += pb;
        }
        // Cup if this round ends as it stands: other rounds' points so far plus this projection.
        let ca = ra, cb = rb, others = 0;
        for (const m of matches) {
          const c = ctxById[m.id];
          if (m.round_id === r.id || !c?.teamAId || !c?.teamBId) continue;
          const [pa, pb] = c.teamAId === teamA.id ? [c.state.pointsA, c.state.pointsB] : [c.state.pointsB, c.state.pointsA];
          ca += pa; cb += pb; others += pa + pb;
        }
        const roundText = ra > rb ? `${teamA.name} leads ${pts(ra)}–${pts(rb)}`
          : rb > ra ? `${teamB.name} leads ${pts(rb)}–${pts(ra)}`
          : `All square ${pts(ra)}–${pts(rb)}`;
        const cupText = ca > cb ? `${teamA.name} ${pts(ca)}–${pts(cb)}`
          : cb > ca ? `${teamB.name} ${pts(cb)}–${pts(ca)}`
          : `all square ${pts(ca)}–${pts(cb)}`;
        projections.push({ key: `projection:${r.id}:${mark}`, kind: 'projection', sig: `${ra}-${rb}:${ca}-${cb}`,
          body: `📊 ${r.name} thru ${mark}: ${roundText} as it stands` + (others ? ` · Cup projection: ${cupText}` : '') });
      }
    }

    // Round complete: every planned match in it is decided.
    if (allSet && inRound.every(m => ctxById[m.id]?.state.decided)) {
      let ra = 0, rb = 0;
      for (const m of inRound) {
        const c = ctxById[m.id];
        const [pa, pb] = c.teamAId === teamA.id ? [c.state.pointsA, c.state.pointsB] : [c.state.pointsB, c.state.pointsA];
        ra += pa; rb += pb;
      }
      const roundText = ra > rb ? `${teamA.name} takes the round ${pts(ra)}–${pts(rb)}`
        : rb > ra ? `${teamB.name} takes the round ${pts(rb)}–${pts(ra)}`
        : `Round split ${pts(ra)}–${pts(rb)}`;
      roundsDone.push({ key: `round:${r.id}`, kind: 'round', sig: `${ra}-${rb}`,
        body: `✅ ${r.name} complete. ${roundText} · ${scoreLine}` });
    }
  }

  for (const m of matches) {
    const c = ctxById[m.id];
    if (!c || !c.teamAId || !c.teamBId) continue;
    const sidePlayers = { A: m.side_a_players, B: m.side_b_players };

    // Hole-in-one / eagle or better (gross). Only once both sides have a score on the hole,
    // so a half-typed number on one side doesn't announce an ace.
    const holes = courseById[roundById[m.round_id]?.course_id]?.holes || [];
    const gross = grossOf(m.id);
    for (const h of holes) {
      if (gross.A[h.number] == null || gross.B[h.number] == null) continue;
      for (const side of ['A', 'B']) {
        const g = gross[side][h.number], who = names(sidePlayers[side]);
        const key = `${m.id}:${side}:${h.number}`;
        if (g === 1) {
          shots.push({ key: `ace:${key}`, kind: 'ace', sig: '1', body: `🎯 ACE! ${who} on #${h.number}` });
        } else if (g <= h.par - 2) {
          const label = h.par - g >= 3 ? 'Albatross' : 'Eagle';
          shots.push({ key: `eagle:${key}`, kind: 'eagle', sig: String(g),
            body: `🦅 ${label} for ${who} on #${h.number} (${g} on a par ${h.par})` });
        }
      }
    }

    // Match final.
    const st = c.state;
    if (!st.decided) continue;
    let body, margin = '';
    if (st.final === 'half') {
      body = `🤝 ${names(m.side_a_players)} and ${names(m.side_b_players)} halve their match · ${scoreLine}`;
    } else {
      const win = st.final, lose = win === 'A' ? 'B' : 'A';
      const winTeam = teamsById[win === 'A' ? c.teamAId : c.teamBId]?.name;
      margin = (st.status.match(/wins (.+)$/) || [])[1] || '';
      const verb = sidePlayers[win].length > 1 ? 'win' : 'wins';
      body = `🏆 ${names(sidePlayers[win])} (${winTeam}) ${verb} ${margin} over ${names(sidePlayers[lose])} · ${scoreLine}`;
    }
    finals.push({ key: `final:${m.id}`, kind: 'final', sig: `${st.final}:${margin}`, body });
  }

  // Cup result: only once every match in the tournament is played out, including matches
  // not built yet. Most points wins; level is a tied Cup.
  const done = plannedTotal && matches.length >= plannedTotal
    && matches.every(m => ctxById[m.id]?.teamAId && ctxById[m.id]?.teamBId && ctxById[m.id].state.decided);
  if (done) {
    const winner = a > b ? teamA : b > a ? teamB : null;
    clinch.push({ key: 'clinch', kind: 'clinch', sig: winner?.id || 'tie',
      body: winner ? `🏆🏆 ${winner.name} wins the Cup ${pts(Math.max(a, b))}–${pts(Math.min(a, b))}!`
        : `🤝 The Cup is tied ${pts(a)}–${pts(b)}!` });
  }

  // Posting order = the order they show up in chat.
  return [...draft, ...pairings, ...shots, ...projections, ...finals, ...roundsDone, ...clinch];
}

// What to send to post_auto_message to bring the stored posts (rows with auto_key, auto_sig,
// kind, retracted) in line with desiredPosts().
export function planAutoOps(desired, existing) {
  const byKey = Object.fromEntries(existing.map(e => [e.auto_key, e]));
  const wanted = new Set(desired.map(d => d.key));
  const ops = desired
    .filter(d => { const e = byKey[d.key]; return !e || e.retracted || e.auto_sig !== d.sig; })
    .map(d => ({ ...d, retract: false }));
  for (const e of existing) {
    if (!e.retracted && RETRACTABLE.has(e.kind) && !wanted.has(e.auto_key)) {
      ops.push({ key: e.auto_key, kind: e.kind, sig: null, body: '-', retract: true });
    }
  }
  return ops;
}

// Hash of the event's scoring state — must match event_fingerprint() in supabase/schema.sql
// line for line, so the server can tell this device's data is current.
export async function eventFingerprint({ matches, scores }) {
  const lines = [
    ...matches.map(m => ['m', m.id, m.start_hole ?? '', m.side_a_players.join(','), m.side_b_players.join(',')].join('|')),
    ...scores.map(s => ['s', s.match_id, s.side, s.hole, s.gross].join('|'))
  ].sort();
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(lines.join('\n')));
  return [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, '0')).join('');
}
