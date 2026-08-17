import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';

export default function Signup() {
  const [form, setForm] = useState({ email: '', password: '', name: '', handicap: '', code: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const { refreshProfile } = useAuth();
  const set = k => e => setForm({ ...form, [k]: e.target.value });

  async function submit() {
    setErr(''); setBusy(true);
    try {
      // 1) create the auth user (or sign in if it already exists)
      let { error } = await supabase.auth.signUp({ email: form.email, password: form.password });
      if (error && !/already registered/i.test(error.message)) throw error;
      if (error) {
        const s = await supabase.auth.signInWithPassword({ email: form.email, password: form.password });
        if (s.error) throw s.error;
      }
      // 2) redeem the join code -> creates the profile with name + handicap
      const { error: rpcErr } = await supabase.rpc('redeem_join_code', {
        p_code: form.code.trim(),
        p_name: form.name.trim(),
        p_handicap: Number(form.handicap)
      });
      if (rpcErr) throw rpcErr;
      await refreshProfile();
      nav('/');
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card narrow">
      <h1>Join the event</h1>
      <input placeholder="Event join code" value={form.code} onChange={set('code')} />
      <input placeholder="Your name" value={form.name} onChange={set('name')} />
      <input type="number" step="0.1" placeholder="Handicap (e.g. 14)" value={form.handicap} onChange={set('handicap')} />
      <hr />
      <input placeholder="Email" value={form.email} onChange={set('email')} />
      <input type="password" placeholder="Password" value={form.password} onChange={set('password')} />
      {err && <p className="err">{err}</p>}
      <button className="primary" disabled={busy} onClick={submit}>{busy ? 'Joining…' : 'Join'}</button>
      <p className="muted">Already joined? <Link to="/login">Sign in</Link></p>
    </div>
  );
}
