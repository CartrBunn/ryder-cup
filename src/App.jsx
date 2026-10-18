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
import Chat from './pages/Chat';
import Caddie from './pages/Caddie';
import { ChatProvider, useChat } from './context/ChatContext';
import AutoPoster from './components/AutoPoster';
import Alerts from './components/Alerts';
import { disablePush } from './lib/push';

function Nav() {
  const { session, profile, realProfile, viewAs, setViewAs, spectator } = useAuth();
  const { unread } = useChat();
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
    await disablePush().catch(() => {});   // this device shouldn't keep getting the last user's pushes
    await supabase.auth.signOut();
    nav('/login');
  }
  const close = () => setOpen(false);
  // Tournament day is locked: leaving it needs the organizer's password again.
  async function exitTournamentDay() {
    const pw = window.prompt('Organizer password to exit tournament day view:');
    if (!pw) return;
    const { error } = await supabase.auth.signInWithPassword({ email: session.user.email, password: pw });
    if (error) { window.alert('Wrong password.'); return; }
    setViewAs(null);
  }
  if (spectator) return (
    <nav className="nav">
      <Link to="/" className="brand" onClick={close}>Ryder Cup</Link>
      <button className="hamburger" onClick={() => setOpen(o => !o)} aria-label="Menu">
        {open ? '✕' : '☰'}
        {!open && unread > 0 && <span className="navdot" />}
      </button>
      <div className={open ? 'navlinks open' : 'navlinks'}>
        <Link to="/" onClick={close}>Leaderboard</Link>
        <Link to="/prizes" onClick={close}>Individual Leaderboard</Link>
        <Link to="/chat" className="chatlink" onClick={close}>Chat{unread > 0 && <span className="badge">{unread > 99 ? '99+' : unread}</span>}</Link>
        <Link to="/draft" onClick={close}>Draft</Link>
      </div>
      <button className="logout" onClick={exitTournamentDay}>Exit</button>
    </nav>
  );
  const viewValue = !viewAs ? '' : viewAs.role === 'player' || viewAs.role === 'spectator' ? viewAs.role : 'captain:' + viewAs.teamId;
  function changeView(v) {
    setViewAs(!v ? null : v === 'player' || v === 'spectator' ? { role: v } : { role: 'captain', teamId: v.slice(8) });
    close();
  }
  const previewTeam = teams.find(t => t.id === viewAs?.teamId)?.name;
  return (
    <>
    <nav className="nav">
      <Link to="/" className="brand" onClick={close}>Ryder Cup</Link>
      <button className="hamburger" onClick={() => setOpen(o => !o)} aria-label="Menu">
        {open ? '✕' : '☰'}
        {!open && unread > 0 && <span className="navdot" />}
      </button>
      <div className={open ? 'navlinks open' : 'navlinks'}>
        {profile && <Link to="/" onClick={close}>Leaderboard</Link>}
        {profile && <Link to="/prizes" onClick={close}>Individual Leaderboard</Link>}
        {profile && <Link to="/chat" className="chatlink" onClick={close}>Chat{unread > 0 && <span className="badge">{unread > 99 ? '99+' : unread}</span>}</Link>}
        {profile && <Link to="/draft" onClick={close}>Draft</Link>}
        {isAdmin && <Link to="/matchups" onClick={close}>Matchups</Link>}
        {profile?.role === 'organizer' && <Link to="/admin" onClick={close}>Setup</Link>}
      </div>
      {profile && <span className="whoami">{profile.display_name} · {profile.role}</span>}
      {canPreview && (
        <select className="viewas" value={viewValue} onChange={e => changeView(e.target.value)} aria-label="View as">
          <option value="">Organizer view</option>
          <option value="player">Player view</option>
          <option value="spectator">Tournament day view</option>
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

const SPECTATOR_PATHS = ['/', '/prizes', '/chat', '/draft'];

function Protected({ children, need }) {
  const { session, profile, loading, spectator } = useAuth();
  const { pathname } = useLocation();
  if (loading) return <div className="center">Loading…</div>;
  if (!session) return <Navigate to="/login" replace />;
  if (!profile) return <Navigate to="/signup" replace />;
  if (spectator && !SPECTATOR_PATHS.includes(pathname) && !pathname.startsWith('/match/')) return <Navigate to="/" replace />;
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
  const { profile } = useAuth();
  return (
    <ChatProvider>
      <RecoveryRedirect />
      <Nav />
      {profile && <><AutoPoster /><Alerts /></>}
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
          <Route path="/chat" element={<Protected><Chat /></Protected>} />
          <Route path="/matchups" element={<Protected need={['organizer','captain']}><Matchups /></Protected>} />
          {/* Hidden: not linked from the nav — reachable only by this URL. */}
          <Route path="/caddie-ed19b8ad" element={<Protected><Caddie /></Protected>} />
          <Route path="/admin" element={<Protected need={['organizer']}><AdminSetup /></Protected>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </ChatProvider>
  );
}
