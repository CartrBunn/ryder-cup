import { useEffect, useRef, useState } from 'react';
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
  const [teamNames, setTeamNames] = useState({});
  const [pick, setPick] = useState(null);          // live "Team drafted Player" banner
  const [myHandicap, setMyHandicap] = useState('');

  // Latest snapshots for the realtime handler, so it can diff without stale closures.
  const teamsRef = useRef([]);
  const playersRef = useRef([]);
  const pickTimer = useRef();
  useEffect(() => { teamsRef.current = teams; }, [teams]);
  useEffect(() => { playersRef.current = players; }, [players]);

  async function load() {
    const evt = profile.event_id;
    const [{ data: t }, { data: p }, { data: m }] = await Promise.all([
      supabase.from('teams').select('*').eq('event_id', evt).order('name'),
      supabase.from('profiles').select('*').eq('event_id', evt).order('handicap'),
      supabase.from('matches').select('id, side_a_players, side_b_players').eq('event_id', evt)
    ]);
    setTeams(t || []); setPlayers(p || []); setMatches(m || []);
    const me = (p || []).find(x => x.id === profile.id);
    if (me) setMyHandicap(String(me.handicap));
  }
  useEffect(() => { if (profile?.event_id) load(); }, [profile?.event_id]);
  useEffect(() => {
    if (teams.length) setTeamNames(Object.fromEntries(teams.map(t => [t.id, t.name])));
  }, [teams]);

  // Show the pick animation for a few seconds.
  function announce(team, playerName) {
    setPick({ team, playerName, key: Date.now() });
    clearTimeout(pickTimer.current);
    pickTimer.current = setTimeout(() => setPick(null), 4200);
  }

  // Live sync: reload when any team/roster change lands so everyone watching sees picks
  // (and the turn lock) update without a manual refresh — and flash a banner on each pick.
  useEffect(() => {
    if (!profile?.event_id) return;
    const onProfile = payload => {
      // A new pick = a player who had no team now has one (diff against our last snapshot,
      // since realtime UPDATE payloads don't carry the full old row by default).
      const row = payload.new;
      if (row?.team_id) {
        const prev = playersRef.current.find(p => p.id === row.id);
        if (prev && !prev.team_id) {
          const team = teamsRef.current.find(t => t.id === row.team_id);
          announce(team, row.display_name);
        }
      }
      load();
    };
    const ch = supabase.channel('draft-' + profile.event_id)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'profiles', filter: `event_id=eq.${profile.event_id}` }, onProfile)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'teams', filter: `event_id=eq.${profile.event_id}` }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); clearTimeout(pickTimer.current); };
  }, [profile?.event_id]);

  const pool = players.filter(p => !p.team_id);
  const picksMade = players.filter(p => p.team_id).length;
  const order = ['A', 'B', 'B', 'A'];                 // snake pattern, repeats
  const nextSide = order[picksMade % order.length];
  const nextTeam = teams[nextSide === 'A' ? 0 : 1];

  const isOrganizer = profile.role === 'organizer';
  const myTeamId = teams.find(t => t.captain_id === profile.id)?.id;
  const canPickFor = teamId => isOrganizer || teamId === myTeamId;
  const canManage = isOrganizer || !!myTeamId;   // organizers + captains act; everyone else watches
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

  async function saveMyHandicap() {
    const val = Number(myHandicap);
    if (isNaN(val)) return;
    const { error } = await supabase.from('profiles').update({ handicap: val }).eq('id', profile.id);
    if (error) setErr(error.message);
    else load();
  }

  async function saveTeamName(teamId, name) {
    const trimmed = name.trim();
    if (!trimmed || trimmed === teams.find(t => t.id === teamId)?.name) return;
    const { error } = await supabase.from('teams').update({ name: trimmed }).eq('id', teamId);
    if (error) setErr(error.message);
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
      {pick && (
        <div className="draftpop" key={pick.key} style={{ '--team': pick.team?.color || 'var(--gold)' }}>
          <span className="dot" style={{ background: pick.team?.color }} />
          <span><strong>{pick.team?.name || 'A team'}</strong> drafted <strong>{pick.playerName}</strong></span>
        </div>
      )}
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
                <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="dot" style={{ background: t.color, flexShrink: 0 }} />
                  {canPickFor(t.id)
                    ? <input className="teamname-edit" value={teamNames[t.id] ?? t.name}
                        onChange={e => setTeamNames(prev => ({ ...prev, [t.id]: e.target.value }))}
                        onBlur={e => saveTeamName(t.id, e.target.value)} />
                    : <span>{t.name}</span>}
                </h3>
                <ul className="clean">
                  {players.filter(p => p.team_id === t.id).map(p => (
                    <li key={p.id} className="row between">
                      <span>{p.display_name} (<span className="dim">
                        {p.id === profile.id
                          ? <input type="number" step="0.1" className="hcap-edit"
                              value={myHandicap}
                              onChange={e => setMyHandicap(e.target.value)}
                              onBlur={saveMyHandicap} />
                          : p.handicap}
                      </span>)
                        {inMatchup(p.id) && <span className="dim"> · in matchups</span>}
                      </span>
                      {canPickFor(t.id) && (
                        <span className="row">
                          <button disabled={busyId === p.id || inMatchup(p.id)} onClick={() => undoPick(p.id)}>↩ Undo</button>
                          <button disabled={busyId === p.id || inMatchup(p.id)} onClick={() => removePlayer(p.id)}>✕ Remove</button>
                        </span>
                      )}
                    </li>
                  ))}
                  {players.filter(p => p.team_id === t.id).length === 0 && <li className="dim">No picks yet.</li>}
                </ul>
              </div>
            ))}
          </div>
          <h3>Available players</h3>
          <div className="pool">
            {pool.map(p => (
              <div className="poolrow" key={p.id}>
                <span>{p.display_name} (<span className="dim">
                  {p.id === profile.id
                    ? <input type="number" step="0.1" className="hcap-edit"
                        value={myHandicap}
                        onChange={e => setMyHandicap(e.target.value)}
                        onBlur={saveMyHandicap} />
                    : p.handicap}
                </span>)</span>
                {canManage && (
                  <span className="row">
                    {teams.filter(t => canPickFor(t.id)).map(t =>
                      <button key={t.id} disabled={busyId === p.id || t.id !== nextTeam?.id} onClick={() => assign(p.id, t.id)}>→ {t.name}</button>)}
                    <button disabled={busyId === p.id} onClick={() => removePlayer(p.id)}>✕ Remove</button>
                  </span>
                )}
              </div>
            ))}
            {pool.length === 0 && <p className="muted">Everyone's been drafted.</p>}
          </div>
        </>
      )}
    </div>
  );
}
