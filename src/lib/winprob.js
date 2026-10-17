// Win-probability model. Pure and dependency-free, like scoring.js / handicap.js.
// Data in (current lead + handicaps + progress) → { pA, pHalf, pB } out.
//
// Idea: model each remaining hole as an independent three-way outcome (A wins /
// halve / B wins) and convolve them onto the current lead. The per-hole edge is the
// raw skill gap between the sides MINUS the strokes actually given to compensate —
// so at 100% allowance the gap is fully neutralized (near-even), and at a lower
// allowance (down to 0%) the leftover skill gap keeps favoring the better side.

const BASE_HALF = 0.42;   // typical single-hole halve rate in an even match
const K = 1.5;            // how sharply a per-hole scoring edge tilts the split

const HOLE_SD = 1.4;      // stroke play: spread of one hole's net difference between the sides

function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

// Standard normal CDF (Abramowitz–Stegun erf approximation, plenty for a win %).
function normCdf(z) {
  const x = Math.abs(z) / Math.SQRT2, t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

// Per-match outcome distribution.
//   up        signed current lead (A ahead > 0, B ahead < 0), from matchState
//   played    holes completed ("thru")
//   holesCount total holes on the course (e.g. 18)
//   aHcp/bHcp playing handicaps for the two sides (fallback skill gap)
//   skillDiff raw (allowance-independent) handicap gap A − B; drives the edge
//   strokeMap { receiver, diff, ... } from matchStrokeMap (strokes actually given)
//   mode      'stroke' → `up` is a net-stroke lead and every hole is played out;
//             anything else is match play (`up` in holes)
export function winProbability({ up = 0, played = 0, holesCount = 18, aHcp = 0, bHcp = 0, skillDiff, strokeMap, mode }) {
  const remaining = Math.max(0, holesCount - played);

  // Match already over, or mathematically clinched — collapse to the certain result.
  // (Stroke play is never clinched early: one bad hole can swing any lead.)
  if (remaining <= 0 || (mode !== 'stroke' && Math.abs(up) > remaining)) {
    if (up > 0) return { pA: 1, pHalf: 0, pB: 0 };
    if (up < 0) return { pA: 0, pHalf: 0, pB: 1 };
    return { pA: 0, pHalf: 1, pB: 0 };
  }

  // Average per-hole net edge (E[netA - netB]), negative favors A. Start from the raw
  // skill gap (positive = A the weaker/higher-handicap side) and subtract the strokes
  // actually given — which go to the higher-PLAYING-handicap side. Whatever the
  // allowance leaves uncompensated is the real edge; a 0% allowance leaves it all.
  const gap = skillDiff ?? (aHcp - bHcp);
  const receiverSign = strokeMap?.receiver === 'A' ? 1 : strokeMap?.receiver === 'B' ? -1 : 0;
  const strokesGiven = strokeMap?.strokes ?? Math.round(Math.abs(strokeMap?.diff ?? 0));
  const avgEdge = (gap - receiverSign * strokesGiven) / (holesCount || 18);

  // Stroke play: the final lead is the current one plus `remaining` independent hole
  // differences (mean −avgEdge for A, spread HOLE_SD each) — close enough to normal.
  // Totals are whole strokes, so a final lead inside ±½ is a tie.
  if (mode === 'stroke') {
    const mean = up - avgEdge * remaining, sd = HOLE_SD * Math.sqrt(remaining);
    const pA = 1 - normCdf((0.5 - mean) / sd);
    const pB = normCdf((-0.5 - mean) / sd);
    return { pA, pHalf: Math.max(0, 1 - pA - pB), pB };
  }

  // Per-hole three-way split.
  const pHalfHole = BASE_HALF;
  const pAHole = (1 - pHalfHole) * sigmoid(-K * avgEdge);
  const pBHole = (1 - pHalfHole) - pAHole;

  // Convolve `remaining` holes onto the current margin. Index margins by an offset
  // so negatives are valid array slots: margin ∈ [up - remaining, up + remaining].
  const offset = remaining - up;
  const size = 2 * remaining + 1;
  let dist = new Array(size).fill(0);
  dist[up + offset] = 1;   // start at the current lead
  for (let h = 0; h < remaining; h++) {
    const next = new Array(size).fill(0);
    for (let i = 0; i < size; i++) {
      const p = dist[i];
      if (!p) continue;
      next[i + 1] += p * pAHole;    // A wins the hole → margin +1
      next[i]     += p * pHalfHole; // halve → unchanged
      next[i - 1] += p * pBHole;    // B wins the hole → margin -1
    }
    dist = next;
  }

  let pA = 0, pHalf = 0, pB = 0;
  for (let i = 0; i < size; i++) {
    const margin = i - offset;
    if (margin > 0) pA += dist[i];
    else if (margin < 0) pB += dist[i];
    else pHalf += dist[i];
  }
  return { pA, pHalf, pB };
}
