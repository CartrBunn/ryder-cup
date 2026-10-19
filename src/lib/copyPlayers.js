import { supabase, createTempClient } from '../supabaseClient';
import { playerCreds, slug } from './playerAuth';

// Bring one event's players (name + handicap) into another, e.g. last year's into this year's.
// A player login is tied to its event's join code, so each one gets a new account under the new
// code with a throwaway password, marked unclaimed: they pick a PIN when they Join with the new
// code (claim_player in supabase/schema.sql), or the organizer resets one. Organizer accounts
// and names already in the target event are skipped, so this is safe to run again to finish
// a copy that stopped partway.
// Returns { added, skipped, failed: [{ name, error }] }.
export async function copyPlayers({ fromEventId, toEvent, onProgress }) {
  const must = async q => { const { data, error } = await q; if (error) throw error; return data; };
  const [src, orgs, have] = await Promise.all([
    must(supabase.from('profiles').select('id, display_name, handicap').eq('event_id', fromEventId).order('display_name')),
    must(supabase.from('event_organizers').select('user_id').eq('event_id', fromEventId)),
    must(supabase.from('profiles').select('display_name').eq('event_id', toEvent.id))
  ]);
  const organizerIds = new Set(orgs.map(o => o.user_id));
  const taken = new Set(have.map(p => slug(p.display_name)));
  const players = src.filter(p => !organizerIds.has(p.id));
  const todo = players.filter(p => !taken.has(slug(p.display_name)));
  const skipped = players.length - todo.length;

  let added = 0;
  const failed = [];
  for (const [i, p] of todo.entries()) {
    onProgress?.(i, todo.length);
    // A throwaway client, so signing up the player doesn't sign the organizer out.
    const temp = createTempClient();
    try {
      const { email } = playerCreds({ name: p.display_name, code: toEvent.join_code, pin: '' });
      const { data, error } = await temp.auth.signUp({ email, password: crypto.randomUUID() });
      if (error) throw error;
      const { error: joinErr } = await temp.rpc('redeem_join_code',
        { p_code: toEvent.join_code, p_name: p.display_name, p_handicap: p.handicap });
      if (joinErr) throw joinErr;
      const { error: markErr } = await supabase.from('profiles').update({ claimed: false }).eq('id', data.user.id);
      if (markErr) throw markErr;
      added++;
    } catch (e) {
      failed.push({ name: p.display_name, error: e.message || String(e) });
    } finally {
      await temp.auth.signOut().catch(() => {});
    }
  }
  onProgress?.(todo.length, todo.length);
  return { added, skipped, failed };
}

