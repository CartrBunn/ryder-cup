import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { computeEvent, plannedMatches, tournamentTotals, tournamentWinProbability } from '../lib/matchcompute';
import { loadEvent } from '../lib/loadEvent';
import TugBar from '../components/TugBar';

export default function Lobby() {
  const { profile } = useAuth();
  const nav = useNavigate();
  const [data, setData] = useState(null);
  const [loadErr, setLoadErr] = useState('');

  async function load() {
    try {
      setData(await loadEvent(profile.event_id));
      setLoadErr('');
    } catch (e) {
      // On a failed refresh keep showing the last good board rather than a partial one.
      setLoadErr(e.message || String(e));
    }
  }
  useEffect(() => {
    if (!profile?.event_id) return;
    load();
    const t = setInterval(load, 60000);   // auto-refresh the board every minute
    return () => clearInterval(t);
  }, [profile?.event_id]);

  if (!profile) return <div className="center">No event yet.</div>;
  if (!data && loadErr) return (
    <div className="center stack">
      <p className="err">Couldn't load the leaderboard: {loadErr}</p>
      <button className="primary" onClick={load}>Try again</button>
    </div>
  );
  if (!data) return <div className="center">Loading leaderboard…</div>;

  const { event, teams, profiles, rounds, matches } = data;
  const profilesById = Object.fromEntries(profiles.map(p => [p.id, p]));
  const ctxById = computeEvent(data);
  const totals = tournamentTotals(matches, ctxById);
  const [teamA, teamB] = teams;
  const aPts = teamA ? (totals[teamA.id] || 0) : 0;
  const bPts = teamB ? (totals[teamB.id] || 0) : 0;

  // Points not yet on the board stay in play so the cup isn't declared over before,
  // say, the singles are set.
  const { unplayed, plannedTotal } = plannedMatches(data);

  const proj = tournamentWinProbability(matches, ctxById, teamA?.id, unplayed);

  const nameOf = ids => ids.map(id => profilesById[id]?.display_name || '—').join(' / ');
  const winStyle = color => color ? { background: color + '28' } : undefined;

  // Ensure teamA's players always appear on the left to match the tug bar.
  // Winner shading comes from the scores themselves — a match is won as soon as it's decided.
  const matchDisplay = m => {
    const aTeamId = profilesById[m.side_a_players[0]]?.team_id;
    const natural = aTeamId === teamA?.id || (!teamA && true);
    const final = ctxById[m.id]?.state.final;
    return {
      leftPlayers: natural ? m.side_a_players : m.side_b_players,
      rightPlayers: natural ? m.side_b_players : m.side_a_players,
      leftWon: final === (natural ? 'A' : 'B'),
      rightWon: final === (natural ? 'B' : 'A'),
    };
  };

  return (
    <div className="stack">
      <TugBar a={aPts} b={bPts} total={plannedTotal} teamA={teamA} teamB={teamB}
        pCupA={proj.pCupA} pCupB={proj.pCupB} pTie={proj.pTie}
        projA={proj.projA} projB={proj.projB} projMatches={proj.matches} />

      {rounds.map(r => (
        <section key={r.id} className="round">
          <div className="rhead"><span className="rname">{r.name}</span><span className="rsub">{r.format.replace('_',' ')}{event.scoring_mode === 'stroke' && ' · stroke play'}</span></div>
          {matches.filter(m => m.round_id === r.id)
            .sort((x, y) => x.seq - y.seq)
            .map(m => {
            const c = ctxById[m.id];
            const { leftPlayers, rightPlayers, leftWon, rightWon } = matchDisplay(m);
            return (
              <div className="match clickable" key={m.id} onClick={() => nav(`/match/${m.id}`)}>
                <div className="mside" style={leftWon ? winStyle(teamA?.color) : undefined}>{nameOf(leftPlayers)}</div>
                <div className="mstatus">
                  <span>{c?.state.status || '—'}</span>
                  {m.start_hole && <span className="starthole">Hole {m.start_hole}</span>}
                </div>
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
