import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';
import { playerCreds } from '../lib/playerAuth';

export default function Login() {
  const [mode, setMode] = useState('player');           // 'player' | 'organizer'
  const [player, setPlayer] = useState({ code: '', name: '', pin: '' });
  const [org, setOrg] = useState({ email: '', password: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const { refreshProfile } = useAuth();

  async function submit() {
    setErr(''); setBusy(true);
    try {
      if (mode === 'player') {
        const { email, password } = playerCreds(player);
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw new Error('Check your name, join code, and PIN.');
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: org.email, password: org.password });
        if (error) throw error;
      }
      await refreshProfile();
      nav('/');
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  const setP = k => e => setPlayer({ ...player, [k]: e.target.value });
  const setO = k => e => setOrg({ ...org, [k]: e.target.value });

  return (
    <div className="card narrow">
      <h1>Sign in</h1>
      <div className="row" style={{ marginBottom: 12 }}>
        <button className={mode === 'player' ? 'primary' : ''} onClick={() => { setMode('player'); setErr(''); }}>Player</button>
        <button className={mode === 'organizer' ? 'primary' : ''} onClick={() => { setMode('organizer'); setErr(''); }}>Organizer</button>
      </div>

      {mode === 'player' ? (
        <>
          <input placeholder="Event join code" value={player.code} onChange={setP('code')} />
          <input placeholder="Your name" value={player.name} onChange={setP('name')} />
          <input inputMode="numeric" type="password" maxLength={4} placeholder="4-digit PIN"
            value={player.pin} onChange={e => setPlayer({ ...player, pin: e.target.value.replace(/\D/g, '') })} />
        </>
      ) : (
        <>
          <input placeholder="Email" value={org.email} onChange={setO('email')} />
          <input type="password" placeholder="Password" value={org.password} onChange={setO('password')} />
        </>
      )}

      {err && <p className="err">{err}</p>}
      <button className="primary" disabled={busy} onClick={submit}>{busy ? 'Signing in…' : 'Sign in'}</button>
      <p className="muted">New here? <Link to="/signup">Join the event</Link></p>
      <p className="muted">Organizing? <Link to="/start">Start a new event</Link></p>
    </div>
  );
}
