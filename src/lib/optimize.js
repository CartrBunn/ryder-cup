// Matchup optimizer for one round's snake draft. Pure and dependency-free, like scoring.js.
//
// The draft is a two-player game: for each match the picking team sends a unit (one player,
// or a pair) and the other team answers with theirs. Every pairing is priced with the same
// pre-match win-probability model the leaderboard uses, as "my" expected points
// (win = 1, halve = ½). We then solve the game by minimax: the team picking first assumes
// the best reply, the replying team takes the best answer, and both play on optimally.
// Rounds too big to solve exactly fall back to a one-move lookahead that values what's left
// by how each remaining player fares, on average, against the other side's remaining players.
import { sideHandicap } from './handicap';
import { matchStrokeMap } from './scoring';
import { winProbability } from './winprob';
import { ruleFor, skillRuleFor } from './matchcompute';

const BUDGET = 15_000_000;  // pairings examined before giving up on the exact solve
const EXACT_SIDE = 10;      // most players per side worth solving exactly (also fits the memo keys)
const MAX_SIDE = 30;        // most players per side that fit in a 32-bit mask
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

// The game over a fixed roster: pairing values, the (exact or estimated) value of any state,
// and every side's ranked options from a state. States are bitmasks over mine / theirs.
function solver({ format, event, holes, mine, theirs, pickerIsMe, startK }) {
  const n = format === 'singles' ? 1 : 2;
  const full = arr => (1 << arr.length) - 1;
  const startMy = full(mine), startOpp = full(theirs);
  const hm = mine.map(p => Number(p.handicap) || 0), ht = theirs.map(p => Number(p.handicap) || 0);

  const evCache = new Map();   // u -> (v -> value)
  const ev = (u, v) => {
    let row = evCache.get(u);
    if (!row) evCache.set(u, row = new Map());
    let x = row.get(v);
    if (x === undefined) {
      x = matchValue({ format, event, holes, aHcps: bitsOf(u).map(i => hm[i]), bHcps: bitsOf(v).map(i => ht[i]) }).ev;
      row.set(v, x);
    }
    return x;
  };
  // Matches already made in this round's search state, recovered from how many are left.
  const kOf = my => startK + Math.round((mine.length - popcount(my)) / n);
  const sizes = (my, opp) => [Math.min(n, popcount(my)), Math.min(n, popcount(opp))];
  const matchesLeft = (my, opp) => Math.min(Math.ceil(popcount(my) / n), Math.ceil(popcount(opp) / n));

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

  let isExact = mine.length <= EXACT_SIDE && theirs.length <= EXACT_SIDE;
  if (isExact) {
    try { exact(startMy, startOpp); }
    catch (e) { if (e !== OVER) throw e; isExact = false; memo.clear(); }
  }

  // Estimate for rosters too big to solve: the matches left × the average of W over the
  // players each side has left, where W[i][j] is how player i fares against player j
  // (in pairs formats, averaged over every partner either could have).
  let after;
  if (isExact) {
    after = (my, opp, u, v) => ev(u, v) + exact(my ^ u, opp ^ v);
  } else {
    const W = hm.map(() => new Float64Array(ht.length));
    if (n === 1) {
      hm.forEach((_, i) => ht.forEach((_, j) => { W[i][j] = ev(1 << i, 1 << j); }));
    } else {
      const pm = unitsOf(startMy, Math.min(2, mine.length)), pt = unitsOf(startOpp, Math.min(2, theirs.length));
      const cnt = hm.map(() => new Float64Array(ht.length));
      for (const u of pm) for (const v of pt) {
        const x = ev(u, v);
        for (const i of bitsOf(u)) for (const j of bitsOf(v)) { W[i][j] += x; cnt[i][j]++; }
      }
      W.forEach((row, i) => row.forEach((_, j) => { if (cnt[i][j]) row[j] /= cnt[i][j]; }));
    }
    // Row / column sums of W over a state, cached for the state the loops are working on.
    let sMy = -1, sOpp = -1, row, col, total;
    const sums = (my, opp) => {
      if (my === sMy && opp === sOpp) return;
      sMy = my; sOpp = opp; row = new Float64Array(hm.length); col = new Float64Array(ht.length); total = 0;
      const bm = bitsOf(my), bo = bitsOf(opp);
      for (const i of bm) for (const j of bo) { row[i] += W[i][j]; col[j] += W[i][j]; total += W[i][j]; }
    };
    after = (my, opp, u, v) => {
      const my2 = my ^ u, opp2 = opp ^ v;
      const cells = popcount(my2) * popcount(opp2);
      if (!cells) return ev(u, v);
      sums(my, opp);
      const bu = bitsOf(u), bv = bitsOf(v);
      let block = total;
      for (const i of bu) block -= row[i];
      for (const j of bv) block -= col[j];
      for (const i of bu) for (const j of bv) block += W[i][j];
      return ev(u, v) + matchesLeft(my2, opp2) * block / cells;
    };
  }

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

  return { exact: isExact, startMy, startOpp, kOf, ev, after, myReplies, theirReplies, myPicks, theirPicks };
}

