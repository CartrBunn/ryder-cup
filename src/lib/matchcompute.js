// Glue between stored rows and the pure scoring engine.
import { sideHandicap } from './handicap';
import { matchStrokeMap, matchState } from './scoring';
import { winProbability } from './winprob';

function ruleFor(format, event) {
  if (format === 'singles') return { type: 'each', pct: event.singles_pct };
  if (format === 'alternate_shot') return { type: 'combined', pct: event.altshot_pct };
  return { type: 'weighted', low: event.scramble_low_pct, high: event.scramble_high_pct };
}

// Same combine shape but at full (100%) allowance — a raw measure of a side's skill,
// independent of the event's stroke-allowance settings. Used only by the predictor,
// so it still reads the handicaps even when allowances are dialed down to 0.
function skillRuleFor(format) {
  if (format === 'singles') return { type: 'each', pct: 100 };
  if (format === 'alternate_shot') return { type: 'combined', pct: 100 };
  return { type: 'weighted', low: 100, high: 100 };
}

// scores: array of hole_scores rows for this match. profilesById: { id: profile }.
export function computeMatch({ match, round, course, event, profilesById, scores }) {
  const holes = course?.holes || [];
  const rule = ruleFor(round.format, event);

  const hcpOf = ids => ids.map(id => Number(profilesById[id]?.handicap ?? 0));
  const aHcp = sideHandicap(hcpOf(match.side_a_players), rule);
  const bHcp = sideHandicap(hcpOf(match.side_b_players), rule);
  const sm = matchStrokeMap(aHcp, bHcp, holes);

  // Raw skill gap (full handicaps, allowance-independent) drives the predictor's
  // edge; the allowance-based strokes above only decide how much of it is neutralized.
  const skillRule = skillRuleFor(round.format);
  const skillDiff = sideHandicap(hcpOf(match.side_a_players), skillRule)
    - sideHandicap(hcpOf(match.side_b_players), skillRule);

  const grossA = {}, grossB = {};
  (scores || []).forEach(s => { (s.side === 'A' ? grossA : grossB)[s.hole] = s.gross; });

  const state = matchState({ holes, grossA, grossB, aStrokes: sm.aStrokes, bStrokes: sm.bStrokes,
    startHole: match.start_hole });

  const winProb = winProbability({ up: state.up, played: state.played,
    holesCount: holes.length, aHcp, bHcp, skillDiff, strokeMap: sm });

  const teamAId = profilesById[match.side_a_players[0]]?.team_id || null;
  const teamBId = profilesById[match.side_b_players[0]]?.team_id || null;
  return { state, strokeMap: sm, aHcp, bHcp, winProb, teamAId, teamBId };
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

// Roll per-match win probabilities into a cup outcome for the leaderboard.
// Everything is expressed for `refTeamId` (pass the left/Team-A team id); each match
// is flipped so its side facing the reference team is scored consistently.
// Returns the chance the reference team (pCupA), a tie, and the other team (pCupB)
// take the cup, plus projected final points for each side.
// { pCupA, pTie, pCupB, projA, projB, matches }
export function tournamentWinProbability(matches, ctxById, refTeamId) {
  // Distribution of the reference team's total, in half-points so it stays integer.
  // Each match adds 2 (ref wins), 1 (halve), or 0 half-points.
  let dist = [1];   // 0 half-points, probability 1
  let counted = 0, projA = 0;

  for (const m of matches) {
    const c = ctxById[m.id];
    if (!c || !c.teamAId || !c.teamBId) continue;   // skip unassigned matchups
    // Orient the match so pWin is the reference team's chance to win it.
    const refIsSideA = c.teamAId === refTeamId;
    const pWin = refIsSideA ? c.winProb.pA : c.winProb.pB;
    const pHalf = c.winProb.pHalf;
    const pLoss = refIsSideA ? c.winProb.pB : c.winProb.pA;
    counted += 1;
    projA += pWin * 1 + pHalf * 0.5;

    const next = new Array(dist.length + 2).fill(0);
    for (let i = 0; i < dist.length; i++) {
      const p = dist[i];
      if (!p) continue;
      next[i + 2] += p * pWin;    // +2 half-points
      next[i + 1] += p * pHalf;   // +1 half-point
      next[i]     += p * pLoss;   // +0
    }
    dist = next;
  }

  if (counted === 0) return { pCupA: 0, pTie: 0, pCupB: 0, projA: 0, projB: 0, matches: 0 };

  const half = counted;   // half of 2*counted half-points
  let pCupA = 0, pTie = 0, pCupB = 0;
  for (let i = 0; i < dist.length; i++) {
    if (i > half) pCupA += dist[i];
    else if (i < half) pCupB += dist[i];
    else pTie += dist[i];
  }
  return { pCupA, pTie, pCupB, projA, projB: counted - projA, matches: counted };
}
