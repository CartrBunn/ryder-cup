import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { supabase, createTempClient } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';
import { playerCreds } from '../lib/playerAuth';

const makeHoles = n => Array.from({ length: n }, (_, i) => ({ number: i + 1, par: 4, strokeIndex: i + 1 }));
const DEFAULT_HOLES = makeHoles(18);
const ROUND_TEMPLATE = [
  { seq: 1, name: 'Scramble', format: 'scramble' },
  { seq: 2, name: 'Alternate Shot', format: 'alternate_shot' },
  { seq: 3, name: 'Singles', format: 'singles' }
];
const FORMATS = [
  { value: 'scramble', label: 'Scramble', size: 2 },
  { value: 'alternate_shot', label: 'Alternate Shot', size: 2 },
  { value: 'singles', label: 'Singles', size: 1 }
];
const sideSize = fmt => FORMATS.find(f => f.value === fmt)?.size ?? 2;

export default function AdminSetup() {
  const { profile, refreshProfile } = useAuth();
  const [event, setEvent] = useState(null);
  const [teams, setTeams] = useState([]);
  const [players, setPlayers] = useState([]);
  const [course, setCourse] = useState(null);
  const [rounds, setRounds] = useState([]);
  const [msg, setMsg] = useState('');
  const [newPlayer, setNewPlayer] = useState({ name: '', handicap: '', pin: '' });
  const [addingPlayer, setAddingPlayer] = useState(false);
  const [resetId, setResetId] = useState(null);
  const [resetPin, setResetPin] = useState('');
  const [handicaps, setHandicaps] = useState({});
  const [names, setNames] = useState({});

  async function load() {
    if (!profile?.event_id) return;
    const evt = profile.event_id;
    const [{ data: e }, { data: t }, { data: p }, { data: c }, { data: r }] = await Promise.all([
      supabase.from('events').select('*').eq('id', evt).single(),
      supabase.from('teams').select('*').eq('event_id', evt).order('name'),
      supabase.from('profiles').select('*').eq('event_id', evt).order('handicap'),
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
    const { data: prev } = await supabase.from('teams').select('captain_id').eq('id', t.id).single();
    const { error } = await supabase.from('teams').update({ name: t.name, color: t.color, captain_id: newCaptain }).eq('id', t.id);
    if (error) { flash(error.message); return; }
    if (prev?.captain_id && prev.captain_id !== newCaptain) {
      await supabase.from('profiles').update({ role: 'player' }).eq('id', prev.captain_id).eq('role', 'captain');
    }
    if (newCaptain) await supabase.from('profiles').update({ role: 'captain' }).eq('id', newCaptain);
    flash('Team saved');
    load();
  }
  async function ensureCourse() {
    if (course?.id) return course;
    const { data } = await supabase.from('courses').upsert({ ...course, event_id: event.id }).select().single();
    setCourse(data);
    return data;
  }
  async function createRounds() {
    const c = await ensureCourse();
    await supabase.from('rounds').insert(ROUND_TEMPLATE.map(t => ({ ...t, event_id: event.id, course_id: c.id })));
    load();
  }
  async function saveRound(r) {
    await supabase.from('rounds').update({ name: r.name, format: r.format }).eq('id', r.id);
    flash('Round saved');
    load();
  }
  async function addRound() {
    const c = await ensureCourse();
    const seq = (rounds.length ? rounds[rounds.length - 1].seq : 0) + 1;
    await supabase.from('rounds').insert({
      event_id: event.id, course_id: c.id, seq,
      name: `Round ${seq}`, format: 'singles'
    });
    load();
  }
  async function removeRound(r) {
    if (!window.confirm(`Remove "${r.name}"? Any matchups in this round will also be deleted.`)) return;
    await supabase.from('rounds').delete().eq('id', r.id);
    // Resequence remaining rounds
    const remaining = rounds.filter(x => x.id !== r.id);
    await Promise.all(remaining.map((x, i) =>
      supabase.from('rounds').update({ seq: i + 1 }).eq('id', x.id)
    ));
    load();
  }
  async function saveDisplayName(playerId) {
    const val = names[playerId];
    if (val === undefined || !val.trim()) return;
    const { error } = await supabase.rpc('admin_rename_player', { p_player_id: playerId, p_new_name: val.trim() });
    if (error) { flash(error.message); return; }
    load();
  }
  async function saveHandicap(playerId) {
    const val = handicaps[playerId];
    if (val === undefined) return;
    const { error } = await supabase.from('profiles').update({ handicap: Number(val) }).eq('id', playerId);
    if (error) { flash(error.message); return; }
    load();
  }
  async function removePlayer(p) {
    if (!window.confirm(`Remove ${p.display_name} from the event? They can rejoin later with the join code.`)) return;
    const { error } = await supabase.rpc('remove_player', { p_player_id: p.id });
    if (error) { flash(error.message); return; }
    flash('Player removed');
    load();
  }
  async function setOrganizerRole(p, makeOrganizer) {
    const action = makeOrganizer ? `Make ${p.display_name} an organizer?` : `Remove organizer role from ${p.display_name}?`;
    if (!window.confirm(action)) return;
    const { error } = await supabase.rpc('set_organizer_role', { p_player_id: p.id, p_make_organizer: makeOrganizer });
    if (error) { flash(error.message); return; }
    flash(makeOrganizer ? `${p.display_name} is now an organizer` : `${p.display_name} is now a player`);
    load();
  }
  async function resetPlayerPin(p) {
    if (!/^\d{4}$/.test(resetPin)) return flash('PIN must be 4 digits');
    const { password } = playerCreds({ name: p.display_name, code: event.join_code, pin: resetPin });
    const { error } = await supabase.rpc('admin_reset_player_pin', { p_player_id: p.id, p_new_password: password });
    if (error) { flash(error.message); return; }
    flash(`PIN reset for ${p.display_name} — new PIN ${resetPin}`);
    setResetId(null); setResetPin('');
  }
  async function addPlayer() {
    const name = newPlayer.name.trim();
    if (!name) return flash('Enter a name');
    if (!/^\d{4}$/.test(newPlayer.pin)) return flash('PIN must be 4 digits');
    setAddingPlayer(true);
    // Create the player's account on a throwaway client so the organizer's session is untouched.
    const temp = createTempClient();
    try {
      const { email, password } = playerCreds({ name, code: event.join_code, pin: newPlayer.pin });
      const { error } = await temp.auth.signUp({ email, password });
      if (error) throw new Error(/already registered/i.test(error.message)
        ? 'That name is already taken in this event.' : error.message);
      const { error: rpcErr } = await temp.rpc('redeem_join_code', {
        p_code: event.join_code, p_name: name, p_handicap: Number(newPlayer.handicap) || 0
      });
      if (rpcErr) throw rpcErr;
      await temp.auth.signOut();
      flash(`Added ${name} — PIN ${newPlayer.pin}`);
      setNewPlayer({ name: '', handicap: '', pin: '' });
      load();
    } catch (e) {
      flash(e.message || String(e));
    } finally {
      setAddingPlayer(false);
    }
  }

  const setHole = (i, key, val) => setCourse(c => {
    const holes = c.holes.map((h, idx) => idx === i ? { ...h, [key]: Number(val) } : h);
    return { ...c, holes };
  });

  // Switch between a 9- and 18-hole course, preserving any edited pars/stroke indexes:
  // keep the first n holes when shrinking, append defaults when growing.
  const setHoleCount = n => setCourse(c => {
    const cur = c.holes || [];
    const holes = n <= cur.length ? cur.slice(0, n) : [...cur, ...makeHoles(n).slice(cur.length)];
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
        <div className="row" style={{ margin: '4px 0 12px' }}>
          <span className="muted">Holes:</span>
          <button className={course.holes.length === 9 ? 'primary' : ''} onClick={() => setHoleCount(9)}>9</button>
          <button className={course.holes.length === 18 ? 'primary' : ''} onClick={() => setHoleCount(18)}>18</button>
        </div>
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
                  <span>
                    <input
                      className="name-edit"
                      value={names[p.id] ?? p.display_name}
                      onChange={e => setNames(n => ({ ...n, [p.id]: e.target.value }))}
                      onBlur={() => saveDisplayName(p.id)}
                    />
                    {' '}(<input
                      type="number" step="0.1" className="hcap-edit"
                      value={handicaps[p.id] ?? p.handicap}
                      onChange={e => setHandicaps(h => ({ ...h, [p.id]: e.target.value }))}
                      onBlur={() => saveHandicap(p.id)}
                    />) <span className="dim">· {p.role}</span>
                  </span>
                  {resetId === p.id ? (
                    <span className="row">
                      <input inputMode="numeric" maxLength={4} placeholder="New PIN" autoFocus
                        value={resetPin} onChange={e => setResetPin(e.target.value.replace(/\D/g, ''))}
                        style={{ width: 90 }} />
                      <button className="primary" onClick={() => resetPlayerPin(p)}>Save</button>
                      <button onClick={() => { setResetId(null); setResetPin(''); }}>Cancel</button>
                    </span>
                  ) : (
                    <span className="row">
                      {p.role !== 'organizer'
                        ? <button onClick={() => setOrganizerRole(p, true)}>Make organizer</button>
                        : p.id !== profile.id && <button onClick={() => setOrganizerRole(p, false)}>Remove organizer</button>
                      }
                      <button onClick={() => { setResetId(p.id); setResetPin(''); }}>Reset PIN</button>
                      <button onClick={() => removePlayer(p)}>✕ Remove</button>
                    </span>
                  )}
                </li>
              ))}
            </ul>}
        <div className="addplayer">
          <input placeholder="Name" value={newPlayer.name}
            onChange={e => setNewPlayer({ ...newPlayer, name: e.target.value })} />
          <input type="number" step="0.1" placeholder="Handicap" value={newPlayer.handicap}
            onChange={e => setNewPlayer({ ...newPlayer, handicap: e.target.value })} />
          <input inputMode="numeric" maxLength={4} placeholder="4-digit PIN" value={newPlayer.pin}
            onChange={e => setNewPlayer({ ...newPlayer, pin: e.target.value.replace(/\D/g, '') })} />
          <button className="primary" disabled={addingPlayer} onClick={addPlayer}>
            {addingPlayer ? 'Adding…' : 'Add player'}
          </button>
        </div>
        <p className="muted small">Share the PIN with the player — they log in with the join code, their name, and this PIN.</p>
      </section>

      <section className="card">
        <h3>Rounds</h3>
        {rounds.length === 0
          ? <button className="primary" onClick={createRounds}>Create the 3 rounds</button>
          : rounds.map((r, i) => (
            <div className="roundrow" key={r.id}>
              <button className="btn-icon" onClick={() => removeRound(r)} title="Remove round">✕</button>
              <input value={r.name} onChange={e => setRounds(rs => rs.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
              <select value={r.format} onChange={e => setRounds(rs => rs.map((x, j) => j === i ? { ...x, format: e.target.value } : x))}>
                {FORMATS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
              <button onClick={() => saveRound(r)}>Save</button>
            </div>
          ))}
        {rounds.length > 0 && <button onClick={addRound} style={{ marginTop: 8 }}>+ Add round</button>}
      </section>
    </div>
  );
}

