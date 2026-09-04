// Win-probability model. Pure and dependency-free, like scoring.js / handicap.js.
// Data in (current lead + handicaps + progress) → { pA, pHalf, pB } out.
//
// Idea: the app already gives net-of-difference strokes so the two sides are, by
// design, near-even per hole. We model each remaining hole as an independent
// three-way outcome (A wins / halve / B wins) and convolve them onto the current
// lead. The small residual left after whole-stroke allocation is the handicap edge.

const BASE_HALF = 0.42;   // typical single-hole halve rate in an even match
const K = 1.5;            // how sharply a per-hole scoring edge tilts the split

function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

// Per-match outcome distribution.
//   up        signed current lead (A ahead > 0, B ahead < 0), from matchState
//   played    holes completed ("thru")
//   holesCount total holes on the course (e.g. 18)
//   aHcp/bHcp playing handicaps for the two sides
//   strokeMap { receiver, diff, ... } from matchStrokeMap (for the residual edge)
export function winProbability({ up = 0, played = 0, holesCount = 18, aHcp = 0, bHcp = 0, strokeMap }) {
  const remaining = Math.max(0, holesCount - played);

  // Match already over, or mathematically clinched — collapse to the certain result.
  if (remaining <= 0 || Math.abs(up) > remaining) {
    if (up > 0) return { pA: 1, pHalf: 0, pB: 0 };
    if (up < 0) return { pA: 0, pHalf: 0, pB: 1 };
    return { pA: 0, pHalf: 1, pB: 0 };
  }

  // Average per-hole net edge (E[netA - netB]). Whole strokes already even the
  // sides; what's left is the fractional residual, so the lower-handicap side keeps
  // a hair of an edge. Negative avgEdge favors A (lower net = wins the hole).
  const receiverSign = strokeMap?.receiver === 'A' ? 1 : strokeMap?.receiver === 'B' ? -1 : 0;
  const roundedDiff = Math.abs(Math.round(strokeMap?.diff ?? (aHcp - bHcp)));
  const avgEdge = ((aHcp - bHcp) - receiverSign * roundedDiff) / (holesCount || 18);

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
