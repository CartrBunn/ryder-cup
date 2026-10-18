import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';
import { planRound, pairingTable } from '../lib/optimize';

// Hidden page (not linked anywhere): solves each round's snake draft for one team and says
// who to send next. Reads the same live state as the Matchups page.
export default function Caddie() {
  const { profile, realProfile, myTeamIdFor } = useAuth();
  const [event, setEvent] = useState(null);
  const [rounds, setRounds] = useState([]);
  const [players, setPlayers] = useState([]);
  const [teams, setTeams] = useState([]);
  const [matches, setMatches] = useState([]);
  const [courses, setCourses] = useState([]);
  const [forTeam, setForTeam] = useState('');

  async function load() {
    const evt = profile.event_id;
    const [{ data: e }, { data: r }, { data: p }, { data: t }, { data: m }, { data: c }] = await Promise.all([
      supabase.from('events').select('*').eq('id', evt).single(),
      supabase.from('rounds').select('*').eq('event_id', evt).order('seq'),
      supabase.from('profiles').select('*').eq('event_id', evt).order('handicap'),
      supabase.from('teams').select('*').eq('event_id', evt).order('name'),
      supabase.from('matches').select('*').eq('event_id', evt).order('seq'),
      supabase.from('courses').select('*').eq('event_id', evt)
    ]);
    setEvent(e); setRounds(r || []); setPlayers(p || []); setTeams(t || []); setMatches(m || []); setCourses(c || []);
  }
  useEffect(() => {
    if (!profile?.event_id) return;
    load();
    const t = setInterval(load, 15000);
    const evt = profile.event_id;
    const ch = supabase.channel('caddie-' + evt)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'matches', filter: `event_id=eq.${evt}` }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rounds', filter: `event_id=eq.${evt}` }, load)
      .subscribe();
    return () => { clearInterval(t); supabase.removeChannel(ch); };
  }, [profile?.event_id]);

  // Default to the team this user captains, else the team they play on.
  const defaultTeam = myTeamIdFor(teams) || realProfile?.team_id || teams[0]?.id || '';
  const myTeamId = forTeam || defaultTeam;
  const myIdx = teams.findIndex(t => t.id === myTeamId);
  const myTeam = teams[myIdx], oppTeam = teams[myIdx === 0 ? 1 : 0];
  const nameOf = id => players.find(p => p.id === id)?.display_name || '—';

  if (!event) return <div className="center">Loading…</div>;
  if (teams.length < 2 || myIdx < 0 || myIdx > 1) return <p className="muted">Draft teams first.</p>;

  return (
    <div className="stack caddie">
      <h1>Caddie</h1>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <span className="muted small">Optimizing for</span>
        <select value={myTeamId} onChange={e => setForTeam(e.target.value)} style={{ width: 'auto' }}>
          {teams.slice(0, 2).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </div>
      <p className="muted small">
        Every pairing is priced with the leaderboard's win-probability model at this event's handicap
        allowances, then the snake draft is solved assuming both captains play their best. Values are
        {' '}{myTeam.name}'s expected points (win 1, halve ½).
      </p>
      {rounds.map(r => (
        <RoundPlan key={r.id} round={r} event={event} teams={teams} myIdx={myIdx}
          myTeam={myTeam} oppTeam={oppTeam} players={players} nameOf={nameOf}
          matches={matches.filter(m => m.round_id === r.id)}
          holes={courses.find(c => c.id === r.course_id)?.holes || []} />
      ))}
      {rounds.length === 0 && <p className="muted">No rounds yet.</p>}
    </div>
  );
}

const pts = x => x.toFixed(2);
const edge = x => { const d = x - 0.5; return (d >= 0 ? '+' : '−') + Math.abs(d).toFixed(2); };

