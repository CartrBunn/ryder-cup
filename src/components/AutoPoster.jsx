import { useEffect } from 'react';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';
import { loadEvent } from '../lib/loadEvent';
import { desiredPosts, eventFingerprint, planAutoOps } from '../lib/automations';

const QUIET = 3000;      // ms after the last change before checking (lets a burst of edits settle)
const JITTER = 2000;     // spread devices out so they don't all post at the same instant
const MAX_STALE = 5;     // retries in a row when the data changed under us

// Keeps the automated chat posts in step with the scores. No UI. Runs on every open device;
// the server makes racing devices produce one post, and rejects a post computed from stale
// data (see post_auto_message in supabase/schema.sql).
export default function AutoPoster() {
  const { realProfile } = useAuth();
  const evt = realProfile?.event_id;

  useEffect(() => {
    if (!evt || !globalThis.crypto?.subtle) return;   // hashing needs a secure (https) page
    let timer, running = false, again = false, stale = 0, dead = false;
    const schedule = (ms = QUIET + Math.random() * JITTER) => {
      clearTimeout(timer);
      timer = setTimeout(run, ms);
    };

    async function run() {
      if (dead || document.hidden) return;            // becoming visible schedules a run
      if (running) { again = true; return; }
      running = true;
      try {
        const [data, existing] = await Promise.all([
          loadEvent(evt),
          supabase.from('messages').select('auto_key, auto_sig, kind, retracted')
            .eq('event_id', evt).not('auto_key', 'is', null)
            .then(({ data, error }) => { if (error) throw error; return data; })
        ]);
        const ops = planAutoOps(desiredPosts(data), existing);
        if (ops.length) {
          const fingerprint = await eventFingerprint(data);
          for (const op of ops) {
            const { data: res, error } = await supabase.rpc('post_auto_message', {
              p_event: evt, p_key: op.key, p_kind: op.kind, p_body: op.body, p_sig: op.sig,
              p_fingerprint: fingerprint, p_retract: op.retract
            });
            if (error) throw error;
            if (res === 'stale') { if (++stale <= MAX_STALE) again = true; break; }
          }
        }
        if (!again) stale = 0;
      } catch (e) {
        console.warn('Automated posts:', e.message || e);
      }
      running = false;
      if (again && !dead) { again = false; schedule(); }
    }

    const ch = supabase.channel('auto-' + evt)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'hole_scores' }, () => schedule())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'matches', filter: `event_id=eq.${evt}` }, () => schedule())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rounds', filter: `event_id=eq.${evt}` }, () => schedule())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles', filter: `event_id=eq.${evt}` }, () => schedule())
      .subscribe();
    const onVisible = () => { if (!document.hidden) schedule(1000); };
    document.addEventListener('visibilitychange', onVisible);
    schedule(1500);
    return () => {
      dead = true;
      clearTimeout(timer);
      supabase.removeChannel(ch);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [evt]);

  return null;
}
