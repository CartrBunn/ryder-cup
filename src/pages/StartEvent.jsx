import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';

// Bootstrap page: creates the organizer's account AND the event in one step.
// Reachable without being signed in, so a brand-new organizer can start here.
export default function StartEvent() {
  const [f, setF] = useState({ email: '', password: '', name: '', event: 'Company Ryder Cup', code: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const { refreshProfile } = useAuth();
  const nav = useNavigate();
  const set = k => e => setF({ ...f, [k]: e.target.value });

  async function go() {
    setErr(''); setBusy(true);
    try {
      let { error } = await supabase.auth.signUp({ email: f.email, password: f.password });
      if (error && !/already registered/i.test(error.message)) throw error;
      // sign in (covers both "just signed up" without a session and "already registered")
      const s = await supabase.auth.signInWithPassword({ email: f.email, password: f.password });
      if (s.error) throw new Error(
        /email/i.test(s.error.message)
          ? 'Could not sign in. If email confirmation is ON in Supabase, turn it off (Authentication → Settings) for a quick event.'
          : s.error.message);
      const { error: rpcErr } = await supabase.rpc('create_event',
        { p_name: f.event, p_join_code: f.code.trim(), p_organizer_name: f.name.trim() });
      if (rpcErr) throw rpcErr;
      await refreshProfile();
      nav('/admin');           // straight into event setup
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card narrow">
      <h1>Start an event</h1>
      <p className="muted">You'll be the organizer. Share the join code with players so they can sign up.</p>
      <input placeholder="Event name" value={f.event} onChange={set('event')} />
      <input placeholder="Join code to hand out (e.g. BIRDIE26)" value={f.code} onChange={set('code')} />
      <input placeholder="Your name" value={f.name} onChange={set('name')} />
      <hr />
      <input placeholder="Email" value={f.email} onChange={set('email')} />
      <input type="password" placeholder="Password" value={f.password} onChange={set('password')} />
      {err && <p className="err">{err}</p>}
      <button className="primary" disabled={busy} onClick={go}>{busy ? 'Creating…' : 'Create event'}</button>
      <p className="muted">Joining an existing event? <Link to="/signup">Sign up here</Link></p>
    </div>
  );
}
