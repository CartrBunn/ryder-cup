// Matchup optimizer for one round's snake draft. Pure and dependency-free, like scoring.js.
//
// The draft is a two-player game: for each match the picking team sends a unit (one player,
// or a pair) and the other team answers with theirs. Every pairing is priced with the same
// pre-match win-probability model the leaderboard uses, as "my" expected points
// (win = 1, halve = ½). We then solve the game by minimax: the team picking first assumes
// the best reply, the replying team takes the best answer, and both play on optimally.
// Rounds too big to solve exactly fall back to a one-move lookahead whose tail is the
// average value of the players each side has left.
import { sideHandicap } from './handicap';
import { matchStrokeMap } from './scoring';
import { winProbability } from './winprob';
import { ruleFor, skillRuleFor } from './matchcompute';

const BUDGET = 15_000_000;  // pairings examined before giving up on the exact solve
const MAX_SIDE = 15;        // players per side that fit in the bitmask keys
const OVER = Symbol('over-budget');

const popcount = m => { let c = 0; while (m) { m &= m - 1; c++; } return c; };
const bitsOf = m => { const out = []; for (let i = 0; m; i++, m >>>= 1) if (m & 1) out.push(i); return out; };

// Every sub-mask of `mask` with exactly `size` bits set.
function unitsOf(mask, size) {
  const bits = bitsOf(mask), out = [];
  const walk = (start, acc, left) => {
    if (!left) { out.push(acc); return; }
    for (let i = start; i <= bits.length - left; i++) walk(i + 1, acc | (1 << bits[i]), left - 1);
  };
  walk(0, 0, size);
  return out;
}

// Expected points for side A in a fresh (unplayed) match, given each side's raw handicaps.
export function matchValue({ format, event, holes, aHcps, bHcps }) {
  const rule = ruleFor(format, event), skill = skillRuleFor(format);
  const aHcp = sideHandicap(aHcps, rule), bHcp = sideHandicap(bHcps, rule);
  const strokeMap = matchStrokeMap(aHcp, bHcp, holes);
  const skillDiff = sideHandicap(aHcps, skill) - sideHandicap(bHcps, skill);
  const p = winProbability({ up: 0, played: 0, holesCount: holes.length || 18,
    aHcp, bHcp, skillDiff, strokeMap, mode: event.scoring_mode });
  return { ev: p.pA + p.pHalf / 2, ...p, aHcp, bHcp, strokes: strokeMap.strokes, receiver: strokeMap.receiver };
}

