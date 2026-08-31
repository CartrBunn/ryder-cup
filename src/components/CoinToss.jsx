import { useState } from 'react';

// Stored, shared coin toss. The result (`firstTeamId`) lives in the DB so every device sees
// the same winner; `locked` hides the button once picking has started. Only `canFlip` viewers
// (organizer + captains) get the flip button — everyone else just watches the result.
export default function CoinToss({ teams, firstTeamId, locked, canFlip, onToss }) {
  const [flipping, setFlipping] = useState(false);

  async function toss() {
    setFlipping(true);
    await new Promise(r => setTimeout(r, 900));
    const idx = Math.round(Math.random());
    setFlipping(false);
    onToss(teams[idx].id);
  }

  // When locked with no explicit toss, the effective first picker is the default (teams[0]).
  const winner = flipping ? null
    : (teams.find(t => t.id === firstTeamId) || (locked ? teams[0] : null));

  return (
    <div className="card" style={{ textAlign: 'center' }}>
      <style>{`@keyframes coinflip { 0%,100%{transform:rotateY(0)} 50%{transform:rotateY(90deg)} }`}</style>
      <div style={{
        fontSize: 52, lineHeight: 1, marginBottom: 8,
        display: 'inline-block',
        animation: flipping ? 'coinflip 0.25s linear infinite' : 'none',
      }}>🪙</div>
      <div style={{ marginBottom: locked ? 0 : 8 }}>
        {flipping
          ? <span className="muted">Flipping…</span>
          : winner
            ? <span><strong style={{ color: winner.color }}>{winner.name}</strong> picks first{locked && <span className="muted"> · locked in</span>}</span>
            : <span className="muted">{canFlip ? 'Flip to decide who picks first' : 'Waiting for the toss…'}</span>}
      </div>
      {!locked && canFlip && (
        <button className={winner ? '' : 'primary'} onClick={toss} disabled={flipping}>
          {winner ? 'Flip again' : 'Flip coin'}
        </button>
      )}
    </div>
  );
}
