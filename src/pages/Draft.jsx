import { useEffect, useState } from 'react';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';

// Alternating snake draft: A, B, B, A, A, B, ...  Captains/organizer assign from the pool.
export default function Draft() {
  const { profile } = useAuth();
  const [teams, setTeams] = useState([]);
  const [players, setPlayers] = useState([]);

  async function load() {
    const evt = profile.event_id;
    const [{ data: t }, { data: p }] = await Promise.all([
      supabase.from('teams').select('*').eq('event_id', evt).order('name'),
      supabase.from('profiles').select('*').eq('event_id', evt).order('display_name')
    ]);
    setTeams(t || []); setPlayers(p || []);
  }
  useEffect(() => { if (profile?.event_id) load(); }, [profile?.event_id]);

  const pool = players.filter(p => !p.team_id);
  const picksMade = players.filter(p => p.team_id).length;
  const order = ['A', 'B', 'B', 'A'];                 // snake pattern, repeats
  const nextSide = order[picksMade % order.length];
  const nextTeam = teams[nextSide === 'A' ? 0 : 1];

  async function assign(playerId, teamId) {
    await supabase.from('profiles').update({ team_id: teamId }).eq('id', playerId);
    load();
  }

  return (
    <div className="stack">
      <h1>Team draft</h1>
      {teams.length < 2 ? <p className="muted">Create two teams in Setup first.</p> : (
        <>
          <p className="muted">Next pick (snake order): <strong>{nextTeam?.name || '—'}</strong></p>
          <div className="cols2">
            {teams.map(t => (
              <div className="card" key={t.id}>
                <h3><span className="dot" style={{ background: t.color }} /> {t.name}</h3>
                <ul className="clean">
                  {players.filter(p => p.team_id === t.id).map(p =>
                    <li key={p.id}>{p.display_name} <span className="dim">({p.handicap})</span></li>)}
                </ul>
              </div>
            ))}
          </div>
          <h3>Available players</h3>
          <div className="pool">
            {pool.map(p => (
              <div className="poolrow" key={p.id}>
                <span>{p.display_name} <span className="dim">({p.handicap})</span></span>
                <span className="row">
                  {teams.map(t =>
                    <button key={t.id} onClick={() => assign(p.id, t.id)}>→ {t.name}</button>)}
                </span>
              </div>
            ))}
            {pool.length === 0 && <p className="muted">Everyone's been drafted.</p>}
          </div>
        </>
      )}
    </div>
  );
}
