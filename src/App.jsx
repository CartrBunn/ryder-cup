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

function Nav() {
  const { session, profile } = useAuth();
  const loc = useLocation();
  const nav = useNavigate();
  if (!session) return null;
  const isAdmin = profile && ['organizer', 'captain'].includes(profile.role);
  async function logout() {
    await supabase.auth.signOut();
    nav('/login');
  }
  return (
    <nav className="nav">
      <Link to="/" className="brand">⛳ Ryder Cup</Link>
      <div className="navlinks">
        <Link to="/">Leaderboard</Link>
        {isAdmin && <Link to="/draft">Draft</Link>}
        {isAdmin && <Link to="/matchups">Matchups</Link>}
        {profile?.role === 'organizer' && <Link to="/admin">Setup</Link>}
      </div>
      <span className="whoami">{profile?.display_name} · {profile?.role}</span>
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

export default function App() {
  return (
    <>
      <Nav />
      <main className="page">
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/start" element={<StartEvent />} />
          <Route path="/" element={<Protected><Lobby /></Protected>} />
          <Route path="/match/:id" element={<Protected><ScoreEntry /></Protected>} />
          <Route path="/draft" element={<Protected need={['organizer','captain']}><Draft /></Protected>} />
          <Route path="/matchups" element={<Protected need={['organizer','captain']}><Matchups /></Protected>} />
          <Route path="/admin" element={<Protected need={['organizer']}><AdminSetup /></Protected>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </>
  );
}
