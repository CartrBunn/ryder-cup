import { useState, useEffect } from 'react';
import { Routes, Route, Navigate, Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import { supabase } from './supabaseClient';
import Login from './pages/Login';
import Signup from './pages/Signup';
import Lobby from './pages/Lobby';
import AdminSetup from './pages/AdminSetup';
import Draft from './pages/Draft';
import Matchups from './pages/Matchups';
import ScoreEntry from './pages/ScoreEntry';
import StartEvent from './pages/StartEvent';
import ResetPassword from './pages/ResetPassword';

function Nav() {
  const { session, profile } = useAuth();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  if (!session) return null;
  const isAdmin = profile && ['organizer', 'captain'].includes(profile.role);
  async function logout() {
    await supabase.auth.signOut();
    nav('/login');
  }
  const close = () => setOpen(false);
  return (
    <nav className="nav">
      <Link to="/" className="brand" onClick={close}>⛳ Ryder Cup</Link>
      <button className="hamburger" onClick={() => setOpen(o => !o)} aria-label="Menu">
        {open ? '✕' : '☰'}
      </button>
      <div className={open ? 'navlinks open' : 'navlinks'}>
        {profile && <Link to="/" onClick={close}>Leaderboard</Link>}
        {profile && <Link to="/draft" onClick={close}>Draft</Link>}
        {isAdmin && <Link to="/matchups" onClick={close}>Matchups</Link>}
        {profile?.role === 'organizer' && <Link to="/admin" onClick={close}>Setup</Link>}
      </div>
      {profile && <span className="whoami">{profile.display_name} · {profile.role}</span>}
      <button className="logout" onClick={logout}>Log out</button>
    </nav>
  );
}

function Protected({ children, need }) {
  const { session, profile, loading } = useAuth();
  if (loading) return <div className="center">Loading…</div>;
  if (!session) return <Navigate to="/login" replace />;
  if (!profile) return <Navigate to="/signup" replace />;
  if (need && !need.includes(profile.role)) return <Navigate to="/" replace />;
  return children;
}

function RecoveryRedirect() {
  const { isRecovery } = useAuth();
  const nav = useNavigate();
  useEffect(() => { if (isRecovery) nav('/reset-password', { replace: true }); }, [isRecovery]);
  return null;
}

export default function App() {
  return (
    <>
      <RecoveryRedirect />
      <Nav />
      <main className="page">
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/start" element={<StartEvent />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/" element={<Protected><Lobby /></Protected>} />
          <Route path="/match/:id" element={<Protected><ScoreEntry /></Protected>} />
          <Route path="/draft" element={<Protected><Draft /></Protected>} />
          <Route path="/matchups" element={<Protected need={['organizer','captain']}><Matchups /></Protected>} />
          <Route path="/admin" element={<Protected need={['organizer']}><AdminSetup /></Protected>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </>
  );
}
