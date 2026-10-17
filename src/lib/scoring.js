// Pure scoring engine (match play and stroke play). No React, no Supabase — just data in, result out.
// This is the heart of the app and is deliberately dependency-free so it can be tested.

// course holes: [{ number, par, strokeIndex }] (typically 18)
// A "match" has two sides (A and B). Strokes go to the HIGHER-handicap side, by stroke index.

// Given whole strokes to give and the course, return { holeNumber: strokesReceived }.
export function allocateStrokes(strokesToGive, holes) {
  const strokes = {};
  holes.forEach(h => { strokes[h.number] = 0; });
  const total = Math.round(Math.abs(strokesToGive));
  if (total <= 0) return strokes;

  const byIndex = [...holes].sort((a, b) => a.strokeIndex - b.strokeIndex);
  const n = byIndex.length || 18;
  for (let i = 0; i < total; i++) {
    strokes[byIndex[i % n].number] += 1;   // wrap for handicaps above the hole count
  }
  return strokes;
}

// Decide which side receives strokes and how many per hole, from the two side handicaps.
export function matchStrokeMap(sideAHcp, sideBHcp, holes) {
  const diff = round1(sideAHcp - sideBHcp);
  const zero = {}; holes.forEach(h => { zero[h.number] = 0; });
  if (diff === 0) return { receiver: null, diff: 0, strokes: 0, aStrokes: zero, bStrokes: zero };
  const receiver = diff > 0 ? 'A' : 'B';         // higher handicap receives
  const alloc = allocateStrokes(diff, holes);
  // Whole strokes actually given — rounded on the magnitude, same as allocateStrokes, so a
  // -2.5 gap is 3 strokes (Math.round(-2.5) would say 2).
  const strokes = Math.round(Math.abs(diff));
  return {
    receiver, diff, strokes,
    aStrokes: receiver === 'A' ? alloc : zero,
    bStrokes: receiver === 'B' ? alloc : zero
  };
}

// Holes in play order for a match: hole numbers, but rotated so a shotgun `startHole` comes
// first and the rest wrap around (…startHole, startHole+1, … , wrap to 1 … startHole-1).
// null / not-found → natural order starting at the lowest number.
export function orderedHoles(holes, startHole) {
  const sorted = [...holes].sort((a, b) => a.number - b.number);
  if (!startHole) return sorted;
  const idx = sorted.findIndex(h => h.number === startHole);
  if (idx <= 0) return sorted;
  return [...sorted.slice(idx), ...sorted.slice(0, idx)];
}

// grossA / grossB: { holeNumber: strokes }. Scores are read in play order; the first hole
// missing a score stops the tally (that's "thru"), so live entry works hole by hole.
// startHole rotates the play order for a shotgun start (default: begin at the lowest hole).
export function matchState({ holes, grossA, grossB, aStrokes, bStrokes, startHole, nameA = 'A', nameB = 'B' }) {
  const ordered = orderedHoles(holes, startHole);
  const results = ordered.map(h => ({ hole: h.number, winner: null, netA: null, netB: null }));
  const resultAt = num => results.find(r => r.hole === num);

  let up = 0, played = 0;
  let closed = false, closeMargin = 0, closeRemaining = 0;

  for (const h of ordered) {
    const gA = grossA?.[h.number];
    const gB = grossB?.[h.number];
    if (gA == null || gB == null) break;          // stop at first unentered hole

    const netA = gA - (aStrokes?.[h.number] || 0);
    const netB = gB - (bStrokes?.[h.number] || 0);
    let winner = 'half';
    if (netA < netB) { winner = 'A'; up += 1; }
    else if (netB < netA) { winner = 'B'; up -= 1; }

    const r = resultAt(h.number);
    r.winner = winner; r.netA = netA; r.netB = netB;
    played += 1;

    const remainingAfter = holes.length - played;
    if (Math.abs(up) > remainingAfter) {          // match decided — freeze here
      closed = true; closeMargin = Math.abs(up); closeRemaining = remainingAfter;
      break;
    }
  }

  const wentToEnd = holes.length > 0 && played === holes.length;   // no course → never "finished"
  const decided = closed || wentToEnd;
  const who = up > 0 ? nameA : nameB;

  let status;
  if (played === 0) status = 'Not started';
  else if (closed) status = closeRemaining > 0 ? `${who} wins ${closeMargin}&${closeRemaining}` : `${who} wins ${closeMargin} up`;
  else if (up === 0) status = wentToEnd ? 'Match halved' : `All square thru ${played}`;
  else status = wentToEnd ? `${who} wins ${Math.abs(up)} up` : `${who} ${Math.abs(up)} up thru ${played}`;

  let pointsA = 0, pointsB = 0, final = null;
  if (decided) {
    if (up > 0) { pointsA = 1; final = 'A'; }
    else if (up < 0) { pointsB = 1; final = 'B'; }
    else { pointsA = 0.5; pointsB = 0.5; final = 'half'; }
  }

  return { results, up, played, closed, decided, status, pointsA, pointsB, final };
}

// Stroke play: every hole is played and the lower net total takes the match. Same inputs and
// result shape as matchState, so the rest of the app doesn't care which one ran. `up` is the
// running net-stroke lead (A ahead > 0); a hole's `winner` is still who was lower on it.
export function strokePlayState({ holes, grossA, grossB, aStrokes, bStrokes, startHole, nameA = 'A', nameB = 'B' }) {
  const ordered = orderedHoles(holes, startHole);
  const results = ordered.map(h => ({ hole: h.number, winner: null, netA: null, netB: null }));
  const resultAt = num => results.find(r => r.hole === num);

  let totalA = 0, totalB = 0, played = 0;
  for (const h of ordered) {
    const gA = grossA?.[h.number];
    const gB = grossB?.[h.number];
    if (gA == null || gB == null) break;          // stop at first unentered hole

    const netA = gA - (aStrokes?.[h.number] || 0);
    const netB = gB - (bStrokes?.[h.number] || 0);
    const r = resultAt(h.number);
    r.winner = netA < netB ? 'A' : netB < netA ? 'B' : 'half';
    r.netA = netA; r.netB = netB;
    totalA += netA; totalB += netB;
    played += 1;
  }

  const up = totalB - totalA;
  const decided = holes.length > 0 && played === holes.length;   // no course → never "finished"
  const who = up > 0 ? nameA : nameB;
  const lead = Math.abs(up);

  let status;
  if (played === 0) status = 'Not started';
  else if (decided) status = up === 0 ? `Match tied (net ${totalA})`
    : `${who} wins by ${lead} (net ${Math.min(totalA, totalB)}–${Math.max(totalA, totalB)})`;
  else status = up === 0 ? `All square thru ${played}` : `${who} leads by ${lead} thru ${played}`;

  let pointsA = 0, pointsB = 0, final = null;
  if (decided) {
    if (up > 0) { pointsA = 1; final = 'A'; }
    else if (up < 0) { pointsB = 1; final = 'B'; }
    else { pointsA = 0.5; pointsB = 0.5; final = 'half'; }
  }

  return { results, up, played, closed: false, decided, status, pointsA, pointsB, final, totalA, totalB };
}

// The event's scoring mode picks the engine: 'stroke' or match play (the default).
export function scoreMatch(mode, args) {
  return mode === 'stroke' ? strokePlayState(args) : matchState(args);
}

function round1(n) { return Math.round(n * 10) / 10; }
