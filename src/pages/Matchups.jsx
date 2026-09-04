import { useEffect, useState } from 'react';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';
import CoinToss from '../components/CoinToss';
import { assignStartHoles } from '../lib/shotgun';

export default function Matchups() {
  const { profile } = useAuth();
  const [rounds, setRounds] = useState([]);
  const [players, setPlayers] = useState([]);
  const [teams, setTeams] = useState([]);
  const [matches, setMatches] = useState([]);
  const [courses, setCourses] = useState([]);
  const [err, setErr] = useState('');

  async function load() {
    const evt = profile.event_id;
    const [{ data: r }, { data: p }, { data: t }, { data: m }, { data: c }] = await Promise.all([
      supabase.from('rounds').select('*').eq('event_id', evt).order('seq'),
      supabase.from('profiles').select('*').eq('event_id', evt).order('handicap'),
      supabase.from('teams').select('*').eq('event_id', evt).order('name'),
      supabase.from('matches').select('*').eq('event_id', evt).order('seq'),
      supabase.from('courses').select('*').eq('event_id', evt)
    ]);
    setRounds(r || []); setPlayers(p || []); setTeams(t || []); setMatches(m || []); setCourses(c || []);
  }
  useEffect(() => {
    if (!profile?.event_id) return;
    load();
    const t = setInterval(load, 15000);   // poll fallback so state self-heals if a realtime event is missed
    return () => clearInterval(t);
  }, [profile?.event_id]);

  // Live sync so the coin toss, the in-progress "locked in" pick, and committed matches all
  // update on every open device. The intermediate pick is persisted on rounds.pending_pick,
  // so it rides the same postgres_changes path as everything else and survives a late join.
  useEffect(() => {
    if (!profile?.event_id) return;
    const evt = profile.event_id;
    const ch = supabase.channel('matchups-' + evt)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'matches', filter: `event_id=eq.${evt}` }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rounds', filter: `event_id=eq.${evt}` }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles', filter: `event_id=eq.${evt}` }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'teams', filter: `event_id=eq.${evt}` }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [profile?.event_id]);

  const isOrganizer = profile.role === 'organizer';
  const myTeamId = teams.find(t => t.captain_id === profile.id)?.id;
  const canFlip = isOrganizer || !!myTeamId;

  async function tossRound(roundId, teamId) {
    setErr('');
    const { error } = await supabase.rpc('set_round_first_team', { p_round_id: roundId, p_team_id: teamId });
    if (error) { setErr(error.message); return; }
    load();
  }

  const size = fmt => fmt === 'singles' ? 1 : 2;

  const usedInRound = roundId => new Set(
    matches.filter(m => m.round_id === roundId)
      .flatMap(m => [...m.side_a_players, ...m.side_b_players]));

  const availablePlayers = (teamId, roundId) => {
    const used = usedInRound(roundId);
    return players.filter(p => p.team_id === teamId && !used.has(p.id));
  };

  // Persist the picker's locked-in selection so the responder's device (and any late joiner)
  // sees it and moves to the respond phase. Cleared once the match is confirmed or cancelled.
  async function savePendingPick(roundId, teamId, players) {
    setErr('');
    const { error } = await supabase.from('rounds').update({ pending_pick: { team_id: teamId, players } }).eq('id', roundId);
    if (error) { setErr(error.message); return; }
    load();
  }
  async function clearPendingPick(roundId) {
    const { error } = await supabase.from('rounds').update({ pending_pick: null }).eq('id', roundId);
    if (error) { setErr(error.message); return; }
    load();
  }

  async function addMatch(round, aIds, bIds) {
    const seq = matches.filter(m => m.round_id === round.id).length + 1;
    const { error } = await supabase.from('matches').insert({
      round_id: round.id, event_id: profile.event_id, seq,
      side_a_players: aIds, side_b_players: bIds
    });
    if (error) { setErr(error.message); return; }
    await supabase.from('rounds').update({ pending_pick: null }).eq('id', round.id);
    load();
  }
  async function removeMatch(id) { await supabase.from('matches').delete().eq('id', id); load(); }

  const holesForRound = round => courses.find(c => c.id === round.course_id)?.holes || [];

  // Shotgun start: spread this round's matches to distinct, evenly-spaced holes, with faster
  // (lower average-handicap) groups on the harder holes. Writes auto-broadcast via realtime.
  async function autoAssignHoles(round, roundMatches) {
    setErr('');
    const holes = holesForRound(round);
    if (!holes.length) { setErr('This round has no course/holes set — add them in Setup first.'); return; }
    const hcpById = Object.fromEntries(players.map(p => [p.id, Number(p.handicap) || 0]));
    const avgHcpOf = m => {
      const ids = [...m.side_a_players, ...m.side_b_players];
      return ids.length ? ids.reduce((s, id) => s + (hcpById[id] || 0), 0) / ids.length : 0;
    };
    const assign = assignStartHoles(roundMatches, holes, avgHcpOf);
    const results = await Promise.all(
      Object.entries(assign).map(([id, hole]) =>
        supabase.from('matches').update({ start_hole: hole }).eq('id', id)));
    const failed = results.find(res => res.error);
    if (failed) { setErr(failed.error.message); return; }
    load();
  }

  async function setStartHole(id, value) {
    setErr('');
    const { error } = await supabase.from('matches')
      .update({ start_hole: value === '' ? null : Number(value) }).eq('id', id);
    if (error) { setErr(error.message); return; }
    load();
  }

  return (
    <div className="stack">
      <h1>Set matchups</h1>
      {err && <p className="err">{err}</p>}
      {teams.length < 2 && <p className="muted">Draft teams first.</p>}
      {rounds.map(r => {
        const roundMatches = matches.filter(m => m.round_id === r.id);
        const matchesMade = roundMatches.length;
        const roundHoles = holesForRound(r);
        const avA = availablePlayers(teams[0]?.id, r.id);
        const avB = availablePlayers(teams[1]?.id, r.id);
        const roundDone = teams.length === 2 && avA.length === 0 && avB.length === 0;
        const roundFirstIdx = Math.max(0, teams.findIndex(t => t.id === r.first_team_id));
        return (
          <section className="card" key={r.id}>
            <h3>{r.name} <span className="dim">· {r.format.replace('_', ' ')} · {size(r.format)} per side</span></h3>
            {teams.length >= 2 && (
              <CoinToss teams={teams} firstTeamId={r.first_team_id} locked={matchesMade > 0}
                canFlip={canFlip} onToss={teamId => tossRound(r.id, teamId)} card={false} />
            )}
            {canFlip && matchesMade > 0 && roundHoles.length > 0 && (
              <div className="row" style={{ marginBottom: '.5rem' }}>
                <button onClick={() => autoAssignHoles(r, roundMatches)}>Shotgun start · auto-assign holes</button>
                <span className="muted small">Spreads matches around the course; faster groups get the harder holes.</span>
              </div>
            )}
            <ul className="clean">
              {roundMatches.map(m => (
                <li key={m.id} className="row between">
                  <span>{names(m.side_a_players, players)} vs {names(m.side_b_players, players)}</span>
                  <span className="row">
                    {canFlip && roundHoles.length > 0 ? (
                      <label className="muted small row">
                        Start
                        <select value={m.start_hole ?? ''} onChange={e => setStartHole(m.id, e.target.value)}>
                          <option value="">—</option>
                          {roundHoles.map(h => <option key={h.number} value={h.number}>Hole {h.number}</option>)}
                        </select>
                      </label>
                    ) : m.start_hole ? (
                      <span className="muted small">Starts hole {m.start_hole}</span>
                    ) : null}
                    <button onClick={() => removeMatch(m.id)}>Remove</button>
                  </span>
                </li>
              ))}
            </ul>
            {teams.length === 2 && !roundDone &&
              <SnakeMatchBuilder
                key={matchesMade}
                n={size(r.format)}
                teamA={{ team: teams[0], players: avA }}
                teamB={{ team: teams[1], players: avB }}
                matchesMade={matchesMade}
                firstTeamIdx={roundFirstIdx}
                isOrganizer={isOrganizer}
                myTeamId={myTeamId}
                onAdd={(a, b) => addMatch(r, a, b)}
                pendingPick={r.pending_pick || null}
                onLockIn={(teamId, players) => savePendingPick(r.id, teamId, players)}
                onClearPick={() => clearPendingPick(r.id)}
              />}
            {roundDone && <p className="muted small">All players placed.</p>}
          </section>
        );
      })}
      {rounds.length === 0 && <p className="muted">No rounds yet — create them in Setup.</p>}
    </div>
  );
}

