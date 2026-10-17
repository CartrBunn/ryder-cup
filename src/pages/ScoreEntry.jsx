import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';
import { computeMatch } from '../lib/matchcompute';
import { orderedHoles } from '../lib/scoring';

const SAVE_DELAY = 400;     // ms of typing quiet before a hole is written
const ACE_SAVE_DELAY = 2500;   // ms before a lone "1" is written (might be 10-19)
const RETRY_DELAY = 3000;  // ms between retries when a write fails (e.g. no signal)

// Per-match write queue, one slot per hole cell ('A-7'). Each cell holds only its latest
// value and has at most one write in flight, so a cell's writes land in order and a stale
// value (or a delete from backspacing) can never overwrite a newer one.
// It lives at module level, not in the component, so leaving and reopening a match keeps
// any save that is still retrying — and the reopened page shows it rather than a blank.
const stores = {};
function storeFor(matchId) {
  return stores[matchId] ||= {
    queue: {},       // key -> { side, hole, v, by }  latest value not yet sent (v null = clear)
    inflight: {},    // key -> the job currently being written
    timers: {},
    rowIds: {},      // key -> hole_scores.id on the server, to recognize realtime DELETEs
    listener: null   // the open page's status callback
  };
}
const cellKey = (side, hole) => `${side}-${hole}`;
const isPending = (s, key) => key in s.queue || key in s.inflight;
const isDirty = s => Object.keys(s.queue).length > 0 || Object.keys(s.inflight).length > 0;

// Permission, constraint and data errors won't fix themselves; anything else (no signal,
// timeouts, 5xx) is worth retrying.
const isPermanent = err => /^(42|23|22|P0)/.test(err?.code || '');

async function flush(s, matchId, key) {
  if (s.inflight[key] || !s.queue[key]) return;   // an in-flight write re-checks the queue when it lands
  const job = s.queue[key];
  delete s.queue[key];
  s.inflight[key] = job;
  let res;
  try {
    res = job.v == null
      ? await supabase.from('hole_scores').delete().match({ match_id: matchId, side: job.side, hole: job.hole })
      : await supabase.from('hole_scores').upsert(
          { match_id: matchId, side: job.side, hole: job.hole, gross: job.v,
            entered_by: job.by, updated_at: new Date().toISOString() },
          { onConflict: 'match_id,side,hole' }).select('id').single();
  } catch (e) {
    res = { error: e };
  }
  delete s.inflight[key];
  if (res.error) {
    if (isPermanent(res.error)) {
      s.listener?.({ type: 'failed', hole: job.hole, message: res.error.message });
    } else {
      if (!s.queue[key]) s.queue[key] = job;      // retry it, unless a newer value replaced it
      s.listener?.({ type: 'retrying' });
      clearTimeout(s.timers[key]);
      s.timers[key] = setTimeout(() => flush(s, matchId, key), RETRY_DELAY);
    }
    return;
  }
  if (job.v == null) delete s.rowIds[key]; else s.rowIds[key] = res.data.id;
  if (s.queue[key]) return flush(s, matchId, key);  // a newer value arrived while this one was in flight
  s.listener?.({ type: 'saved' });
}

