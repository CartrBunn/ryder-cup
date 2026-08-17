import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { supabase } from '../supabaseClient';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const nav = useNavigate();

  async function submit() {
    setErr('');
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return setErr(error.message);
    nav('/');
  }

  return (
    <div className="card narrow">
      <h1>Sign in</h1>
      <input placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} />
      <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} />
      {err && <p className="err">{err}</p>}
      <button className="primary" onClick={submit}>Sign in</button>
      <p className="muted">New here? <Link to="/signup">Join the event</Link></p>
      <p className="muted">Organizing? <Link to="/start">Start a new event</Link></p>
    </div>
  );
}
