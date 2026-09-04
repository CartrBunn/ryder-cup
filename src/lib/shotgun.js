// Shotgun start: assign each match a starting hole so a round's matches play at once.
// Pure and dependency-free (like scoring.js) so it can be tested in isolation.
//
// Goal: distinct, evenly-spaced starting holes (so groups don't collide), with the FASTER
// groups (lower average handicap) placed on the HARDER holes (lower strokeIndex) so the tough
// holes clear quickly and every match finishes around the same time.

// matches: [{ id, seq, ... }]. holes: [{ number, par, strokeIndex }].
// avgHcpOf: (match) => number  (a match's average player handicap; lower = faster).
// Returns { [matchId]: startHoleNumber }.
export function assignStartHoles(matches, holes, avgHcpOf) {
  const sortedHoles = [...(holes || [])].sort((a, b) => a.number - b.number);
  const H = sortedHoles.length;
  const M = (matches || []).length;
  if (H === 0 || M === 0) return {};

  // 1) Evenly-spaced positions around the loop (spacing wins so groups stay spread out).
  //    round(i * H / M) can occasionally collide or exceed the count when M > H — bump each
  //    to the next free slot, wrapping, so we always get M distinct holes (repeats only if M > H).
  const used = new Set();
  const positions = [];
  for (let i = 0; i < M; i++) {
    let p = Math.round((i * H) / M) % H;
    let guard = 0;
    while (used.has(p) && guard < H) { p = (p + 1) % H; guard++; }
    used.add(p);
    positions.push(p);
  }
  const candidates = positions.map(p => sortedHoles[p]);

  // 2) Pair fastest match -> hardest candidate hole.
  const holesByHard = [...candidates].sort((a, b) => a.strokeIndex - b.strokeIndex);
  const matchesByFast = [...matches].sort(
    (a, b) => (avgHcpOf(a) - avgHcpOf(b)) || ((a.seq ?? 0) - (b.seq ?? 0)));

  const out = {};
  matchesByFast.forEach((m, i) => { out[m.id] = holesByHard[i].number; });
  return out;
}
