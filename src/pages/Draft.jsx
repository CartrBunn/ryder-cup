import { useEffect, useState } from 'react';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';

// Alternating snake draft: A, B, B, A, A, B, ...  Captains/organizer assign from the pool.
export default function Draft() {
  const { profile } = useAuth();
  const [teams, setTeams] = useState([]);
  const [players, setPlayers] = useState([]);
  const [matches, setMatches] = useState([]);
  const [err, setErr] = useState('');
  const [busyId, setBusyId] = useState(null);

  async function load() {
    const evt = profile.event_id;
    const [{ data: t }, { data: p }, { data: m }] = await Promise.all([
      supabase.from('teams').select('*').eq('event_id', evt).order('name'),
      supabase.from('profiles').select('*').eq('event_id', evt).order('display_name'),
      supabase.from('matches').select('id, side_a_players, side_b_players').eq('event_id', evt)
    ]);
    setTeams(t || []); setPlayers(p || []); setMatches(m || []);
  }
  useEffect(() => { if (profile?.event_id) load(); }, [profile?.event_id]);

  // Live sync: reload when any team/roster change lands so both captains see picks
  // (and the turn lock) update without a manual refresh.
  useEffect(() => {
    if (!profile?.event_id) return;
    const ch = supabase.channel('draft-' + profile.event_id)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'profiles', filter: `event_id=eq.${profile.event_id}` }, load)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'teams', filter: `event_id=eq.${profile.event_id}` }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [profile?.event_id]);

  const pool = players.filter(p => !p.team_id);
  const picksMade = players.filter(p => p.team_id).length;
  const order = ['A', 'B', 'B', 'A'];                 // snake pattern, repeats
  const nextSide = order[picksMade % order.length];
  const nextTeam = teams[nextSide === 'A' ? 0 : 1];

  const isOrganizer = profile.role === 'organizer';
  const myTeamId = teams.find(t => t.captain_id === profile.id)?.id;
  const canPickFor = teamId => isOrganizer || teamId === myTeamId;
  const inMatchup = playerId => matches.some(m =>
    m.side_a_players.includes(playerId) || m.side_b_players.includes(playerId));

  async function run(playerId, fn) {
    setErr(''); setBusyId(playerId);
    try {
      const { error } = await fn();
      if (error) throw error;
      await load();
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusyId(null);
    }
  }

  const assign = (playerId, teamId) =>
    run(playerId, () => supabase.from('profiles').update({ team_id: teamId }).eq('id', playerId));
  const undoPick = playerId =>
    run(playerId, () => supabase.rpc('undo_pick', { p_player_id: playerId }));
  const removePlayer = playerId => {
    if (!window.confirm('Remove this player from the event? They can rejoin later with the join code.')) return;
    run(playerId, () => supabase.rpc('remove_player', { p_player_id: playerId }));
  };

  return (
    <div className="stack">
      <h1>Team draft</h1>
      {err && <p className="err">{err}</p>}
      {teams.length < 2 ? <p className="muted">Create two teams in Setup first.</p> : (
        <>
          {pool.length > 0
            ? <p className="muted">Next pick (snake order): <strong>{nextTeam?.name || '—'}</strong> — the other team is locked until they pick.</p>
            : <p className="muted">Draft complete.</p>}
          <div className="cols2">
            {teams.map(t => (
              <div className="card" key={t.id}>
                <h3><span className="dot" style={{ background: t.color }} /> {t.name}</h3>
                <ul className="clean">
                  {players.filter(p => p.team_id === t.id).map(p => (
                    <li key={p.id} className="row between">
                      <span>{p.display_name} <span className="dim">({p.handicap})</span>
                        {inMatchup(p.id) && <span className="dim"> · in matchups</span>}
                      </span>
                      <span className="row">
                        <button disabled={busyId === p.id || inMatchup(p.id)} onClick={() => undoPick(p.id)}>↩ Undo</button>
                        <button disabled={busyId === p.id || inMatchup(p.id)} onClick={() => removePlayer(p.id)}>✕ Remove</button>
                      </span>
                    </li>
                  ))}
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
                  {teams.filter(t => canPickFor(t.id)).map(t =>
                    <button key={t.id} disabled={busyId === p.id || t.id !== nextTeam?.id} onClick={() => assign(p.id, t.id)}>→ {t.name}</button>)}
                  <button disabled={busyId === p.id} onClick={() => removePlayer(p.id)}>✕ Remove</button>
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
