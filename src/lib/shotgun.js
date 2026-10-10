// Shotgun start: assign each match a starting hole so a round's matches play at once.
// Pure and dependency-free (like scoring.js) so it can be tested in isolation.
//
// Goal: distinct, evenly-spaced starting holes (so groups don't collide), with the FASTER
// groups (lower average handicap) placed on the HARDER holes (lower strokeIndex) so the tough
// holes clear quickly and every match finishes around the same time.

// matches: [{ id, seq, ... }]. holes: [{ number, par, strokeIndex }].
// avgHcpOf: (match) => number  (a match's average player handicap; lower = faster).
// perHole: matches sent off together from one hole (2 = singles played as foursomes).
//   Matches are grouped with their nearest neighbours in pace, so a group moves at one speed.
// Returns { [matchId]: startHoleNumber }.
export function assignStartHoles(matches, holes, avgHcpOf, perHole = 1) {
  const sortedHoles = [...(holes || [])].sort((a, b) => a.number - b.number);
  const H = sortedHoles.length;
  if (H === 0 || !(matches || []).length) return {};

  // Fastest first, then chunked into groups; chunks of a sorted list stay fastest-first.
  const matchesByFast = [...matches].sort(
    (a, b) => (avgHcpOf(a) - avgHcpOf(b)) || ((a.seq ?? 0) - (b.seq ?? 0)));
  const size = Math.max(1, perHole);
  const groups = [];
  for (let i = 0; i < matchesByFast.length; i += size) groups.push(matchesByFast.slice(i, i + size));
  const G = groups.length;

  // 1) Evenly-spaced positions around the loop (spacing wins so groups stay spread out).
  //    round(i * H / G) can occasionally collide or exceed the count when G > H — bump each
  //    to the next free slot, wrapping, so we always get G distinct holes (repeats only if G > H).
  const used = new Set();
  const positions = [];
  for (let i = 0; i < G; i++) {
    let p = Math.round((i * H) / G) % H;
    let guard = 0;
    while (used.has(p) && guard < H) { p = (p + 1) % H; guard++; }
    used.add(p);
    positions.push(p);
  }
  const candidates = positions.map(p => sortedHoles[p]);

  // 2) Pair fastest group -> hardest candidate hole.
  const holesByHard = [...candidates].sort((a, b) => a.strokeIndex - b.strokeIndex);

  const out = {};
  groups.forEach((g, i) => g.forEach(m => { out[m.id] = holesByHard[i].number; }));
  return out;
}