// mine / theirs: players still to be placed, [{ id, handicap }].
// pickerIsMe(k): whether my team picks first in the round's k-th match (0-based, counting
//   matches already made — pass matchesMade as `startK`).
// pending: the picker's locked-in unit, { mine: bool, ids: [...] } or null.
export function planRound({ format, event, holes = [], mine, theirs, pickerIsMe, startK = 0, pending = null }) {
  const n = format === 'singles' ? 1 : 2;
  mine = mine.slice(0, MAX_SIDE); theirs = theirs.slice(0, MAX_SIDE);
  const full = arr => (1 << arr.length) - 1;
  const idsOf = (arr, mask) => bitsOf(mask).map(i => arr[i].id);
  const maskOf = (arr, ids) => ids.reduce((m, id) => m | (1 << arr.findIndex(p => p.id === id)), 0);
  const startMy = full(mine), startOpp = full(theirs);
  // A lock naming players who aren't available any more is stale — ignore it.
  if (pending && !pending.ids.every(id => (pending.mine ? mine : theirs).some(p => p.id === id))) pending = null;

  const evCache = new Map();
  const ev = (u, v) => {
    const key = u * 65536 + v;
    let x = evCache.get(key);
    if (x === undefined) {
      x = matchValue({ format, event, holes,
        aHcps: bitsOf(u).map(i => Number(mine[i].handicap) || 0),
        bHcps: bitsOf(v).map(i => Number(theirs[i].handicap) || 0) }).ev;
      evCache.set(key, x);
    }
    return x;
  };
  // Matches already made in this round's search state, recovered from how many are left.
  const kOf = my => startK + Math.round((mine.length - popcount(my)) / n);
  const sizes = (my, opp) => [Math.min(n, popcount(my)), Math.min(n, popcount(opp))];

  // Exact game value of a state (my expected points from here on), memoised on the masks.
  let work = 0;
  const memo = new Map();
  function exact(my, opp) {
    if (!my || !opp) return 0;
    const key = my * 65536 + opp;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    const [sm, so] = sizes(my, opp);
    const um = unitsOf(my, sm), uo = unitsOf(opp, so);
    if ((work += um.length * uo.length) > BUDGET) throw OVER;
    const meFirst = pickerIsMe(kOf(my));
    let best = meFirst ? -Infinity : Infinity;
    for (const a of meFirst ? um : uo) {
      let reply = meFirst ? Infinity : -Infinity;
      for (const b of meFirst ? uo : um) {
        const [u, v] = meFirst ? [a, b] : [b, a];
        const x = ev(u, v) + exact(my ^ u, opp ^ v);
        reply = meFirst ? Math.min(reply, x) : Math.max(reply, x);
      }
      best = meFirst ? Math.max(best, reply) : Math.min(best, reply);
    }
    memo.set(key, best);
    return best;
  }

  // Heuristic tail: matches left × the average value of every pairing still possible.
  const tailMemo = new Map();
  function tail(my, opp) {
    if (!my || !opp) return 0;
    const key = my * 65536 + opp;
    const hit = tailMemo.get(key);
    if (hit !== undefined) return hit;
    const [sm, so] = sizes(my, opp);
    const um = unitsOf(my, sm), uo = unitsOf(opp, so);
    let sum = 0;
    for (const u of um) for (const v of uo) sum += ev(u, v);
    const matchesLeft = Math.min(Math.ceil(popcount(my) / n), Math.ceil(popcount(opp) / n));
    const x = matchesLeft * sum / (um.length * uo.length);
    tailMemo.set(key, x);
    return x;
  }

  let isExact = true, V = exact;
  try { exact(startMy, startOpp); }
  catch (e) {
    if (e !== OVER) throw e;
    isExact = false; V = tail; memo.clear();
  }
  // The value of playing u against v from this state.
  const after = (my, opp, u, v) => ev(u, v) + V(my ^ u, opp ^ v);

  // Best reply to a locked unit: mine to theirs (maximise) or theirs to mine (minimise).
  const myReplies = (my, opp, v) => unitsOf(my, sizes(my, opp)[0])
    .map(u => ({ u, v, ev: ev(u, v), value: after(my, opp, u, v) })).sort((x, y) => y.value - x.value);
  const theirReplies = (my, opp, u) => unitsOf(opp, sizes(my, opp)[1])
    .map(v => ({ u, v, ev: ev(u, v), value: after(my, opp, u, v) })).sort((x, y) => x.value - y.value);
  // Picker's options, each scored by the opponent's best answer to it.
  const myPicks = (my, opp) => unitsOf(my, sizes(my, opp)[0])
    .map(u => theirReplies(my, opp, u)[0]).sort((x, y) => y.value - x.value);
  const theirPicks = (my, opp) => unitsOf(opp, sizes(my, opp)[1])
    .map(v => myReplies(my, opp, v)[0]).sort((x, y) => x.value - y.value);

  // Principal line: optimal play by both teams from the current state to the last match.
  const line = [];
  let my = startMy, opp = startOpp, lock = pending;
  while (my && opp) {
    const meFirst = pickerIsMe(kOf(my));
    let step;
    if (lock) {
      step = lock.mine ? theirReplies(my, opp, maskOf(mine, lock.ids))[0]
                       : myReplies(my, opp, maskOf(theirs, lock.ids))[0];
      lock = null;
    } else {
      step = (meFirst ? myPicks : theirPicks)(my, opp)[0];
    }
    line.push({ mine: idsOf(mine, step.u), theirs: idsOf(theirs, step.v), ev: step.ev, meFirst, k: kOf(my) });
    my ^= step.u; opp ^= step.v;
  }

  // What to do right now.
  const fmtOpt = o => ({ mine: idsOf(mine, o.u), theirs: idsOf(theirs, o.v), ev: o.ev, value: o.value });
  let decision = null;
  if (startMy && startOpp) {
    const meFirst = pickerIsMe(startK);
    if (pending && !pending.mine) {
      decision = { kind: 'respond', locked: pending.ids,
        options: myReplies(startMy, startOpp, maskOf(theirs, pending.ids)).map(fmtOpt) };
    } else if (pending && pending.mine) {
      decision = { kind: 'awaitReply', locked: pending.ids,
        options: theirReplies(startMy, startOpp, maskOf(mine, pending.ids)).map(fmtOpt) };
    } else if (meFirst) {
      decision = { kind: 'pick', options: myPicks(startMy, startOpp).map(fmtOpt) };
    } else {
      decision = { kind: 'await', options: theirPicks(startMy, startOpp).map(fmtOpt) };
    }
  }

  const value = line.reduce((s, m) => s + m.ev, 0);
  return { exact: isExact, value, matches: line.length, line, decision };
}

// Cheat sheet: every unit of mine against every unit of theirs (singles: player grid;
// pairs: each of my pairs with its average and worst value against their possible pairs).
export function pairingTable({ format, event, holes = [], mine, theirs }) {
  const n = format === 'singles' ? 1 : 2;
  const units = arr => unitsOf((1 << Math.min(arr.length, MAX_SIDE)) - 1, Math.min(n, arr.length))
    .map(m => bitsOf(m).map(i => arr[i]));
  const um = units(mine), uo = units(theirs);
  const hcps = u => u.map(p => Number(p.handicap) || 0);
  return um.map(u => {
    const vs = uo.map(v => ({ theirs: v.map(p => p.id),
      ...matchValue({ format, event, holes, aHcps: hcps(u), bHcps: hcps(v) }) }));
    const evs = vs.map(x => x.ev);
    return { mine: u.map(p => p.id), vs,
      avg: evs.reduce((a, b) => a + b, 0) / (evs.length || 1), worst: Math.min(...evs), best: Math.max(...evs) };
  }).sort((a, b) => b.avg - a.avg);
}
