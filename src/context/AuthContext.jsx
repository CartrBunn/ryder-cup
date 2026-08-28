import { createContext, useContext, useEffect, useState } from 'react';
import { supabase } from '../supabaseClient';

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [isRecovery, setIsRecovery] = useState(false);

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

  return (
    <AuthCtx.Provider value={{ session, profile, loading, refreshProfile, isRecovery, setIsRecovery }}>
      {children}
    </AuthCtx.Provider>
  );
}