function RoundPlan({ round, event, teams, myIdx, myTeam, oppTeam, players, matches, holes, nameOf }) {
  const used = new Set(matches.flatMap(m => [...m.side_a_players, ...m.side_b_players]));
  const mine = players.filter(p => p.team_id === myTeam.id && !used.has(p.id));
  const theirs = players.filter(p => p.team_id === oppTeam.id && !used.has(p.id));
  const firstIdx = Math.max(0, teams.findIndex(t => t.id === round.first_team_id));
  const pickerIsMe = k => ((k + firstIdx) % 2 === 0 ? 0 : 1) === myIdx;
  const made = matches.length;
  // Same rule as the Matchups page: a pending pick only counts if it's the current picker's.
  const pickerId = pickerIsMe(made) ? myTeam.id : oppTeam.id;
  const pp = round.pending_pick;
  const pending = pp && pp.team_id === pickerId ? { mine: pp.team_id === myTeam.id, ids: pp.players } : null;
  const names = ids => ids.map(nameOf).join(' / ');

  // Keyed on what actually changes the solve, so background polls don't re-run it.
  const key = [round.format, mine.map(p => p.id + ':' + p.handicap).join(), theirs.map(p => p.id + ':' + p.handicap).join(),
    made, firstIdx, myIdx, JSON.stringify(pending), holes.length,
    event.singles_pct, event.altshot_pct, event.scramble_low_pct, event.scramble_high_pct, event.scoring_mode].join('|');
  const plan = useMemo(() => (mine.length && theirs.length)
    ? planRound({ format: round.format, event, holes, mine, theirs, pickerIsMe, startK: made, pending })
    : null, [key]);
  const table = useMemo(() => (mine.length && theirs.length)
    ? pairingTable({ format: round.format, event, holes, mine, theirs }) : [], [key]);

  return (
    <section className="card">
      <h3>{round.name} <span className="dim">· {round.format.replace('_', ' ')}</span></h3>
      {!round.first_team_id && made === 0 &&
        <p className="muted small">Coin toss not done yet — assuming {teams[0].name} picks first.</p>}
      {!plan && <p className="muted small">All players placed.</p>}
      {plan && (
        <>
          <Decision d={plan.decision} names={names} oppName={oppTeam.name} />
          <h4 className="caddie-h">Projected rest of round
            <span className="dim"> · {pts(plan.value)} of {plan.matches} pts{!plan.exact && ' · approximate'}</span></h4>
          <ul className="clean caddie-line">
            {plan.line.map((m, i) => (
              <li key={i}>
                <span className="muted small caddie-n">{m.k + 1}</span>
                <span className="pname">
                  <strong>{names(m.mine)}</strong> vs {names(m.theirs)}
                  <span className="muted small"> · {m.meFirst ? 'you pick' : `${oppTeam.name} picks`}</span>
                </span>
                <span className={'caddie-ev ' + (m.ev >= 0.5 ? 'up' : 'down')}>{pts(m.ev)}</span>
              </li>
            ))}
          </ul>
          <details>
            <summary className="muted small">Cheat sheet: every {round.format === 'singles' ? 'player' : 'pair'} vs theirs</summary>
            <table className="scorecard caddie-table">
              <thead><tr><th style={{ textAlign: 'left' }}>{myTeam.name}</th><th>Avg</th><th>Worst</th><th>Best</th><th style={{ textAlign: 'left' }}>Best vs</th></tr></thead>
              <tbody>
                {table.map(row => {
                  const top = row.vs.reduce((a, b) => (b.ev > a.ev ? b : a));
                  return (
                    <tr key={row.mine.join()}>
                      <td style={{ textAlign: 'left' }}>{names(row.mine)}</td>
                      <td>{pts(row.avg)}</td><td>{pts(row.worst)}</td><td>{pts(row.best)}</td>
                      <td style={{ textAlign: 'left' }} className="small">{names(top.theirs)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </details>
        </>
      )}
    </section>
  );
}

function Decision({ d, names, oppName }) {
  if (!d) return null;
  const top = d.options[0];
  const rows = (opts, label) => (
    <details>
      <summary className="muted small">All options</summary>
      <ul className="clean caddie-opts">
        {opts.map((o, i) => (
          <li key={i} className="row between">
            <span>{label(o)}</span><span className="muted small">{pts(o.value)} pts · this match {edge(o.ev)}</span>
          </li>
        ))}
      </ul>
    </details>
  );
  if (d.kind === 'pick') return (
    <div className="caddie-now">
      <div className="caddie-tag">Your pick</div>
      <div>Send <strong>{names(top.mine)}</strong> <span className="muted small">— {oppName}'s best answer is {names(top.theirs)} ({edge(top.ev)})</span></div>
      {rows(d.options, o => <><strong>{names(o.mine)}</strong> <span className="muted small">→ they answer {names(o.theirs)}</span></>)}
    </div>
  );
  if (d.kind === 'respond') return (
    <div className="caddie-now">
      <div className="caddie-tag">Respond to {names(d.locked)}</div>
      <div>Send <strong>{names(top.mine)}</strong> <span className="muted small">— this match {edge(top.ev)}</span></div>
      {rows(d.options, o => <strong>{names(o.mine)}</strong>)}
    </div>
  );
  if (d.kind === 'awaitReply') return (
    <div className="caddie-now">
      <div className="caddie-tag">You locked in {names(d.locked)}</div>
      <div>Expect {oppName} to answer with <strong>{names(top.theirs)}</strong> <span className="muted small">({edge(top.ev)})</span></div>
    </div>
  );
  return (
    <div className="caddie-now">
      <div className="caddie-tag">{oppName} picks first</div>
      <div>Likely <strong>{names(top.theirs)}</strong> → answer with <strong>{names(top.mine)}</strong></div>
      {rows(d.options, o => <>If {names(o.theirs)} → <strong>{names(o.mine)}</strong></>)}
    </div>
  );
}
