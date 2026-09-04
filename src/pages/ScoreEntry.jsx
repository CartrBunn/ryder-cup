import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';
import { computeMatch } from '../lib/matchcompute';
import { orderedHoles } from '../lib/scoring';

export default function ScoreEntry() {
  const { id } = useParams();
  const { profile } = useAuth();
  const nav = useNavigate();
  const [bundle, setBundle] = useState(null);
  const [gross, setGross] = useState({ A: {}, B: {} });   // { A:{hole:strokes}, B:{...} }
  const [saving, setSaving] = useState('');

  useEffect(() => {
    (async () => {
      const { data: match } = await supabase.from('matches').select('*').eq('id', id).single();
      const { data: round } = await supabase.from('rounds').select('*').eq('id', match.round_id).single();
      const { data: course } = await supabase.from('courses').select('*').eq('id', round.course_id).single();
      const { data: event } = await supabase.from('events').select('*').eq('id', match.event_id).single();
      const ids = [...match.side_a_players, ...match.side_b_players];
      const { data: profiles } = await supabase.from('profiles').select('*').in('id', ids);
      const { data: scores } = await supabase.from('hole_scores').select('*').eq('match_id', id);
      const g = { A: {}, B: {} };
      (scores || []).forEach(s => { g[s.side][s.hole] = s.gross; });
      setGross(g);
      setBundle({ match, round, course, event, profiles: profiles || [] });
    })();
  }, [id]);

  // Live sync: apply other people's hole edits (and a submit by the co-scorer) to this open match.
  useEffect(() => {
    const ch = supabase.channel('match-' + id)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'hole_scores', filter: `match_id=eq.${id}` },
        payload => {
          // Ignore our own echoes so we never fight the cell we're typing in.
          if (payload.new && payload.new.entered_by === profile.id) return;
          const row = payload.new ?? payload.old;
          setGross(prev => {
            const next = { ...prev, [row.side]: { ...prev[row.side] } };
            if (payload.eventType === 'DELETE') delete next[row.side][row.hole];
            else next[row.side][row.hole] = payload.new.gross;
            return next;
          });
          setSaving('Updated');
          setTimeout(() => setSaving(''), 800);
        })
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'matches', filter: `id=eq.${id}` },
        payload => setBundle(b => b ? { ...b, match: { ...b.match, ...payload.new } } : b))
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [id, profile.id]);

  const profilesById = useMemo(
    () => bundle ? Object.fromEntries(bundle.profiles.map(p => [p.id, p])) : {}, [bundle]);

  const computed = useMemo(() => {
    if (!bundle) return null;
    const scores = [];
    ['A', 'B'].forEach(side => Object.entries(gross[side]).forEach(([hole, val]) =>
      scores.push({ side, hole: Number(hole), gross: Number(val) })));
    return computeMatch({ match: bundle.match, round: bundle.round, course: bundle.course,
      event: bundle.event, profilesById, scores });
  }, [bundle, gross, profilesById]);

  if (!bundle) return <div className="center">Loading match…</div>;
  const { match, course } = bundle;
  const holes = orderedHoles(course.holes, match.start_hole);
  const nameOf = ids => ids.map(i => profilesById[i]?.display_name || '—').join(' / ');
  const canEdit = profile.role === 'organizer'
    || match.side_a_players.includes(profile.id)
    || match.side_b_players.includes(profile.id);

  async function setHole(side, hole, value) {
    const v = value === '' ? null : Number(value);
    setGross(prev => {
      const next = { ...prev, [side]: { ...prev[side] } };
      if (v == null) delete next[side][hole]; else next[side][hole] = v;
      return next;
    });
    setSaving('Saving…');
    if (v == null) {
      await supabase.from('hole_scores').delete().match({ match_id: id, side, hole });
    } else {
      await supabase.from('hole_scores').upsert(
        { match_id: id, side, hole, gross: v, entered_by: profile.id, updated_at: new Date().toISOString() },
        { onConflict: 'match_id,side,hole' });
    }
    setSaving('Saved');
    setTimeout(() => setSaving(''), 800);
  }

  async function submit() {
    if (!computed.state.decided && !confirm('This match isn\'t mathematically decided yet. Submit anyway?')) return;
    await supabase.from('matches').update({
      submitted: true,
      final: computed.state.final,
      status_text: computed.state.status
    }).eq('id', id);
    nav('/');
  }

  return (
    <div className="stack">
      <div className="scorehead">
        <div>{nameOf(match.side_a_players)}</div>
        <div className="live">{computed.state.status}</div>
        <div className="right">{nameOf(match.side_b_players)}</div>
      </div>
      <p className="muted small">Playing handicaps this format — A: {computed.aHcp}, B: {computed.bHcp}
        {computed.strokeMap.receiver && ` · ${computed.strokeMap.receiver} gets ${Math.abs(Math.round(computed.strokeMap.diff))} stroke(s)`}</p>
      {match.start_hole && <p className="muted small">Shotgun start · begins on hole {match.start_hole}</p>}

      <div className="table-scroll card">
        <table className="scorecard">
          <thead>
            <tr><th>Hole</th><th>Par</th><th>SI</th><th>A</th><th>B</th><th>Result</th></tr>
          </thead>
          <tbody>
            {holes.map(h => {
              const res = computed.state.results.find(r => r.hole === h.number);
              const aStk = computed.strokeMap.aStrokes[h.number] || 0;
              const bStk = computed.strokeMap.bStrokes[h.number] || 0;
              return (
                <tr key={h.number}>
                  <td>{h.number}</td>
                  <td className="dim">{h.par}</td>
                  <td className="dim">{h.strokeIndex}</td>
                  <td>
                    <input className="hole" inputMode="numeric" value={gross.A[h.number] ?? ''}
                      onChange={e => setHole('A', h.number, e.target.value)} disabled={!canEdit} />
                    {aStk > 0 && <span className="pop">•{aStk}</span>}
                  </td>
                  <td>
                    <input className="hole" inputMode="numeric" value={gross.B[h.number] ?? ''}
                      onChange={e => setHole('B', h.number, e.target.value)} disabled={!canEdit} />
                    {bStk > 0 && <span className="pop">•{bStk}</span>}
                  </td>
                  <td className={'res ' + (res?.winner || '')}>
                    {res?.winner === 'A' ? '◄' : res?.winner === 'B' ? '►' : res?.winner === 'half' ? '=' : ''}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="row">
        <span className="muted">{canEdit ? saving : 'View only'}</span>
        {canEdit && (
          <button className="primary" onClick={submit} disabled={match.submitted}>
            {match.submitted ? 'Submitted' : 'Submit result'}
          </button>
        )}
      </div>
    </div>
  );
}
