import { Fragment, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';
import { copyPlayers } from '../lib/copyPlayers';
import { nextYear } from '../lib/nextYear';

// An organizer account's events: open one to work on it, start a new one, or copy one for
// next year (course, settings and players — not teams, rounds or matchups).
export default function Events() {
  const { profile, realProfile, switchEvent, refreshProfile } = useAuth();
  const nav = useNavigate();
  const [events, setEvents] = useState(null);
  const [counts, setCounts] = useState({});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', code: '' });
  const [copyFrom, setCopyFrom] = useState(null);   // event being copied
  const [result, setResult] = useState(null);       // { event, added, skipped, failed }

  async function load() {
    const { data, error } = await supabase.from('event_organizers')
      .select('events(*)').eq('user_id', realProfile.id);
    if (error) { setErr(error.message); return; }
    const evts = data.map(r => r.events).filter(Boolean)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    setEvents(evts);
    const { data: ps } = await supabase.from('profiles').select('event_id').in('event_id', evts.map(e => e.id));
    const c = {};
    for (const p of ps || []) c[p.event_id] = (c[p.event_id] || 0) + 1;
    setCounts(c);
  }
  useEffect(() => { load(); }, [realProfile.id]);

  async function open(e) {
    setErr('');
    try {
      if (e.id !== profile.event_id) await switchEvent(e.id);
      nav('/');
    } catch (x) { setErr(x.message || String(x)); }
  }

  function startCopy(e) {
    setCreating(false); setResult(null); setErr('');
    setCopyFrom(e);
    setForm({ name: nextYear(e.name) || e.name + ' (copy)', code: nextYear(e.join_code) });
  }
  function startNew() {
    setCopyFrom(null); setResult(null); setErr('');
    setCreating(true);
    setForm({ name: 'Company Ryder Cup', code: '' });
  }
  const cancel = () => { setCopyFrom(null); setCreating(false); };

  async function create() {
    const name = form.name.trim(), code = form.code.trim();
    if (!name || !code) return setErr('Enter a name and a join code.');
    setErr(''); setBusy('Creating the event…');
    try {
      const { data: id, error } = copyFrom
        ? await supabase.rpc('copy_event', { p_source: copyFrom.id, p_name: name, p_join_code: code })
        : await supabase.rpc('create_event', { p_name: name, p_join_code: code, p_organizer_name: realProfile.display_name });
      if (error) throw error;
      await refreshProfile();   // the new event is now the active one
      if (!copyFrom) { nav('/admin'); return; }
      const event = { id, name, join_code: code };
      const r = await copyPlayers({
        fromEventId: copyFrom.id, toEvent: event,
        onProgress: (i, n) => setBusy(n ? `Copying players… ${i} of ${n}` : 'Copying players…')
      });
      setCopyFrom(null);
      if (!r.failed.length) { nav('/admin'); return; }
      setResult({ event, ...r });   // stay here so the organizer sees who didn't copy
      load();
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy('');
    }
  }

  if (!events) return <div className="center">{err ? <p className="err">{err}</p> : 'Loading events…'}</div>;

  const formCard = (copyFrom || creating) && (
    <section className="card">
      <h3>{copyFrom ? `Copy “${copyFrom.name}”` : 'New event'}</h3>
      {copyFrom && <p className="muted small">Brings over the course, handicap allowances, scoring,
        players and organizers. Teams, captains, rounds and matchups start fresh. Players join with the new code,
        their name, and a new PIN they pick.</p>}
      <label>Event name<input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></label>
      <label>Join code<input value={form.code} placeholder="e.g. BIRDIE27"
        onChange={e => setForm({ ...form, code: e.target.value })} /></label>
      <p className="muted small">Players sign in with this code, so it can't change once they've joined.</p>
      <div className="row">
        <button className="primary" disabled={!!busy} onClick={create}>
          {busy || (copyFrom ? 'Create copy' : 'Create event')}
        </button>
        <button disabled={!!busy} onClick={cancel}>Cancel</button>
      </div>
    </section>
  );

  return (
    <div className="stack">
      <div className="row between">
        <h1>Your events</h1>
        {!creating && <button className="primary" onClick={startNew}>+ New event</button>}
      </div>
      {err && <p className="err">{err}</p>}
      {result && (
        <div className="flash">
          Created {result.event.name}: copied {result.added} player{result.added === 1 ? '' : 's'}
          {result.skipped > 0 && `, ${result.skipped} already there`}. {result.failed.length} didn't copy:
          <ul>{result.failed.map(f => <li key={f.name}>{f.name} — {f.error}</li>)}</ul>
          You can try them again from Setup → Players → Copy players.
          <div><button className="primary" onClick={() => nav('/admin')}>Go to setup</button></div>
        </div>
      )}
      {creating && formCard}
      {events.length === 0 && <p className="muted">No events yet — start one above.</p>}
      {events.map(e => (
        <Fragment key={e.id}>
          <section className="card">
            <div className="row between">
              <h3>{e.name}{e.id === profile.event_id && <span className="tag">Current</span>}</h3>
              <span className="muted small">{new Date(e.created_at).getFullYear()}</span>
            </div>
            <p className="muted small">Join code {e.join_code} · {counts[e.id] || 0} player{counts[e.id] === 1 ? '' : 's'}</p>
            <div className="row">
              <button className="primary" onClick={() => open(e)}>{e.id === profile.event_id ? 'Go to event' : 'Open'}</button>
              <button onClick={() => startCopy(e)}>Copy for next year</button>
            </div>
          </section>
          {copyFrom?.id === e.id && formCard}
        </Fragment>
      ))}
    </div>
  );
}
