// End-to-end test of a whole event: two teams of four play scramble, alternate shot and
// singles on an 18-hole card. Scores are scripted so every result is known up front, then
// the event is run through the same code the app uses (computeEvent → totals → chat posts).
import { describe, it, expect } from 'vitest';
import { computeEvent, tournamentTotals, tournamentWinProbability, plannedMatches } from './matchcompute';
import { desiredPosts } from './automations';

// Par 4 everywhere; stroke index = hole number, so strokes land on holes 1, 2, 3…
const holes = Array.from({ length: 18 }, (_, i) => ({ number: i + 1, par: 4, strokeIndex: i + 1 }));

const teams = [{ id: 'tE', name: 'Eagles' }, { id: 'tH', name: 'Hawks' }];   // ordered by name, like loadEvent
const player = (id, team_id, handicap = 10) => ({ id, team_id, handicap, display_name: id });
const profiles = [
  player('E1', 'tE'), player('E2', 'tE'), player('E3', 'tE'), player('E4', 'tE'),
  player('H1', 'tH'), player('H2', 'tH'), player('H3', 'tH'), player('H4', 'tH', 14)
];
const rounds = [
  { id: 'r1', seq: 1, name: 'Scramble', format: 'scramble', course_id: 'c1' },
  { id: 'r2', seq: 2, name: 'Alternate Shot', format: 'alternate_shot', course_id: 'c1' },
  { id: 'r3', seq: 3, name: 'Singles', format: 'singles', course_id: 'c1' }
];
const match = (id, round_id, a, b) => ({ id, round_id, side_a_players: a, side_b_players: b, start_hole: null });
const allMatches = [
  match('m1', 'r1', ['E1', 'E2'], ['H1', 'H2']),
  match('m2', 'r1', ['E3', 'E4'], ['H3', 'H4']),
  match('m3', 'r2', ['E1', 'E3'], ['H1', 'H3']),
  match('m4', 'r2', ['E2', 'E4'], ['H2', 'H4']),
  match('m5', 'r3', ['E1'], ['H1']),
  match('m6', 'r3', ['E2'], ['H2']),
  match('m7', 'r3', ['E3'], ['H3']),
  match('m8', 'r3', ['E4'], ['H4'])
];

// Gross 4 on every hole, except a 3 on the listed holes.
const card = (birdies = []) => Object.fromEntries(holes.map(h => [h.number, birdies.includes(h.number) ? 3 : 4]));
const scoreRows = (match_id, a, b) => holes.flatMap(h => [
  { match_id, side: 'A', hole: h.number, gross: a[h.number] },
  { match_id, side: 'B', hole: h.number, gross: b[h.number] }
]);
const allScores = [
  ...scoreRows('m1', card([1, 2, 3, 4]), card()),          // Eagles 4&3
  ...scoreRows('m2', card(), card()),                      // Hawks get 1 stroke on #1 → Hawks 1 up
  ...scoreRows('m3', card(), card()),                      // level handicaps → halved
  ...scoreRows('m4', card([1, 2, 3, 4, 5, 6]), card()),    // Hawks get strokes on #1-2 → Eagles 4&3
  ...scoreRows('m5', card(), card([1, 2])),                // Hawks 2&1
  ...scoreRows('m6', card([18]), card()),                  // Eagles 1 up
  ...scoreRows('m7', card([18]), card()),                  // Eagles 1 up
  ...scoreRows('m8', card(), card())                       // H4 gets 4 strokes → Hawks 4&3
];

const baseEvent = { id: 'ev1', singles_pct: 100, altshot_pct: 50, scramble_low_pct: 35, scramble_high_pct: 15,
  scoring_mode: 'match', harass_player_id: null };

const eventData = ({ event = baseEvent, matches = allMatches, scores = allScores } = {}) =>
  ({ event, teams, profiles, courses: [{ id: 'c1', holes }], rounds, matches, scores });

const statuses = ctx => Object.fromEntries(Object.entries(ctx).map(([id, c]) => [id, c.state.status]));

describe('a full match-play event', () => {
  const data = eventData();
  const ctx = computeEvent(data);

  it('scores every match with handicap strokes applied', () => {
    expect(statuses(ctx)).toEqual({
      m1: 'Eagles wins 4&3',
      m2: 'Hawks wins 1 up',
      m3: 'Match halved',
      m4: 'Eagles wins 4&3',
      m5: 'Hawks wins 2&1',
      m6: 'Eagles wins 1 up',
      m7: 'Eagles wins 1 up',
      m8: 'Hawks wins 4&3'
    });
    expect(ctx.m8.strokeMap).toMatchObject({ receiver: 'B', strokes: 4 });
    expect(ctx.m4.strokeMap).toMatchObject({ receiver: 'B', strokes: 2 });
  });

  it('adds up to Eagles 4½ – Hawks 3½', () => {
    expect(tournamentTotals(data.matches, ctx)).toEqual({ tE: 4.5, tH: 3.5 });
    const p = tournamentWinProbability(data.matches, ctx, 'tE');
    expect(p).toMatchObject({ pCupA: 1, pTie: 0, pCupB: 0, matches: 8 });
  });

  it('posts round results and the Cup winner to chat', () => {
    const bodies = desiredPosts(data).map(p => p.body);
    expect(bodies).toContain('✅ Scramble complete. Round split 1–1 · Eagles leads 4½–3½');
    expect(bodies).toContain('✅ Alternate Shot complete. Eagles takes the round 1½–½ · Eagles leads 4½–3½');
    expect(bodies).toContain('✅ Singles complete. Round split 2–2 · Eagles leads 4½–3½');
    expect(bodies).toContain('🏆🏆 Eagles wins the Cup 4½–3½!');
    expect(bodies.filter(b => b.startsWith('🏆 ') || b.startsWith('🤝 '))).toHaveLength(8);   // one final per match
  });
});

describe('the Cup is not announced early', () => {
  it('waits for the singles round to be built', () => {
    const data = eventData({ matches: allMatches.filter(m => m.round_id !== 'r3') });
    expect(plannedMatches(data).unplayed).toBe(4);
    expect(desiredPosts(data).some(p => p.kind === 'clinch')).toBe(false);
  });

  it('waits for the last match to finish', () => {
    // m6 only through 17 holes: all square, still live.
    const scores = allScores.filter(s => !(s.match_id === 'm6' && s.hole === 18));
    const data = eventData({ scores });
    const ctx = computeEvent(data);
    expect(ctx.m6.state.status).toBe('All square thru 17');
    expect(desiredPosts(data).some(p => p.kind === 'clinch')).toBe(false);
  });
});

describe('the same event at stroke play', () => {
  const data = eventData({ event: { ...baseEvent, scoring_mode: 'stroke' } });
  const ctx = computeEvent(data);

  it('decides each match on net totals over all 18 holes', () => {
    expect(ctx.m1.state.status).toBe('Eagles wins by 4 (net 68–72)');
    expect(ctx.m2.state.status).toBe('Hawks wins by 1 (net 71–72)');
    expect(ctx.m3.state.status).toBe('Match tied (net 72)');
    expect(ctx.m8.state.status).toBe('Hawks wins by 4 (net 68–72)');
    expect(Object.values(ctx).every(c => c.state.played === 18)).toBe(true);
  });

  it('crowns the same Cup winner', () => {
    expect(tournamentTotals(data.matches, ctx)).toEqual({ tE: 4.5, tH: 3.5 });
    expect(desiredPosts(data).map(p => p.body)).toContain('🏆🏆 Eagles wins the Cup 4½–3½!');
  });
});
