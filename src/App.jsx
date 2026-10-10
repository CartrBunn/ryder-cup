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
import Prizes from './pages/Prizes';

function Nav() {
  const { session, profile, realProfile, viewAs, setViewAs } = useAuth();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [teams, setTeams] = useState([]);
  const canPreview = realProfile?.role === 'organizer';
  useEffect(() => {
    if (!canPreview || !realProfile.event_id) return;
    supabase.from('teams').select('id, name').eq('event_id', realProfile.event_id).order('name')
      .then(({ data }) => setTeams(data || []));
  }, [canPreview, realProfile?.event_id]);
  if (!session) return null;
  const isAdmin = profile && ['organizer', 'captain'].includes(profile.role);
  async function logout() {
    await supabase.auth.signOut();
    nav('/login');
  }
  const close = () => setOpen(false);
  const viewValue = !viewAs ? '' : viewAs.role === 'player' ? 'player' : 'captain:' + viewAs.teamId;
  function changeView(v) {
    setViewAs(!v ? null : v === 'player' ? { role: 'player' } : { role: 'captain', teamId: v.slice(8) });
    close();
  }
  const previewTeam = teams.find(t => t.id === viewAs?.teamId)?.name;
  return (
    <>
    <nav className="nav">
      <Link to="/" className="brand" onClick={close}>Ryder Cup</Link>
      <button className="hamburger" onClick={() => setOpen(o => !o)} aria-label="Menu">
        {open ? '✕' : '☰'}
      </button>
      <div className={open ? 'navlinks open' : 'navlinks'}>
        {profile && <Link to="/" onClick={close}>Leaderboard</Link>}
        {profile && <Link to="/prizes" onClick={close}>Individual Leaderboard</Link>}
        {profile && <Link to="/draft" onClick={close}>Draft</Link>}
        {isAdmin && <Link to="/matchups" onClick={close}>Matchups</Link>}
        {profile?.role === 'organizer' && <Link to="/admin" onClick={close}>Setup</Link>}
      </div>
      {profile && <span className="whoami">{profile.display_name} · {profile.role}</span>}
      {canPreview && (
        <select className="viewas" value={viewValue} onChange={e => changeView(e.target.value)} aria-label="View as">
          <option value="">Organizer view</option>
          <option value="player">Player view</option>
          {teams.map(t => <option key={t.id} value={'captain:' + t.id}>Captain view: {t.name}</option>)}
        </select>
      )}
      <button className="logout" onClick={logout}>Log out</button>
    </nav>
    {viewAs && (
      <div className="previewbar">
        <span>{viewAs.role === 'player'
          ? "Player view: you're seeing what players see."
          : `Captain view: you're seeing what the ${previewTeam || 'team'} captain sees. Actions you take are real.`}</span>
        <button onClick={() => setViewAs(null)}>Back to organizer view</button>
      </div>
    )}
    </>
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
          <Route path="/prizes" element={<Protected><Prizes /></Protected>} />
          <Route path="/matchups" element={<Protected need={['organizer','captain']}><Matchups /></Protected>} />
          <Route path="/admin" element={<Protected need={['organizer']}><AdminSetup /></Protected>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </>
  );
}
