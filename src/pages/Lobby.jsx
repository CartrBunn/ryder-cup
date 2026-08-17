import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';
import { computeMatch, tournamentTotals } from '../lib/matchcompute';
import TugBar from '../components/TugBar';

export default function Lobby() {
  const { profile } = useAuth();
  const [data, setData] = useState(null);

  useEffect(() => {
    if (!profile?.event_id) return;
    (async () => {
      const evt = profile.event_id;
      const [{ data: event }, { data: teams }, { data: profiles }, { data: courses },
             { data: rounds }, { data: matches }, { data: scores }] = await Promise.all([
        supabase.from('events').select('*').eq('id', evt).single(),
        supabase.from('teams').select('*').eq('event_id', evt),
        supabase.from('profiles').select('*').eq('event_id', evt),
        supabase.from('courses').select('*').eq('event_id', evt),
        supabase.from('rounds').select('*').eq('event_id', evt).order('seq'),
        supabase.from('matches').select('*').eq('event_id', evt).order('seq'),
        supabase.from('hole_scores').select('*')
      ]);
      setData({ event, teams: teams || [], profiles: profiles || [], courses: courses || [],
                rounds: rounds || [], matches: matches || [], scores: scores || [] });
    })();
  }, [profile?.event_id]);

  if (!profile) return <div className="center">No event yet.</div>;
  if (!data) return <div className="center">Loading leaderboard…</div>;

  const { event, teams, profiles, courses, rounds, matches, scores } = data;
  const profilesById = Object.fromEntries(profiles.map(p => [p.id, p]));
  const courseById = Object.fromEntries(courses.map(c => [c.id, c]));
  const roundById = Object.fromEntries(rounds.map(r => [r.id, r]));

  const ctxById = {};
  for (const m of matches) {
    const round = roundById[m.round_id];
    const course = courseById[round?.course_id];
    ctxById[m.id] = computeMatch({ match: m, round, course, event, profilesById,
      scores: scores.filter(s => s.match_id === m.id) });
  }
  const totals = tournamentTotals(matches, ctxById);
  const [teamA, teamB] = teams;
  const aPts = teamA ? (totals[teamA.id] || 0) : 0;
  const bPts = teamB ? (totals[teamB.id] || 0) : 0;

  const nameOf = ids => ids.map(id => profilesById[id]?.display_name || '—').join(' / ');
  const iAmIn = m => m.side_a_players.includes(profile.id) || m.side_b_players.includes(profile.id);

  return (
    <div className="stack">
      <TugBar a={aPts} b={bPts} total={matches.length} teamA={teamA} teamB={teamB} />

      {rounds.map(r => (
        <section key={r.id} className="round">
          <div className="rhead"><span className="rname">{r.name}</span><span className="rsub">{r.format.replace('_',' ')}</span></div>
          {matches.filter(m => m.round_id === r.id).map(m => {
            const c = ctxById[m.id];
            return (
              <div className="match" key={m.id}>
                <div className="mside">{nameOf(m.side_a_players)}</div>
                <div className="mstatus">{c?.state.status || '—'}</div>
                <div className="mside right">{nameOf(m.side_b_players)}</div>
                {iAmIn(m) && !m.submitted && <Link className="enter" to={`/match/${m.id}`}>Enter scores</Link>}
              </div>
            );
          })}
          {matches.filter(m => m.round_id === r.id).length === 0 && <div className="empty">No matchups set yet.</div>}
        </section>
      ))}
      {rounds.length === 0 && <p className="muted">Waiting on the organizer to set up rounds.</p>}
    </div>
  );
}
