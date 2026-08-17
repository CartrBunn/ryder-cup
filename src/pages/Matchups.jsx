import { useEffect, useState } from 'react';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';

// For each round, build matches by choosing side A player(s) and side B player(s).
export default function Matchups() {
  const { profile } = useAuth();
  const [rounds, setRounds] = useState([]);
  const [players, setPlayers] = useState([]);
  const [teams, setTeams] = useState([]);
  const [matches, setMatches] = useState([]);

  async function load() {
    const evt = profile.event_id;
    const [{ data: r }, { data: p }, { data: t }, { data: m }] = await Promise.all([
      supabase.from('rounds').select('*').eq('event_id', evt).order('seq'),
      supabase.from('profiles').select('*').eq('event_id', evt),
      supabase.from('teams').select('*').eq('event_id', evt).order('name'),
      supabase.from('matches').select('*').eq('event_id', evt).order('seq')
    ]);
    setRounds(r || []); setPlayers(p || []); setTeams(t || []); setMatches(m || []);
  }
  useEffect(() => { if (profile?.event_id) load(); }, [profile?.event_id]);

  const teamPlayers = teamId => players.filter(p => p.team_id === teamId);
  const size = fmt => fmt === 'singles' ? 1 : 2;

  async function addMatch(round, aIds, bIds) {
    const seq = matches.filter(m => m.round_id === round.id).length + 1;
    await supabase.from('matches').insert({
      round_id: round.id, event_id: profile.event_id, seq,
      side_a_players: aIds, side_b_players: bIds
    });
    load();
  }
  async function removeMatch(id) { await supabase.from('matches').delete().eq('id', id); load(); }

  return (
    <div className="stack">
      <h1>Set matchups</h1>
      {teams.length < 2 && <p className="muted">Draft teams first.</p>}
      {rounds.map(r => (
        <section className="card" key={r.id}>
          <h3>{r.name} <span className="dim">· {r.format.replace('_', ' ')} · {size(r.format)} per side</span></h3>
          <ul className="clean">
            {matches.filter(m => m.round_id === r.id).map(m => (
              <li key={m.id} className="row between">
                <span>{names(m.side_a_players, players)} vs {names(m.side_b_players, players)}</span>
                <button onClick={() => removeMatch(m.id)}>Remove</button>
              </li>
            ))}
          </ul>
          {teams.length === 2 &&
            <MatchBuilder n={size(r.format)}
              teamA={{ team: teams[0], players: teamPlayers(teams[0].id) }}
              teamB={{ team: teams[1], players: teamPlayers(teams[1].id) }}
              onAdd={(a, b) => addMatch(r, a, b)} />}
        </section>
      ))}
      {rounds.length === 0 && <p className="muted">No rounds yet — create them in Setup.</p>}
    </div>
  );
}

function names(ids, players) {
  const by = Object.fromEntries(players.map(p => [p.id, p.display_name]));
  return ids.map(i => by[i] || '—').join(' / ');
}

function MatchBuilder({ n, teamA, teamB, onAdd }) {
  const [a, setA] = useState([]);
  const [b, setB] = useState([]);
  const toggle = (arr, set, id) =>
    set(arr.includes(id) ? arr.filter(x => x !== id) : [...arr, id].slice(-n));
  const ready = a.length === n && b.length === n;
  return (
    <div className="builder">
      <div className="cols2">
        <Picker title={teamA.team.name} players={teamA.players} sel={a} onToggle={id => toggle(a, setA, id)} />
        <Picker title={teamB.team.name} players={teamB.players} sel={b} onToggle={id => toggle(b, setB, id)} />
      </div>
      <button className="primary" disabled={!ready} onClick={() => { onAdd(a, b); setA([]); setB([]); }}>
        Add match
      </button>
    </div>
  );
}
function Picker({ title, players, sel, onToggle }) {
  return (
    <div>
      <div className="dim">{title}</div>
      {players.map(p =>
        <label key={p.id} className={'chip ' + (sel.includes(p.id) ? 'on' : '')}>
          <input type="checkbox" checked={sel.includes(p.id)} onChange={() => onToggle(p.id)} />
          {p.display_name}
        </label>)}
      {players.length === 0 && <div className="muted small">No players drafted.</div>}
    </div>
  );
}
