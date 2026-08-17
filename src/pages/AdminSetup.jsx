import { useEffect, useState } from 'react';
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

  if (!profile?.event_id) return <StartEvent onDone={refreshProfile} />;
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
    await supabase.from('teams').update({ name: t.name, color: t.color, captain_id: t.captain_id }).eq('id', t.id);
    if (t.captain_id) await supabase.from('profiles').update({ role: 'captain' }).eq('id', t.captain_id);
    flash('Team saved');
  }
  async function createRounds() {
    if (!course?.id) { flash('Save the course first'); return; }
    await supabase.from('rounds').insert(ROUND_TEMPLATE.map(t => ({ ...t, event_id: event.id, course_id: course.id })));
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
        <h3>Rounds</h3>
        {rounds.length === 0
          ? <button className="primary" onClick={createRounds}>Create the 3 rounds</button>
          : <ul className="clean">{rounds.map(r => <li key={r.id}>{r.seq}. {r.name} <span className="dim">({r.format.replace('_',' ')})</span></li>)}</ul>}
      </section>
    </div>
  );
}

function StartEvent({ onDone }) {
  const [f, setF] = useState({ email: '', password: '', name: '', event: 'Company Ryder Cup', code: '' });
  const [err, setErr] = useState('');
  const set = k => e => setF({ ...f, [k]: e.target.value });
  async function go() {
    setErr('');
    try {
      let { error } = await supabase.auth.signUp({ email: f.email, password: f.password });
      if (error && !/already registered/i.test(error.message)) throw error;
      if (error) {
        const s = await supabase.auth.signInWithPassword({ email: f.email, password: f.password });
        if (s.error) throw s.error;
      }
      const { error: rpcErr } = await supabase.rpc('create_event',
        { p_name: f.event, p_join_code: f.code.trim(), p_organizer_name: f.name.trim() });
      if (rpcErr) throw rpcErr;
      await onDone();
    } catch (e) { setErr(e.message || String(e)); }
  }
  return (
    <div className="card narrow">
      <h1>Start an event</h1>
      <p className="muted">You'll be the organizer. Share the join code with players.</p>
      <input placeholder="Event name" value={f.event} onChange={set('event')} />
      <input placeholder="Join code to hand out" value={f.code} onChange={set('code')} />
      <input placeholder="Your name" value={f.name} onChange={set('name')} />
      <hr />
      <input placeholder="Email" value={f.email} onChange={set('email')} />
      <input type="password" placeholder="Password" value={f.password} onChange={set('password')} />
      {err && <p className="err">{err}</p>}
      <button className="primary" onClick={go}>Create event</button>
    </div>
  );
}
