import { describe, it, expect } from 'vitest';
import { planRound, pairingTable, matchValue, gradeDraft } from './optimize';

const holes = Array.from({ length: 18 }, (_, i) => ({ number: i + 1, par: 4, strokeIndex: i + 1 }));
const event = { singles_pct: 100, altshot_pct: 50, scramble_low_pct: 35, scramble_high_pct: 15, scoring_mode: 'match' };
const team = (pfx, hcps) => hcps.map((handicap, i) => ({ id: pfx + (i + 1), handicap }));

describe('matchValue', () => {
  it('is near even at full allowance and favours the scratch side at 0%', () => {
    const even = matchValue({ format: 'singles', event, holes, aHcps: [2], bHcps: [20] }).ev;
    expect(Math.abs(even - 0.5)).toBeLessThan(0.02);
    const raw = matchValue({ format: 'singles', event: { ...event, singles_pct: 0 }, holes, aHcps: [2], bHcps: [20] }).ev;
    expect(raw).toBeGreaterThan(0.8);
  });
});

describe('planRound', () => {
  const zero = { ...event, singles_pct: 0 };
  it('plays every player once and solves small rounds exactly', () => {
    const mine = team('M', [0, 10, 20, 30]), theirs = team('T', [5, 15, 25, 35]);
    const plan = planRound({ format: 'singles', event: zero, holes, mine, theirs, pickerIsMe: k => k % 2 === 0 });
    expect(plan.exact).toBe(true);
    expect(plan.matches).toBe(4);
    expect(new Set(plan.line.flatMap(m => m.mine)).size).toBe(4);
    expect(new Set(plan.line.flatMap(m => m.theirs)).size).toBe(4);
    expect(plan.decision.kind).toBe('pick');
    // options are sorted best-first and the top one is the line's first match
    expect(plan.decision.options[0].value).toBeGreaterThanOrEqual(plan.decision.options.at(-1).value);
    expect(plan.line[0].mine).toEqual(plan.decision.options[0].mine);
  });

  it('answers an opponent lock with the best available reply', () => {
    const mine = team('M', [0, 30]), theirs = team('T', [10, 12]);
    const plan = planRound({ format: 'singles', event: zero, holes, mine, theirs,
      pickerIsMe: () => false, pending: { mine: false, ids: ['T1'] } });
    expect(plan.decision.kind).toBe('respond');
    expect(plan.line[0].theirs).toEqual(['T1']);
  });

  it('handles pairs formats and falls back to the heuristic on big rounds', () => {
    const mine = team('M', [2, 6, 9, 12, 15, 18, 22, 26]), theirs = team('T', [3, 7, 10, 13, 16, 19, 21, 28]);
    const plan = planRound({ format: 'scramble', event, holes, mine, theirs, pickerIsMe: k => k % 2 === 1 });
    expect(plan.matches).toBe(4);
    expect(plan.line.every(m => m.mine.length === 2 && m.theirs.length === 2)).toBe(true);
    expect(plan.decision.kind).toBe('await');
    const big = planRound({ format: 'scramble', event, holes, mine: team('M', [...Array(14)].map((_, i) => i * 2)),
      theirs: team('T', [...Array(14)].map((_, i) => i * 2 + 1)), pickerIsMe: k => k % 2 === 0 });
    expect(big.matches).toBe(7);
    expect(big.exact).toBe(false);
  });

  it('builds a cheat sheet sorted by average value', () => {
    const rows = pairingTable({ format: 'singles', event: zero, holes, mine: team('M', [0, 20]), theirs: team('T', [10]) });
    expect(rows[0].mine).toEqual(['M1']);
  });
});

describe('gradeDraft', () => {
  const zero = { ...event, singles_pct: 0 };
  const A = team('A', [0, 10, 20, 30]), B = team('B', [5, 15, 25, 35]);
  const m = (a, b) => ({ side_a_players: a, side_b_players: b });

  it('gives a perfect grade to the optimal line', () => {
    const plan = planRound({ format: 'singles', event: zero, holes, mine: A, theirs: B, pickerIsMe: k => k % 2 === 0 });
    const g = gradeDraft({ format: 'singles', event: zero, holes, teamA: A, teamB: B,
      matches: plan.line.map(x => m(x.mine, x.theirs)), firstIdx: 0 });
    expect(g.graded).toBe(4);
    expect(g.A.lost).toBeLessThan(1e-9);
    expect(g.B.lost).toBeLessThan(1e-9);
    expect(g.A.grade).toBe('A+');
    expect(g.actual).toBeCloseTo(g.optimal, 9);
  });

  it('charges a bad answer to the team that made it', () => {
    // A sends its scratch player first; B answers with its worst instead of conceding cheaply.
    const g = gradeDraft({ format: 'singles', event: zero, holes, teamA: A, teamB: B,
      matches: [m(['A1'], ['B4'])], firstIdx: 0 });
    const first = g.picks[0];
    expect(first.picker).toBe('A');
    expect(first.replyLoss).toBeGreaterThanOrEqual(0);
    expect(g.B.lost).toBeCloseTo(first.replyLoss, 9);
    expect(g.A.lost).toBeCloseTo(first.pickLoss, 9);
  });

  it('skips matches that do not fit the draft', () => {
    const g = gradeDraft({ format: 'singles', event: zero, holes, teamA: A, teamB: B,
      matches: [m(['A1', 'A2'], ['B1'])], firstIdx: 0 });
    expect(g.picks[0].skipped).toBe(true);
    expect(g.graded).toBe(0);
  });
});
