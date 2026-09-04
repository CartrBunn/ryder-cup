// Glue between stored rows and the pure scoring engine.
import { sideHandicap } from './handicap';
import { matchStrokeMap, matchState } from './scoring';

function ruleFor(format, event) {
  if (format === 'singles') return { type: 'each', pct: event.singles_pct };
  if (format === 'alternate_shot') return { type: 'combined', pct: event.altshot_pct };
  return { type: 'weighted', low: event.scramble_low_pct, high: event.scramble_high_pct };
}

// scores: array of hole_scores rows for this match. profilesById: { id: profile }.
export function computeMatch({ match, round, course, event, profilesById, scores }) {
  const holes = course?.holes || [];
  const rule = ruleFor(round.format, event);

  const hcpOf = ids => ids.map(id => Number(profilesById[id]?.handicap ?? 0));
  const aHcp = sideHandicap(hcpOf(match.side_a_players), rule);
  const bHcp = sideHandicap(hcpOf(match.side_b_players), rule);
  const sm = matchStrokeMap(aHcp, bHcp, holes);

  const grossA = {}, grossB = {};
  (scores || []).forEach(s => { (s.side === 'A' ? grossA : grossB)[s.hole] = s.gross; });

  const state = matchState({ holes, grossA, grossB, aStrokes: sm.aStrokes, bStrokes: sm.bStrokes,
    startHole: match.start_hole });

  const teamAId = profilesById[match.side_a_players[0]]?.team_id || null;
  const teamBId = profilesById[match.side_b_players[0]]?.team_id || null;
  return { state, strokeMap: sm, aHcp, bHcp, teamAId, teamBId };
}

// Roll all matches into team totals. Returns { [teamId]: points }.
export function tournamentTotals(matches, ctxById) {
  const totals = {};
  for (const m of matches) {
    const c = ctxById[m.id];
    if (!c) continue;
    if (c.teamAId) totals[c.teamAId] = (totals[c.teamAId] || 0) + c.state.pointsA;
    if (c.teamBId) totals[c.teamBId] = (totals[c.teamBId] || 0) + c.state.pointsB;
  }
  return totals;
}
