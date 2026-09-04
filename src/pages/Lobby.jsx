import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';
import { computeMatch, tournamentTotals, tournamentWinProbability } from '../lib/matchcompute';
import TugBar from '../components/TugBar';

export default function Lobby() {
  const { profile } = useAuth();
  const nav = useNavigate();
  const [data, setData] = useState(null);

  useEffect(() => {
    if (!profile?.event_id) return;
    const evt = profile.event_id;
    async function load() {
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
    }
    load();
    const t = setInterval(load, 60000);   // auto-refresh the board every minute
    return () => clearInterval(t);
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
  const proj = tournamentWinProbability(matches, ctxById, teamA?.id);

  const nameOf = ids => ids.map(id => profilesById[id]?.display_name || '—').join(' / ');
  const winStyle = color => color ? { background: color + '28' } : undefined;

  // Ensure teamA's players always appear on the left to match the tug bar.
  const matchDisplay = m => {
    const aTeamId = profilesById[m.side_a_players[0]]?.team_id;
    const natural = aTeamId === teamA?.id || (!teamA && true);
    return {
      leftPlayers: natural ? m.side_a_players : m.side_b_players,
      rightPlayers: natural ? m.side_b_players : m.side_a_players,
      leftWon: m.final === (natural ? 'A' : 'B'),
      rightWon: m.final === (natural ? 'B' : 'A'),
    };
  };

  return (
    <div className="stack">
      <TugBar a={aPts} b={bPts} total={matches.length} teamA={teamA} teamB={teamB}
        pCupA={proj.pCupA} pCupB={proj.pCupB} pTie={proj.pTie}
        projA={proj.projA} projB={proj.projB} projMatches={proj.matches} />

      {rounds.map(r => (
        <section key={r.id} className="round">
          <div className="rhead"><span className="rname">{r.name}</span><span className="rsub">{r.format.replace('_',' ')}</span></div>
          {matches.filter(m => m.round_id === r.id).map(m => {
            const c = ctxById[m.id];
            const { leftPlayers, rightPlayers, leftWon, rightWon } = matchDisplay(m);
            return (
              <div className="match clickable" key={m.id} onClick={() => nav(`/match/${m.id}`)}>
                <div className="mside" style={leftWon ? winStyle(teamA?.color) : undefined}>{nameOf(leftPlayers)}</div>
                <div className="mstatus">{c?.state.status || '—'}</div>
                <div className="mside right" style={rightWon ? winStyle(teamB?.color) : undefined}>{nameOf(rightPlayers)}</div>
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