function names(ids, players) {
  const by = Object.fromEntries(players.map(p => [p.id, p.display_name]));
  return ids.map(i => by[i] || '—').join(' / ');
}

// Snake draft: teams alternate who picks first per match.
// Match 0 → team A picks first; match 1 → team B picks first; etc.
// Phase 1 ("pick"): picking team chooses their player(s) and locks in.
// Phase 2 ("respond"): other team sees who they face, picks their player(s), confirms.
function SnakeMatchBuilder({ n, teamA, teamB, matchesMade, firstTeamIdx, isOrganizer, myTeamId, onAdd, pendingPick, onLockIn, onClearPick }) {
  const [sel, setSel] = useState([]);

  // Alternate which team picks first each match slot, starting with the coin-toss winner.
  const pickerFirst = (matchesMade + firstTeamIdx) % 2 === 0; // true = teamA picks first
  const picker    = pickerFirst ? teamA : teamB;
  const responder = pickerFirst ? teamB : teamA;

  // The respond phase is driven entirely by the persisted pending pick, so every device
  // (and a late joiner) sees the same state. locked = the players the picker committed.
  const inRespond = !!pendingPick && pendingPick.team_id === picker.team.id;
  const locked = pendingPick?.players || [];

  // Clear our own in-progress selection only when the pick/respond boundary flips — not on
  // every background refresh, so the responder doesn't lose checkboxes mid-selection.
  useEffect(() => { setSel([]); }, [inRespond]);

  const canAct = side => isOrganizer || myTeamId === side.team.id;

  const toggle = (id, max) =>
    setSel(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id].slice(-max));

  const needPicker    = Math.min(n, picker.players.length);
  const needResponder = Math.min(n, responder.players.length);

  if (needPicker === 0) {
    // Picker has no players left; show respond-only (odd leftover)
    return (
      <div className="builder">
        <p className="muted small">{picker.team.name} has no players left — {responder.team.name} picks the solo match.</p>
        {canAct(responder) && (
          <Picker title={responder.team.name} color={responder.team.color}
            players={responder.players} sel={sel}
            onToggle={id => toggle(id, needResponder)} />
        )}
        {canAct(responder) && sel.length === needResponder && (
          <button className="primary" onClick={() => {
            const aIds = pickerFirst ? [] : sel;
            const bIds = pickerFirst ? sel : [];
            onAdd(aIds, bIds);
          }}>Add match</button>
        )}
      </div>
    );
  }

  if (!inRespond) {
    return (
      <div className="builder">
        <p className="muted small">
          Match {matchesMade + 1} · <strong>{picker.team.name}</strong> picks first
        </p>
        {canAct(picker)
          ? <Picker title={picker.team.name} color={picker.team.color}
              players={picker.players} sel={sel}
              onToggle={id => toggle(id, needPicker)} />
          : <p className="muted small">Waiting for {picker.team.name} to pick…</p>}
        {canAct(picker) && sel.length === needPicker && (
          <button className="primary" onClick={() => onLockIn(picker.team.id, sel)}>Lock in</button>
        )}
      </div>
    );
  }

  // respond phase — the picker has locked in (persisted); the responder picks and confirms.
  return (
    <div className="builder">
      <p className="muted small">
        {picker.team.name} locked in: <strong>{locked.map(id => picker.players.find(p => p.id === id)?.display_name || '—').join(' / ')}</strong>
        {' '}· {responder.team.name} responds
      </p>
      {canAct(responder)
        ? <Picker title={responder.team.name} color={responder.team.color}
            players={responder.players} sel={sel}
            onToggle={id => toggle(id, needResponder)} />
        : <p className="muted small">Waiting for {responder.team.name} to respond…</p>}
      <div className="row">
        {canAct(responder) && sel.length === needResponder && (
          <button className="primary" onClick={() => {
            const aIds = pickerFirst ? locked : sel;
            const bIds = pickerFirst ? sel   : locked;
            onAdd(aIds, bIds);
          }}>Confirm match</button>
        )}
        <button onClick={onClearPick}>Back</button>
      </div>
    </div>
  );
}

function Picker({ title, color, players, sel, onToggle }) {
  return (
    <div>
      <div className="dim" style={color ? { color } : undefined}>{title}</div>
      {players.map(p =>
        <label key={p.id} className={'chip ' + (sel.includes(p.id) ? 'on' : '')}>
          <input type="checkbox" checked={sel.includes(p.id)} onChange={() => onToggle(p.id)} />
          {p.display_name}
        </label>)}
      {players.length === 0 && <div className="muted small">No players available.</div>}
    </div>
  );
}