export default function ScoreEntry() {
  const { id } = useParams();
  const { profile } = useAuth();
  const store = storeFor(id);
  const [bundle, setBundle] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const [gross, setGross] = useState({ A: {}, B: {} });   // { A:{hole:strokes}, B:{...} }
  const [saving, setSaving] = useState('');
  const [saveErr, setSaveErr] = useState('');

  // Server rows plus any of this device's edits that haven't been written yet.
  function withPending(rows) {
    const g = { A: {}, B: {} };
    rows.forEach(r => { g[r.side][r.hole] = r.gross; store.rowIds[cellKey(r.side, r.hole)] = r.id; });
    for (const job of [...Object.values(store.inflight), ...Object.values(store.queue)]) {
      if (job.v == null) delete g[job.side][job.hole]; else g[job.side][job.hole] = job.v;
    }
    return g;
  }

  async function load() {
    setLoadErr('');
    try {
      const one = async q => { const { data, error } = await q; if (error) throw error; return data; };
      const match = await one(supabase.from('matches').select('*').eq('id', id).single());
      const round = await one(supabase.from('rounds').select('*').eq('id', match.round_id).single());
      const [course, event, profiles, teams, scores] = await Promise.all([
        round.course_id ? one(supabase.from('courses').select('*').eq('id', round.course_id).single()) : null,
        one(supabase.from('events').select('*').eq('id', match.event_id).single()),
        one(supabase.from('profiles').select('*').in('id', [...match.side_a_players, ...match.side_b_players])),
        one(supabase.from('teams').select('*').eq('event_id', match.event_id).order('name')),
        one(supabase.from('hole_scores').select('*').eq('match_id', id))
      ]);
      setGross(withPending(scores));
      setBundle({ match, round, course, event, profiles, teams });
    } catch (e) {
      setLoadErr(e.message || String(e));
    }
  }
  useEffect(() => { load(); }, [id]);

  function flash(text) {
    setSaving(text);
    setTimeout(() => setSaving(s => (s === text ? '' : s)), 1200);
  }

  // Save status from the write queue. Registered per open page; writes still in flight when
  // the page closes keep going and report to whichever page is open next.
  useEffect(() => {
    const listener = ev => {
      if (ev.type === 'retrying') setSaveErr('Not saved — retrying…');
      else if (ev.type === 'failed') { setSaveErr(`Couldn't save hole ${ev.hole}: ${ev.message}`); load(); }
      else if (!isDirty(store)) { setSaveErr(''); flash('Saved'); }
    };
    store.listener = listener;
    if (isDirty(store)) setSaving('Saving…');
    return () => { if (store.listener === listener) store.listener = null; };
  }, [id]);

  // Live sync: apply other people's hole edits to this open match. A cell with an edit of
  // ours still pending is left alone — our write lands after and wins.
  useEffect(() => {
    const ch = supabase.channel('match-' + id)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'hole_scores', filter: `match_id=eq.${id}` },
        payload => {
          if (payload.eventType === 'DELETE') return;              // handled below
          const row = payload.new;
          const key = cellKey(row.side, row.hole);
          store.rowIds[key] = row.id;
          if (isPending(store, key)) return;
          setGross(prev => ({ ...prev, [row.side]: { ...prev[row.side], [row.hole]: row.gross } }));
          if (row.entered_by !== profile.id && !isDirty(store)) flash('Updated');
        })
      // Realtime can't filter DELETEs and their payload carries only the row id, so match
      // the id against the rows this card knows about.
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'hole_scores' }, payload => {
        const key = Object.keys(store.rowIds).find(k => store.rowIds[k] === payload.old?.id);
        if (!key) return;
        delete store.rowIds[key];
        if (isPending(store, key)) return;
        const [side, hole] = key.split('-');
        setGross(prev => {
          const next = { ...prev, [side]: { ...prev[side] } };
          delete next[side][hole];
          return next;
        });
      })
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'matches', filter: `id=eq.${id}` },
        payload => setBundle(b => b ? { ...b, match: { ...b.match, ...payload.new } } : b))
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [id, profile.id]);

  // Warn before closing the tab while scores are still unsaved.
  useEffect(() => {
    const onUnload = e => { if (isDirty(store)) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [id]);

  const profilesById = useMemo(
    () => bundle ? Object.fromEntries(bundle.profiles.map(p => [p.id, p])) : {}, [bundle]);

  const computed = useMemo(() => {
    if (!bundle) return null;
    const scores = [];
    ['A', 'B'].forEach(side => Object.entries(gross[side]).forEach(([hole, val]) =>
      scores.push({ side, hole: Number(hole), gross: Number(val) })));
    return computeMatch({ match: bundle.match, round: bundle.round, course: bundle.course,
      event: bundle.event, profilesById, scores,
      teamsById: Object.fromEntries(bundle.teams.map(t => [t.id, t])) });
  }, [bundle, gross, profilesById]);

  function setHole(side, hole, raw) {
    const digits = raw.replace(/\D/g, '').slice(0, 2);
    if (/^0+$/.test(digits)) return;   // 0 is never a real gross score; ignore it
    const v = digits === '' ? null : Number(digits);
    setGross(prev => {
      const next = { ...prev, [side]: { ...prev[side] } };
      if (v == null) delete next[side][hole]; else next[side][hole] = v;
      return next;
    });
    const key = cellKey(side, hole);
    store.queue[key] = { side, hole, v, by: profile.id };
    if (!saveErr) setSaving('Saving…');
    clearTimeout(store.timers[key]);
    // A lone "1" is usually the start of 10-19, so wait longer before saving it (an ace
    // would otherwise be announced to everyone mid-keystroke).
    store.timers[key] = setTimeout(() => flush(store, id, key), v === 1 ? ACE_SAVE_DELAY : SAVE_DELAY);
  }

  if (loadErr) return (
    <div className="center stack">
      <p className="err">Couldn't load this match: {loadErr}</p>
      <button className="primary" onClick={load}>Try again</button>
    </div>
  );
  if (!bundle) return <div className="center">Loading match…</div>;
  const { match, course } = bundle;
  const holes = orderedHoles(course?.holes || [], match.start_hole);
  const nameOf = ids => ids.map(i => profilesById[i]?.display_name || '—').join(' / ');
  const nameA = bundle.teams.find(t => t.id === computed.teamAId)?.name || 'A';
  const nameB = bundle.teams.find(t => t.id === computed.teamBId)?.name || 'B';
  const stroke = bundle.event.scoring_mode === 'stroke';
  const total = side => Object.values(gross[side]).reduce((t, v) => t + Number(v), 0);
  const canEdit = ['organizer', 'captain'].includes(profile.role)
    || match.side_a_players.includes(profile.id)
    || match.side_b_players.includes(profile.id);

  return (
    <div className="stack">
      <div className="scorehead">
        <div>{nameOf(match.side_a_players)}</div>
        <div className="live">{computed.state.status}</div>
        <div className="right">{nameOf(match.side_b_players)}</div>
      </div>
      {computed.strokeMap.receiver && (
        <p className="muted small">
          {computed.strokeMap.receiver === 'A' ? nameA : nameB} gets {computed.strokeMap.strokes} stroke(s)
        </p>
      )}
      {stroke && <p className="muted small">Stroke play · lowest net total after all {holes.length} holes wins</p>}
      {match.start_hole && <p className="muted small">Shotgun start · begins on hole {match.start_hole}</p>}
      {!course && <p className="err">This round has no course set — ask the organizer to add one in Setup.</p>}

      <div className="table-scroll card">
        <table className="scorecard">
          <thead>
            <tr><th>Hole</th><th>Par</th><th>{nameA}</th><th>{nameB}</th><th>Result</th></tr>
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
          {stroke && (
            <tfoot>
              <tr className="total">
                <td>Tot</td>
                <td className="dim">{holes.reduce((t, h) => t + h.par, 0)}</td>
                <td>{total('A') || '–'}<span className="pop">net {computed.state.totalA}</span></td>
                <td>{total('B') || '–'}<span className="pop">net {computed.state.totalB}</span></td>
                <td className={'res ' + (computed.state.up > 0 ? 'A' : computed.state.up < 0 ? 'B' : 'half')}>
                  {computed.state.played ? (computed.state.up === 0 ? 'AS' : Math.abs(computed.state.up)) : ''}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <div className="row">
        <span className={saveErr ? 'err' : 'muted'}>{canEdit ? (saveErr || saving) : 'View only'}</span>
      </div>
      {canEdit && (
        <p className="muted small">Scores save automatically, and the result counts as soon as the match is decided.</p>
      )}
    </div>
  );
}
