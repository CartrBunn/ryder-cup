import { supabase } from '../supabaseClient';

// Supabase caps a single response at 1000 rows (and silently truncates), so hole scores
// are paged until a short page comes back.
const PAGE = 1000;

async function loadEventScores(evt) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    // Inner-join matches so only this event's scores come back, in one request per page.
    const { data, error } = await supabase.from('hole_scores')
      .select('id, match_id, side, hole, gross, matches!inner(event_id)')
      .eq('matches.event_id', evt).order('id').range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE) return rows;
  }
}

const must = async q => { const { data, error } = await q; if (error) throw error; return data; };

// Everything the leaderboards need for one event, fetched in parallel. Throws on any
// failure so a partial load is never shown as the full picture.
// Teams are ordered by name so team A/B (left/right) is stable everywhere.
export async function loadEvent(evt) {
  const [event, teams, profiles, courses, rounds, matches, scores] = await Promise.all([
    must(supabase.from('events').select('*').eq('id', evt).single()),
    must(supabase.from('teams').select('*').eq('event_id', evt).order('name')),
    must(supabase.from('profiles').select('*').eq('event_id', evt)),
    must(supabase.from('courses').select('*').eq('event_id', evt)),
    must(supabase.from('rounds').select('*').eq('event_id', evt).order('seq')),
    must(supabase.from('matches').select('*').eq('event_id', evt).order('seq')),
    loadEventScores(evt)
  ]);
  return { event, teams, profiles, courses, rounds, matches, scores };
}
