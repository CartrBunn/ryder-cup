import { createContext, useContext, useEffect, useState } from 'react';
import { supabase } from '../supabaseClient';

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [isRecovery, setIsRecovery] = useState(false);
  // Organizers can preview the app as a player or as a team's captain sees it.
  // null | { role: 'player' } | { role: 'captain', teamId }. UI-only: database permissions are unchanged.
  const [viewAs, setViewAsState] = useState(() => {
    try { return JSON.parse(localStorage.getItem('viewAs')) || null; } catch { return null; }
  });
  const setViewAs = v => {
    setViewAsState(v);
    try { localStorage.setItem('viewAs', JSON.stringify(v)); } catch {}
  };

  async function loadProfile(userId) {
    if (!userId) { setProfile(null); return; }
    const { data } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle();
    setProfile(data || null);
  }

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session);
      await loadProfile(data.session?.user?.id);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange(async (_e, s) => {
      if (_e === 'PASSWORD_RECOVERY') setIsRecovery(true);
      setSession(s);
      await loadProfile(s?.user?.id);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // Fetch the session fresh rather than trusting the closed-over `session` state, which
  // can be stale right after a sign-in (e.g. the join flow signs in then loads the profile).
  const refreshProfile = async () => {
    const { data } = await supabase.auth.getSession();
    await loadProfile(data.session?.user?.id);
  };

  const preview = profile?.role === 'organizer' ? viewAs : null;
  const effectiveProfile = preview ? { ...profile, role: preview.role } : profile;
  // The team this user captains. In a preview it's the previewed team (or none for player view),
  // so an organizer who also captains a team doesn't see their own captain controls.
  const myTeamIdFor = teams => preview
    ? preview.teamId || undefined
    : teams.find(t => t.captain_id === profile?.id)?.id;

  return (
    <AuthCtx.Provider value={{
      session, profile: effectiveProfile, realProfile: profile, loading, refreshProfile,
      isRecovery, setIsRecovery, viewAs: preview, setViewAs, myTeamIdFor,
    }}>
      {children}
    </AuthCtx.Provider>
  );
}
