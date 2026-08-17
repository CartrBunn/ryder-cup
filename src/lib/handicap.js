// Handicap allowances by format.
// All percentages are configurable per-event in Admin setup; these are the defaults.
// A "side" is one competitor: a single player (singles) or a pair (scramble / alternate shot).

export const DEFAULT_ALLOWANCES = {
  singles: { type: 'each', pct: 100 },              // 100% of each player's handicap
  alternate_shot: { type: 'combined', pct: 50 },    // 50% of the pair's combined handicaps
  scramble: { type: 'weighted', low: 35, high: 15 } // 35% of low handicap + 15% of high
};

// Returns the playing handicap for one side, given its members' handicaps and the format rule.
export function sideHandicap(memberHandicaps, rule) {
  const hs = memberHandicaps.map(Number).filter(n => !Number.isNaN(n));
  if (hs.length === 0) return 0;

  if (rule.type === 'each') {
    // singles: exactly one member
    return round1(hs[0] * (rule.pct / 100));
  }
  if (rule.type === 'combined') {
    const sum = hs.reduce((a, b) => a + b, 0);
    return round1(sum * (rule.pct / 100));
  }
  if (rule.type === 'weighted') {
    const sorted = [...hs].sort((a, b) => a - b);
    const low = sorted[0] ?? 0;
    const high = sorted[sorted.length - 1] ?? 0;
    return round1(low * (rule.low / 100) + high * (rule.high / 100));
  }
  return round1(hs.reduce((a, b) => a + b, 0));
}

function round1(n) { return Math.round(n * 10) / 10; }
