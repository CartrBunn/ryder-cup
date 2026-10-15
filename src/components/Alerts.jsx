import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';
import { useChat } from '../context/ChatContext';
import { TOAST_KINDS } from '../lib/automations';

const GATHER = 2500;     // ms to wait for more alerts so a burst shows as one pop-up
const SHOW_FOR = 9000;   // ms a pop-up stays up

// "You're in Match 3 vs Brown" for the players in a round whose pairings were just posted.
async function myPairing(roundId, me) {
  const { data: ms } = await supabase.from('matches').select('*').eq('round_id', roundId);
  const m = (ms || []).find(x => x.side_a_players.includes(me) || x.side_b_players.includes(me));
  if (!m) return null;
  const mine = m.side_a_players.includes(me) ? m.side_a_players : m.side_b_players;
  const theirs = mine === m.side_a_players ? m.side_b_players : m.side_a_players;
  const { data: ps } = await supabase.from('profiles').select('id, display_name').in('id', [...mine, ...theirs]);
  const name = id => ps?.find(p => p.id === id)?.display_name || '—';
  const partners = mine.filter(id => id !== me).map(name);
  const who = partners.length ? `You and ${partners.join(' & ')} are` : "You're";
  const start = m.start_hole ? `, starting on hole ${m.start_hole}` : '';
  return `${who} in Match ${m.seq} vs ${theirs.map(name).join('/')}${start}`;
}

// Pop-up alerts for automated posts. Bursts are combined into one, nothing pops up over the
// scorecard (it waits until you leave the match page) or on the chat page (you're reading it),
// and a muted device gets none.
export default function Alerts() {
  const { realProfile } = useAuth();
  const { onLiveInsert, muted } = useChat();
  const { pathname } = useLocation();
  const nav = useNavigate();
  const [toast, setToast] = useState(null);       // { lines: [] }
  const gathered = useRef([]);
  const held = useRef([]);
  const timers = useRef({});
  const state = useRef({});
  state.current = { pathname, muted };

  const quietHere = p => p.startsWith('/match/');
  const show = lines => {
    setToast({ lines, key: Date.now() });
    clearTimeout(timers.current.hide);
    timers.current.hide = setTimeout(() => setToast(null), SHOW_FOR);
  };

  function release() {
    const lines = gathered.current;
    gathered.current = [];
    const { pathname, muted } = state.current;
    if (muted || pathname === '/chat' || !lines.length) return;
    if (quietHere(pathname)) { held.current.push(...lines); return; }
    show(lines);
  }
  function add(line) {
    gathered.current.push(line);
    if (!timers.current.gather) {
      timers.current.gather = setTimeout(() => { timers.current.gather = null; release(); }, GATHER);
    }
  }

  useEffect(() => onLiveInsert(async row => {
    if (TOAST_KINDS.has(row.kind)) add(row.body);
    else if (row.kind === 'pairings' && realProfile) {
      const line = await myPairing(row.auto_key.split(':')[1], realProfile.id).catch(() => null);
      if (line) add('📋 ' + line);
    }
  }), [realProfile?.id]);

  // Leaving the match page shows what was held back while scoring.
  useEffect(() => {
    if (quietHere(pathname) || !held.current.length) return;
    const lines = held.current;
    held.current = [];
    if (!muted && pathname !== '/chat') show(lines);
  }, [pathname]);

  useEffect(() => () => { clearTimeout(timers.current.hide); clearTimeout(timers.current.gather); }, []);
  useEffect(() => { if (pathname === '/chat') setToast(null); }, [pathname]);

  if (!toast) return null;
  const { lines } = toast;
  return (
    <div className="alert" role="status" key={toast.key}
      onClick={() => { setToast(null); nav('/chat'); }}>
      <div className="alertbody">
        {lines.length > 1 && <div className="alerthead">{lines.length} updates</div>}
        {lines.slice(0, 3).map((l, i) => <div key={i}>{l}</div>)}
        {lines.length > 3 && <div className="muted small">+{lines.length - 3} more in chat</div>}
      </div>
      <button className="alertx" aria-label="Dismiss"
        onClick={e => { e.stopPropagation(); setToast(null); }}>✕</button>
    </div>
  );
}
