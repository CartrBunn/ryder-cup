import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';

const DEFAULT_HOLES = Array.from({ length: 18 }, (_, i) => ({ number: i + 1, par: 4, strokeIndex: i + 1 }));
const ROUND_TEMPLATE = [
  { seq: 1, name: 'Scramble', format: 'scramble' },
  { seq: 2, name: 'Alternate Shot', format: 'alternate_shot' },
  { seq: 3, name: 'Singles', format: 'singles' }
];

export default function AdminSetup() {
  const { profile, refreshProfile } = useAuth();
  const [event, setEvent] = useState(null);
  const [teams, setTeams] = useState([]);
  const [players, setPlayers] = useState([]);
  const [course, setCourse] = useState(null);
  const [rounds, setRounds] = useState([]);
  const [msg, setMsg] = useState('');

  async function load() {
    if (!profile?.event_id) return;
    const evt = profile.event_id;
    const [{ data: e }, { data: t }, { data: p }, { data: c }, { data: r }] = await Promise.all([
      supabase.from('events').select('*').eq('id', evt).single(),
      supabase.from('teams').select('*').eq('event_id', evt).order('name'),
      supabase.from('profiles').select('*').eq('event_id', evt),
      supabase.from('courses').select('*').eq('event_id', evt).maybeSingle(),
      supabase.from('rounds').select('*').eq('event_id', evt).order('seq')
    ]);
    setEvent(e); setTeams(t || []); setPlayers(p || []); setRounds(r || []);
    setCourse(c || { event_id: evt, name: 'Course', holes: DEFAULT_HOLES });
  }
  useEffect(() => { load(); }, [profile?.event_id]);

  if (!profile?.event_id) return <Navigate to="/start" replace />;
  if (!event) return <div className="center">Loading setup…</div>;

  const flash = m => { setMsg(m); setTimeout(() => setMsg(''), 1500); };

  async function saveEvent() {
    await supabase.from('events').update({
      name: event.name, join_code: event.join_code,
      singles_pct: event.singles_pct, altshot_pct: event.altshot_pct,
      scramble_low_pct: event.scramble_low_pct, scramble_high_pct: event.scramble_high_pct
    }).eq('id', event.id);
    flash('Event saved');
  }
  async function saveCourse() {
    const row = { ...course, event_id: event.id };
    const { data } = await supabase.from('courses').upsert(row).select().single();
    setCourse(data); flash('Course saved');
  }
  async function ensureTeams() {
    if (teams.length >= 2) return;
    await supabase.from('teams').insert([
      { event_id: event.id, name: 'Team Red', color: '#B23A2E' },
      { event_id: event.id, name: 'Team Blue', color: '#1E3A5F' }
    ]);
    load();
  }
  async function saveTeam(t) {
    const newCaptain = t.captain_id || null;
    // Read the outgoing captain so we can demote them if the captain changed.
    const { data: prev } = await supabase.from('teams').select('captain_id').eq('id', t.id).single();
    await supabase.from('teams').update({ name: t.name, color: t.color, captain_id: newCaptain }).eq('id', t.id);
    // Demote the previous captain back to player (only if they're still a plain captain,
    // so we never strip an organizer who happened to be captaining).
    if (prev?.captain_id && prev.captain_id !== newCaptain) {
      await supabase.from('profiles').update({ role: 'player' }).eq('id', prev.captain_id).eq('role', 'captain');
    }
    if (newCaptain) await supabase.from('profiles').update({ role: 'captain' }).eq('id', newCaptain);
    flash('Team saved');
    load();
  }
  async function createRounds() {
    if (!course?.id) { flash('Save the course first'); return; }
    await supabase.from('rounds').insert(ROUND_TEMPLATE.map(t => ({ ...t, event_id: event.id, course_id: course.id })));
    load();
  }
  async function removePlayer(p) {
    if (!window.confirm(`Remove ${p.display_name} from the event? They can rejoin later with the join code.`)) return;
    const { error } = await supabase.rpc('remove_player', { p_player_id: p.id });
    if (error) { flash(error.message); return; }
    flash('Player removed');
    load();
  }

  const setHole = (i, key, val) => setCourse(c => {
    const holes = c.holes.map((h, idx) => idx === i ? { ...h, [key]: Number(val) } : h);
    return { ...c, holes };
  });

  return (
    <div className="stack">
      <h1>Event setup</h1>
      {msg && <div className="flash">{msg}</div>}

      <section className="card">
        <h3>Basics</h3>
        <label>Event name<input value={event.name} onChange={e => setEvent({ ...event, name: e.target.value })} /></label>
        <label>Join code<input value={event.join_code} onChange={e => setEvent({ ...event, join_code: e.target.value })} /></label>
        <div className="cols4">
          <label>Singles %<input type="number" value={event.singles_pct} onChange={e => setEvent({ ...event, singles_pct: +e.target.value })} /></label>
          <label>Alt-shot %<input type="number" value={event.altshot_pct} onChange={e => setEvent({ ...event, altshot_pct: +e.target.value })} /></label>
          <label>Scramble low %<input type="number" value={event.scramble_low_pct} onChange={e => setEvent({ ...event, scramble_low_pct: +e.target.value })} /></label>
          <label>Scramble high %<input type="number" value={event.scramble_high_pct} onChange={e => setEvent({ ...event, scramble_high_pct: +e.target.value })} /></label>
        </div>
        <button className="primary" onClick={saveEvent}>Save basics</button>
      </section>

      <section className="card">
        <h3>Course</h3>
        <label>Course name<input value={course.name} onChange={e => setCourse({ ...course, name: e.target.value })} /></label>
        <table className="scorecard">
          <thead><tr><th>Hole</th><th>Par</th><th>Stroke index</th></tr></thead>
          <tbody>
            {course.holes.map((h, i) => (
              <tr key={h.number}>
                <td>{h.number}</td>
                <td><input className="hole" type="number" value={h.par} onChange={e => setHole(i, 'par', e.target.value)} /></td>
                <td><input className="hole" type="number" value={h.strokeIndex} onChange={e => setHole(i, 'strokeIndex', e.target.value)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <button className="primary" onClick={saveCourse}>Save course</button>
      </section>

      <section className="card">
        <h3>Teams &amp; captains</h3>
        {teams.length < 2
          ? <button className="primary" onClick={ensureTeams}>Create two teams</button>
          : teams.map((t, i) => (
            <div className="teamrow" key={t.id}>
              <input value={t.name} onChange={e => setTeams(ts => ts.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
              <input type="color" value={t.color} onChange={e => setTeams(ts => ts.map((x, j) => j === i ? { ...x, color: e.target.value } : x))} />
              <select value={t.captain_id || ''} onChange={e => setTeams(ts => ts.map((x, j) => j === i ? { ...x, captain_id: e.target.value || null } : x))}>
                <option value="">— captain —</option>
                {players.map(p => <option key={p.id} value={p.id}>{p.display_name}</option>)}
              </select>
              <button onClick={() => saveTeam(t)}>Save</button>
            </div>
          ))}
      </section>

      <section className="card">
        <h3>Players</h3>
        {players.length === 0
          ? <p className="muted">No one has joined yet.</p>
          : <ul className="clean">
              {players.map(p => (
                <li key={p.id} className="row between">
                  <span>{p.display_name} <span className="dim">({p.handicap}) · {p.role}</span></span>
                  <button onClick={() => removePlayer(p)}>✕ Remove</button>
                </li>
              ))}
            </ul>}
      </section>

      <section className="card">
        <h3>Rounds</h3>
        {rounds.length === 0
          ? <button className="primary" onClick={createRounds}>Create the 3 rounds</button>
          : <ul className="clean">{rounds.map(r => <li key={r.id}>{r.seq}. {r.name} <span className="dim">({r.format.replace('_',' ')})</span></li>)}</ul>}
      </section>
    </div>
  );
}

