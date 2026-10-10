import { useEffect, useState, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { computeEvent } from '../lib/matchcompute';
import { loadEvent } from '../lib/loadEvent';

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function recordKey(r) { return String(recordPts(r)); }
function recordPts(r) { return r.w + r.h * 0.5; }

export default function Prizes() {
  const { profile } = useAuth();
  const [data, setData] = useState(null);
  const [tieOrder, setTieOrder] = useState({});

  const [loadErr, setLoadErr] = useState('');

  async function load() {
    try {
      setData(await loadEvent(profile.event_id));
      setLoadErr('');
    } catch (e) {
      setLoadErr(e.message || String(e));   // keep the last good list on a failed refresh
    }
  }
  useEffect(() => {
    if (!profile?.event_id) return;
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [profile?.event_id]);

  const { groups, hasTies } = useMemo(() => {
    if (!data) return { groups: [], hasTies: false };
    const { teams, profiles, matches } = data;
    const teamsById = Object.fromEntries(teams.map(t => [t.id, t]));

    const rec = {};
    for (const p of profiles) rec[p.id] = { w: 0, h: 0, l: 0 };

    // Results come from the same engine as the team leaderboard, so the two always agree.
    const ctxById = computeEvent(data);
    for (const m of matches) {
      const final = ctxById[m.id]?.state.final;
      if (!final) continue;
      for (const id of m.side_a_players) {
        if (!rec[id]) continue;
        if (final === 'A') rec[id].w++;
        else if (final === 'B') rec[id].l++;
        else rec[id].h++;
      }
      for (const id of m.side_b_players) {
        if (!rec[id]) continue;
        if (final === 'B') rec[id].w++;
        else if (final === 'A') rec[id].l++;
        else rec[id].h++;
      }
    }

    const sorted = [...profiles]
      .map(p => ({ ...p, record: rec[p.id] || { w: 0, h: 0, l: 0 }, team: teamsById[p.team_id] || null }))
      .sort((a, b) => {
        const pa = recordPts(a.record), pb = recordPts(b.record);
        if (pb !== pa) return pb - pa;
        if (pa === 0) return a.display_name.localeCompare(b.display_name);
        return 0;
      });

    const result = [];
    let rank = 1, i = 0;
    while (i < sorted.length) {
      const key = recordKey(sorted[i].record);
      let j = i;
      while (j < sorted.length && recordKey(sorted[j].record) === key) j++;
      result.push({ rank, key, record: sorted[i].record, players: sorted.slice(i, j) });
      rank += j - i;
      i = j;
    }

    return { groups: result, hasTies: result.some(g => g.players.length > 1) };
  }, [data]);

  const displayGroups = useMemo(() =>
    groups.map(g => {
      const order = tieOrder[g.key];
      return order ? { ...g, players: order.map(i => g.players[i]) } : g;
    }),
  [groups, tieOrder]);

  function shuffleAll() {
    const next = {};
    for (const g of groups) {
      if (g.players.length > 1) next[g.key] = shuffle(g.players.map((_, i) => i));
    }
    setTieOrder(next);
  }

  if (!data && loadErr) return (
    <div className="center stack">
      <p className="err">Couldn't load the leaderboard: {loadErr}</p>
      <button className="primary" onClick={load}>Try again</button>
    </div>
  );
  if (!data) return <div className="center">Loading prizes…</div>;

  const rows = displayGroups.flatMap(g =>
    g.players.map(p => ({ player: p, rank: g.rank, pts: recordPts(g.record) }))
  );

  return (
    <div className="stack">
      <div className="row between" style={{ alignItems: 'baseline' }}>
        <h1>Individual Leaderboard</h1>
        {hasTies && (
          <button onClick={shuffleAll} style={{ flexShrink: 0 }}>Shuffle ties</button>
        )}
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {rows.map(({ player: p, rank, pts }, idx) => (
          <div key={p.id} className="row"
            style={{
              padding: '11px 16px',
              gap: 12,
              borderBottom: idx < rows.length - 1 ? '1px solid var(--hair)' : 'none',
            }}>
            <span style={{ fontWeight: 700, width: 36, flexShrink: 0, color: 'var(--muted)', fontSize: 13 }}>
              #{rank}
            </span>
            {p.team?.color && (
              <span className="dot" style={{ background: p.team.color, flexShrink: 0 }} />
            )}
            <span style={{ fontWeight: 700, flex: 1 }}>{p.display_name}</span>
            <span className="muted small">{p.team?.name}</span>
            {pts > 0 && (
              <span style={{ fontWeight: 700, fontSize: 13, flexShrink: 0 }}>
                {pts} {pts === 1 ? 'pt' : 'pts'}
              </span>
            )}
          </div>
        ))}
        {rows.length === 0 && <p className="muted" style={{ padding: 16 }}>No players yet.</p>}
      </div>
    </div>
  );
}
