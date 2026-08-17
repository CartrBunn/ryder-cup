// The "cup" tug-of-war bar: each team's color grows toward the centerline.
export default function TugBar({ a = 0, b = 0, total = 0, teamA, teamB }) {
  const aPct = total ? (a / total) * 100 : 0;
  const bPct = total ? (b / total) * 100 : 0;
  const clinch = total ? total / 2 + 0.5 : 0;
  return (
    <div className="cup">
      <div className="totals">
        <div className="tside">
          <div className="tname"><span className="dot" style={{ background: teamA?.color }} />{teamA?.name || 'Team A'}</div>
          <div className="tscore">{fmt(a)}</div>
        </div>
        <div className="tside right">
          <div className="tname">{teamB?.name || 'Team B'}<span className="dot" style={{ background: teamB?.color }} /></div>
          <div className="tscore">{fmt(b)}</div>
        </div>
      </div>
      <div className="clinchnote">{total ? `First to ${fmt(clinch)} of ${total}` : 'No matches yet'}</div>
      <div className="bar">
        <div className="fill" style={{ width: aPct + '%', background: teamA?.color || '#B23A2E' }} />
        <div className="fill gap" style={{ width: Math.max(0, 100 - aPct - bPct) + '%' }} />
        <div className="fill" style={{ width: bPct + '%', background: teamB?.color || '#1E3A5F', marginLeft: 'auto' }} />
        <div className="clinchline" />
      </div>
    </div>
  );
}
function fmt(n) { return Number.isInteger(n) ? String(n) : Number(n).toFixed(1); }
