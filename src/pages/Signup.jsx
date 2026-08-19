import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';
import { playerCreds } from '../lib/playerAuth';

// Players join with just name + join code + PIN — no email.
export default function Signup() {
  const [form, setForm] = useState({ name: '', handicap: '', code: '', pin: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const { refreshProfile } = useAuth();
  const set = k => e => setForm({ ...form, [k]: e.target.value });

  async function submit() {
    setErr('');
    if (!form.code.trim() || !form.name.trim()) return setErr('Enter your name and the join code.');
    if (!/^\d{4}$/.test(form.pin)) return setErr('Choose a 4-digit PIN.');
    setBusy(true);
    try {
      const { email, password } = playerCreds(form);
      // Create the player's hidden account. If it already exists, this name is taken in the event.
      const { error } = await supabase.auth.signUp({ email, password });
      if (error) {
        if (/already registered/i.test(error.message))
          throw new Error('That name is already taken in this event — add a last initial, or use Log in if it\'s you.');
        throw error;
      }
      const s = await supabase.auth.signInWithPassword({ email, password });
      if (s.error) throw s.error;
      const { error: rpcErr } = await supabase.rpc('redeem_join_code', {
        p_code: form.code.trim(),
        p_name: form.name.trim(),
        p_handicap: Number(form.handicap) || 0
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
      <input inputMode="numeric" maxLength={4} placeholder="Pick a 4-digit PIN" value={form.pin}
        onChange={e => setForm({ ...form, pin: e.target.value.replace(/\D/g, '') })} />
      {err && <p className="err">{err}</p>}
      <button className="primary" disabled={busy} onClick={submit}>{busy ? 'Joining…' : 'Join'}</button>
      <p className="muted">Already joined? <Link to="/login">Log in</Link></p>
      <p className="muted">Organizing? <Link to="/start">Start a new event</Link></p>
    </div>
  );
}
