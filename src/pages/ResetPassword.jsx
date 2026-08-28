import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';

export default function ResetPassword() {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const { setIsRecovery } = useAuth();

  async function submit() {
    if (password.length < 6) return setErr('Password must be at least 6 characters.');
    if (password !== confirm) return setErr('Passwords do not match.');
    setBusy(true); setErr('');
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setIsRecovery(false);
      setDone(true);
      setTimeout(() => nav('/'), 2000);
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  if (done) return <div className="card narrow"><p>Password updated! Redirecting…</p></div>;

  return (
    <div className="card narrow">
      <h1>Set new password</h1>
      <input type="password" placeholder="New password" value={password}
        onChange={e => setPassword(e.target.value)} />
      <input type="password" placeholder="Confirm new password" value={confirm}
        onChange={e => setConfirm(e.target.value)} />
      {err && <p className="err">{err}</p>}
      <button className="primary" disabled={busy} onClick={submit}>
        {busy ? 'Saving…' : 'Set password'}
      </button>
    </div>
  );
}
