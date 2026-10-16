import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { REACTIONS, useChat } from '../context/ChatContext';
import { disablePush, enablePush, pushStatus } from '../lib/push';
import { splitMentions } from '../lib/mentions';

const MAX = 500;
const HOLD_MS = 450;

function when(iso) {
  const d = new Date(iso);
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString()
    ? t : `${d.toLocaleDateString([], { weekday: 'short' })} ${t}`;
}

// The "@partial name" being typed just before the cursor, if any.
const typingMention = (text, caret) => {
  const m = text.slice(0, caret).match(/(?:^|\s)@([^@\n]{0,30})$/);
  return m ? { query: m[1], start: caret - m[1].length - 1 } : null;
};

export default function Chat() {
  const { realProfile } = useAuth();
  const { messages, people, reactions, react, markRead, send, remove, muted, setMuted } = useChat();
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [announce, setAnnounce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const listRef = useRef();
  const inputRef = useRef();
  const [push, setPush] = useState(null);       // see pushStatus()
  const [pushBusy, setPushBusy] = useState(false);
  const [picking, setPicking] = useState(null);   // message id with the emoji picker open
  const hold = useRef(null);   // pending press-and-hold: { timer, x, y }

  const me = realProfile.id;
  const isOrganizer = realProfile.role === 'organizer';
  const byId = useMemo(() => Object.fromEntries(people.map(p => [p.id, p])), [people]);

  // Reactions grouped per message, in REACTIONS order: { [message id]: [{ emoji, users }] }
  const reactionsBy = useMemo(() => {
    const by = {};
    for (const r of reactions) ((by[r.message_id] ||= {})[r.emoji] ||= []).push(r.user_id);
    return Object.fromEntries(Object.entries(by).map(([id, e]) =>
      [id, REACTIONS.filter(x => e[x]).map(x => ({ emoji: x, users: e[x] }))]));
  }, [reactions]);

  // Close the picker on a tap anywhere else.
  useEffect(() => {
    if (!picking) return;
    const close = e => { if (!e.target.closest('.reactpick')) setPicking(null); };
    listRef.current?.querySelector('.reactpick')?.scrollIntoView({ block: 'nearest' });
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [picking]);

  // Press and hold a message (or right-click it) to react. Presses on buttons, and presses
  // that turn into a scroll, don't count.
  const cancelHold = () => { clearTimeout(hold.current?.timer); hold.current = null; };
  const holdable = id => ({
    onPointerDown: e => {
      if (e.button !== 0 || e.target.closest('button')) return;
      cancelHold();
      hold.current = { x: e.clientX, y: e.clientY, timer: setTimeout(() => {
        hold.current = null; setPicking(id); navigator.vibrate?.(10);
      }, HOLD_MS) };
    },
    onPointerMove: e => {
      const h = hold.current;
      if (h && Math.hypot(e.clientX - h.x, e.clientY - h.y) > 10) cancelHold();
    },
    onPointerUp: cancelHold,
    onPointerCancel: cancelHold,
    onPointerLeave: cancelHold,
    onContextMenu: e => {
      if (e.target.closest('button')) return;
      e.preventDefault(); cancelHold(); setPicking(id);
    }
  });

  async function toggleReaction(id, emoji) {
    setPicking(null); setErr('');
    try { await react(id, emoji); } catch (e) { setErr(e.message || String(e)); }
  }

  useEffect(() => { pushStatus().then(setPush).catch(() => setPush('unsupported')); }, []);

  async function togglePush() {
    setPushBusy(true); setErr('');
    try {
      if (push === 'on') { await disablePush(); setPush('off'); }
      else setPush(await enablePush());
    } catch (e) { setErr(e.message || String(e)); }
    finally { setPushBusy(false); }
  }

  // Reading the page counts as reading the messages, and new ones scroll into view.
  useEffect(() => {
    markRead();
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  // @mention suggestions for what's being typed.
  const mention = typingMention(text, caret);
  const suggestions = !mention ? [] : people.filter(p => {
    const q = mention.query.toLowerCase().trimStart();
    const n = p.name.toLowerCase();
    return p.id !== me && (!q || n.startsWith(q) || n.split(/\s+/).some(w => w.startsWith(q)));
  }).slice(0, 5);

  function pick(p) {
    const next = text.slice(0, mention.start) + '@' + p.name + ' ' + text.slice(caret);
    const pos = mention.start + p.name.length + 2;
    setText(next); setCaret(pos);
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(pos, pos); });
  }

  async function submit(e) {
    e.preventDefault();
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true); setErr('');
    try { await send(body, announce ? 'announce' : 'chat'); setText(''); setCaret(0); setAnnounce(false); }
    catch (e) { setErr(e.message || String(e)); }
    finally { setBusy(false); }
  }

  async function del(id) {
    if (!confirm('Delete this message?')) return;
    try { await remove(id); } catch (e) { setErr(e.message || String(e)); }
  }

  const canDelete = m => ['chat', 'announce'].includes(m.kind) && (m.author_id === me || isOrganizer);
  const text_ = body => (
    <div className="msgtext">
      {splitMentions(body, people).map((part, i) => part.id
        ? <span key={i} className={'mention' + (part.id === me ? ' me' : '')}>{part.text}</span>
        : part.text)}
    </div>
  );
  const del_ = m => canDelete(m) &&
    <button className="btn-icon" onClick={() => del(m.id)} aria-label="Delete">✕</button>;
  const names = ids => ids.map(id => id === me ? 'You' : byId[id]?.name || 'Someone').join(', ');
  const reactbar = m => (
    <div className="reactbar">
      {(reactionsBy[m.id] || []).map(({ emoji, users }) => (
        <button key={emoji} type="button" className={'reactchip' + (users.includes(me) ? ' on' : '')}
          onClick={() => toggleReaction(m.id, emoji)} title={names(users)}
          aria-label={`${emoji} ${users.length}: ${names(users)}`} aria-pressed={users.includes(me)}>
          {emoji}<span>{users.length}</span>
        </button>
      ))}
      {picking === m.id && (
        <span className="reactpick" role="menu" aria-label="React">
          {REACTIONS.map(e => (
            <button key={e} type="button" role="menuitem" onClick={() => toggleReaction(m.id, e)}>{e}</button>
          ))}
        </span>
      )}
    </div>
  );
  const react_ = m => (reactionsBy[m.id] || picking === m.id) && reactbar(m);

  return (
    <div className="stack chat">
      <div className="row between">
        <h1>Chat</h1>
        <button className="mini" onClick={() => setMuted(!muted)}
          title="Pop-up alerts on this device. Updates still post here.">
          {muted ? '🔕 Alerts muted' : '🔔 Alerts on'}
        </button>
      </div>

      {push && push !== 'unsupported' && (
        <div className="pushrow">
          {push === 'on' && <><span>📲 Phone notifications are on for all chat messages, results and announcements.</span>
            <button className="mini" disabled={pushBusy} onClick={togglePush}>Turn off</button></>}
          {push === 'off' && <><span>Get every chat message, result and announcement on your phone, even when the app is closed.</span>
            <button className="mini" disabled={pushBusy} onClick={togglePush}>Turn on notifications</button></>}
          {push === 'blocked' && <span>Notifications are blocked for this site. Allow them in your browser settings to get them on your phone.</span>}
          {push === 'install' && <span>To get notifications on your iPhone: tap Share, then <b>Add to Home Screen</b>, open the app from there, and turn them on on this page.</span>}
        </div>
      )}

      <div className="msglist" ref={listRef}>
        {messages.length === 0 && <p className="muted">No messages yet. Say something!</p>}
        {messages.map(m => m.kind === 'chat' ? (
          <div key={m.id} className={'msg' + (m.author_id === me ? ' mine' : '')} {...holdable(m.id)}
            style={{ '--team': byId[m.author_id]?.color }}>
            <div className="msgmeta">
              <span className="msgname">{byId[m.author_id]?.name || 'Someone'}</span>
              <span>{when(m.created_at)}</span>
              {del_(m)}
            </div>
            {text_(m.body)}
            {react_(m)}
          </div>
        ) : m.kind === 'announce' ? (
          <div key={m.id} className="msg announce" {...holdable(m.id)}>
            <div className="msgmeta">
              <span className="msgname">📣 Announcement · {byId[m.author_id]?.name || 'Organizer'}</span>
              <span>{when(m.created_at)}</span>
              {del_(m)}
            </div>
            {text_(m.body)}
            {react_(m)}
          </div>
        ) : (
          <div key={m.id} className={'msg auto ' + m.kind} {...holdable(m.id)}>
            <div className="msgtext">{m.body}</div>
            <div className="msgmeta">
              <span>{when(m.created_at)}</span>
              {m.corrected && <span className="tag">corrected</span>}
            </div>
            {react_(m)}
          </div>
        ))}
        {messages.length > 0 && !reactions.length && <p className="muted small reacthint">Press and hold a message to react.</p>}
      </div>

      <form className="composer" onSubmit={submit}>
        {suggestions.length > 0 && (
          <div className="mentionlist">
            {suggestions.map(p => (
              <button type="button" key={p.id} onMouseDown={e => e.preventDefault()} onClick={() => pick(p)}>
                @{p.name}
              </button>
            ))}
          </div>
        )}
        {isOrganizer && (
          <button type="button" className={'announcebtn' + (announce ? ' on' : '')}
            onClick={() => setAnnounce(a => !a)} aria-pressed={announce}
            title="Announcements notify everyone in the event">📣</button>
        )}
        <input ref={inputRef} value={text} maxLength={MAX} aria-label="Message"
          placeholder={announce ? 'Announcement (notifies everyone)…' : 'Message everyone… (@ to mention)'}
          onChange={e => { setText(e.target.value); setCaret(e.target.selectionStart); }}
          onSelect={e => setCaret(e.target.selectionStart)} />
        <button className="primary" disabled={busy || !text.trim()}>{announce ? 'Announce' : 'Send'}</button>
      </form>
      {announce && <p className="muted small">Announcements send a notification to everyone in the event.</p>}
      {err && <p className="err">{err}</p>}
    </div>
  );
}
