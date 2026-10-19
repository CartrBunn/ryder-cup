import { createContext, useContext, useEffect, useState } from 'react';
import { supabase } from '../supabaseClient';
import { resyncPush } from '../lib/push';

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  // Organizer accounts' row: { user_id, active_event_id }; null for players.
  const [organizer, setOrganizer] = useState(null);
  const [loading, setLoading] = useState(true);
  const [isRecovery, setIsRecovery] = useState(false);
  // Organizers can preview the app as a player or as a team's captain sees it.
  // null | { role: 'player' } | { role: 'captain', teamId } | { role: 'spectator' } (tournament day: read-only). UI-only: database permissions are unchanged.
  const [viewAs, setViewAsState] = useState(() => {
    try { return JSON.parse(localStorage.getItem('viewAs')) || null; } catch { return null; }
  });
  const setViewAs = v => {
    setViewAsState(v);
    try { localStorage.setItem('viewAs', JSON.stringify(v)); } catch {}
  };

  async function loadProfile(userId) {
    if (!userId) { setProfile(null); setOrganizer(null); return; }
    const [{ data }, { data: org }] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', userId).maybeSingle(),
      supabase.from('organizers').select('*').eq('user_id', userId).maybeSingle()
    ]);
    setProfile(data || null);
    setOrganizer(org || null);
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

  // An organizer account works on one of its events at a time. Its own profile only belongs to
  // an event if it was a player there before events were multi-event, so elsewhere it's on no team.
  const baseProfile = profile && organizer ? {
    ...profile,
    event_id: organizer.active_event_id,
    role: 'organizer',
    team_id: organizer.active_event_id === profile.event_id ? profile.team_id : null,
    isOrganizerAccount: true
  } : profile;

  async function switchEvent(eventId) {
    const { error } = await supabase.rpc('switch_event', { p_event: eventId });
    if (error) throw error;
    setViewAs(null);   // a captain preview names a team in the old event
    setOrganizer(o => ({ ...o, active_event_id: eventId }));
    resyncPush().catch(() => {});   // this phone's notifications follow the event
  }

  const preview = baseProfile?.role === 'organizer' ? viewAs : null;
  const effectiveProfile = preview ? { ...baseProfile, role: preview.role } : baseProfile;
  // The team this user captains. In a preview it's the previewed team (or none for player view),
  // so an organizer who also captains a team doesn't see their own captain controls.
  const myTeamIdFor = teams => preview
    ? preview.teamId || undefined
    : teams.find(t => t.captain_id === profile?.id)?.id;

  return (
    <AuthCtx.Provider value={{
      session, profile: effectiveProfile, realProfile: baseProfile, loading, refreshProfile, switchEvent,
      isRecovery, setIsRecovery, viewAs: preview, spectator: preview?.role === 'spectator', setViewAs, myTeamIdFor,
    }}>
      {children}
    </AuthCtx.Provider>
  );
}