const idsOf = (arr, mask) => bitsOf(mask).map(i => arr[i].id);
const maskOf = (arr, ids) => ids.reduce((m, id) => m | (1 << arr.findIndex(p => p.id === id)), 0);

// mine / theirs: players still to be placed, [{ id, handicap }].
// pickerIsMe(k): whether my team picks first in the round's k-th match (0-based, counting
//   matches already made — pass matchesMade as `startK`).
// pending: the picker's locked-in unit, { mine: bool, ids: [...] } or null.
export function planRound({ format, event, holes = [], mine, theirs, pickerIsMe, startK = 0, pending = null }) {
  mine = mine.slice(0, MAX_SIDE); theirs = theirs.slice(0, MAX_SIDE);
  // A lock naming players who aren't available any more is stale — ignore it.
  if (pending && !pending.ids.every(id => (pending.mine ? mine : theirs).some(p => p.id === id))) pending = null;
  const { exact: isExact, startMy, startOpp, kOf, myReplies, theirReplies, myPicks, theirPicks } =
    solver({ format, event, holes, mine, theirs, pickerIsMe, startK });

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

// Letter grade from the average expected points a team's real (unforced) decisions gave
// away beyond the tolerance. Most captains land in the B range; a clean draft is an A.
const GRADES = [[0.02, 'A+'], [0.05, 'A'], [0.08, 'A−'], [0.12, 'B+'], [0.16, 'B'], [0.2, 'B−'],
  [0.25, 'C+'], [0.3, 'C'], [0.36, 'C−'], [0.45, 'D']];
export const letterGrade = perDecision => (GRADES.find(([max]) => perDecision <= max) || [0, 'F'])[1];

// How close to the best counts as just as good. The estimate used for big rosters is rough,
// so it gets a wider margin than the exact solve.
const TOLERANCE = { exact: 0.03, approx: 0.2 };

// Grade a round's draft as it actually happened. Replays the matches in draft order and, at
// each one, compares the picking team's choice with its best pick and the replying team's
// answer with its best answer — each valued assuming perfect play afterwards. A "loss" is the
// expected points a decision gave away versus the best one available at that moment.
// teamA / teamB: every player on each team, [{ id, handicap }]; matches: this round's, in
// draft (seq) order; firstIdx: 0 if team A picked first in the first match, else 1.
export function gradeDraft({ format, event, holes = [], teamA, teamB, matches, firstIdx = 0 }) {
  const n = format === 'singles' ? 1 : 2;
  // Players still unplaced stay in the pool: they were options at every pick.
  teamA = teamA.slice(0, MAX_SIDE); teamB = teamB.slice(0, MAX_SIDE);
  const aFirst = k => (k + firstIdx) % 2 === 0;
  const S = solver({ format, event, holes, mine: teamA, theirs: teamB, pickerIsMe: aFirst, startK: 0 });
  const idsA = mask => idsOf(teamA, mask), idsB = mask => idsOf(teamB, mask);
  const pos = x => Math.max(0, x);
  const rankOf = (opts, value, better) => 1 + opts.filter(o => better(o.value, value) && Math.abs(o.value - value) > 1e-9).length;

  const picks = [];
  const tol = S.exact ? TOLERANCE.exact : TOLERANCE.approx;
  const tally = { A: { lost: 0, penalty: 0, decisions: 0 }, B: { lost: 0, penalty: 0, decisions: 0 } };
  // A decision with only one option was forced: shown, but not held against anyone.
  const charge = (side, loss, options) => {
    if (options < 2) return;
    const t = tally[side];
    t.lost += loss; t.penalty += Math.max(0, loss - tol); t.decisions += 1;
  };
  let my = S.startMy, opp = S.startOpp, actual = 0;
  const optimal = my && opp ? (aFirst(0) ? S.myPicks : S.theirPicks)(my, opp)[0].value : 0;
  matches.forEach((m, k) => {
    const ids = [...m.side_a_players, ...m.side_b_players];
    const a = ids.filter(id => teamA.some(p => p.id === id)), b = ids.filter(id => teamB.some(p => p.id === id));
    const u = maskOf(teamA, a), v = maskOf(teamB, b);
    const fits = (u & ~my) === 0 && (v & ~opp) === 0 &&
      a.length === Math.min(n, popcount(my)) && b.length === Math.min(n, popcount(opp));
    if (!fits || !u || !v) {   // a hand-built or odd-sized match: record it, don't grade it
      picks.push({ k, skipped: true, a, b });
      my &= ~u; opp &= ~v;
      return;
    }
    const ev = S.ev(u, v);
    const result = S.after(my, opp, u, v);   // team A's value after both choices
    let row;
    if (aFirst(k)) {
      const opts = S.myPicks(my, opp), replies = S.theirReplies(my, opp, u);
      const pickVal = replies[0].value;
      row = { picker: 'A', pick: a, reply: b,
        pickLoss: pos(opts[0].value - pickVal), bestPick: idsA(opts[0].u), bestPickAnswer: idsB(opts[0].v),
        pickRank: rankOf(opts, pickVal, (x, y) => x > y), pickOptions: opts.length,
        replyLoss: pos(result - replies[0].value), bestReply: idsB(replies[0].v),
        replyRank: rankOf(replies, result, (x, y) => x < y), replyOptions: replies.length };
      charge('A', row.pickLoss, row.pickOptions); charge('B', row.replyLoss, row.replyOptions);
    } else {
      const opts = S.theirPicks(my, opp), replies = S.myReplies(my, opp, v);
      const pickVal = replies[0].value;
      row = { picker: 'B', pick: b, reply: a,
        pickLoss: pos(pickVal - opts[0].value), bestPick: idsB(opts[0].v), bestPickAnswer: idsA(opts[0].u),
        pickRank: rankOf(opts, pickVal, (x, y) => x < y), pickOptions: opts.length,
        replyLoss: pos(replies[0].value - result), bestReply: idsA(replies[0].u),
        replyRank: rankOf(replies, result, (x, y) => x > y), replyOptions: replies.length };
      charge('B', row.pickLoss, row.pickOptions); charge('A', row.replyLoss, row.replyOptions);
    }
    picks.push({ k, ev, ...row });
    actual += ev;
    my ^= u; opp ^= v;
  });

  const graded = picks.filter(p => !p.skipped).length;
  const summary = t => {
    const perDecision = t.decisions ? t.penalty / t.decisions : 0;
    return { ...t, perDecision, grade: letterGrade(perDecision) };
  };
  return {
    exact: S.exact, graded, complete: !(my && opp), tolerance: tol,
    picks, optimal, actual,
    A: summary(tally.A), B: summary(tally.B)
  };
}
