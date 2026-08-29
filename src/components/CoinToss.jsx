import { useState } from 'react';

export default function CoinToss({ teams, firstTeamIdx, onToss }) {
  const [flipping, setFlipping] = useState(false);

  async function toss() {
    setFlipping(true);
    await new Promise(r => setTimeout(r, 900));
    const idx = Math.round(Math.random());
    setFlipping(false);
    onToss(idx);
  }

  const winner = firstTeamIdx !== null && !flipping ? teams[firstTeamIdx] : null;

  return (
    <div className="card" style={{ textAlign: 'center' }}>
      <style>{`@keyframes coinflip { 0%,100%{transform:rotateY(0)} 50%{transform:rotateY(90deg)} }`}</style>
      <div style={{
        fontSize: 52, lineHeight: 1, marginBottom: 8,
        display: 'inline-block',
        animation: flipping ? 'coinflip 0.25s linear infinite' : 'none',
      }}>🪙</div>
      <div style={{ marginBottom: 8 }}>
        {flipping
          ? <span className="muted">Flipping…</span>
          : winner
            ? <span><strong style={{ color: winner.color }}>{winner.name}</strong> won the toss — they pick first</span>
            : <span className="muted">Flip to decide who picks first</span>}
      </div>
      <button className={winner ? '' : 'primary'} onClick={toss} disabled={flipping}>
        {winner ? 'Flip again' : 'Flip coin'}
      </button>
    </div>
  );
}
