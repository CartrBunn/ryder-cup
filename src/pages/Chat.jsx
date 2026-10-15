import { useEffect, useRef, useState } from 'react';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';
import { useChat } from '../context/ChatContext';
import { disablePush, enablePush, pushStatus } from '../lib/push';

const MAX = 500;

function when(iso) {
  const d = new Date(iso);
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString()
    ? t : `${d.toLocaleDateString([], { weekday: 'short' })} ${t}`;
}

export default function Chat() {
  const { profile, realProfile } = useAuth();
  const { messages, markRead, send, remove, muted, setMuted } = useChat();
  const [people, setPeople] = useState({});      // profile id -> { name, color }
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const listRef = useRef();
  const [push, setPush] = useState(null);       // see pushStatus()
  const [pushBusy, setPushBusy] = useState(false);

  useEffect(() => { pushStatus().then(setPush).catch(() => setPush('unsupported')); }, []);

  async function togglePush() {
    setPushBusy(true); setErr('');
    try {
      if (push === 'on') { await disablePush(); setPush('off'); }
      else setPush(await enablePush());
    } catch (e) { setErr(e.message || String(e)); }
    finally { setPushBusy(false); }
  }

  useEffect(() => {
    const evt = profile.event_id;
    Promise.all([
      supabase.from('profiles').select('id, display_name, team_id').eq('event_id', evt),
      supabase.from('teams').select('id, color').eq('event_id', evt)
    ]).then(([{ data: ps }, { data: ts }]) => {
      const color = Object.fromEntries((ts || []).map(t => [t.id, t.color]));
      setPeople(Object.fromEntries((ps || []).map(p => [p.id, { name: p.display_name, color: color[p.team_id] }])));
    });
  }, [profile.event_id]);

  // Reading the page counts as reading the messages, and new ones scroll into view.
  useEffect(() => {
    markRead();
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  async function submit(e) {
    e.preventDefault();
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true); setErr('');
    try { await send(body); setText(''); }
    catch (e) { setErr(e.message || String(e)); }
    finally { setBusy(false); }
  }

  async function del(id) {
    if (!confirm('Delete this message?')) return;
    try { await remove(id); } catch (e) { setErr(e.message || String(e)); }
  }

  const canDelete = m => m.kind === 'chat' && (m.author_id === realProfile.id || realProfile.role === 'organizer');

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
          {push === 'on' && <><span>📲 Phone notifications are on for results.</span>
            <button className="mini" disabled={pushBusy} onClick={togglePush}>Turn off</button></>}
          {push === 'off' && <><span>Get match results on your phone, even when the app is closed.</span>
            <button className="mini" disabled={pushBusy} onClick={togglePush}>Turn on notifications</button></>}
          {push === 'blocked' && <span>Notifications are blocked for this site. Allow them in your browser settings to get results on your phone.</span>}
          {push === 'install' && <span>To get results on your iPhone: tap Share, then <b>Add to Home Screen</b>, open the app from there, and turn on notifications on this page.</span>}
        </div>
      )}

      <div className="msglist" ref={listRef}>
        {messages.length === 0 && <p className="muted">No messages yet. Say something!</p>}
        {messages.map(m => m.kind === 'chat' ? (
          <div key={m.id} className={'msg' + (m.author_id === realProfile.id ? ' mine' : '')}
            style={{ '--team': people[m.author_id]?.color }}>
            <div className="msgmeta">
              <span className="msgname">{people[m.author_id]?.name || 'Someone'}</span>
              <span>{when(m.created_at)}</span>
              {canDelete(m) && <button className="btn-icon" onClick={() => del(m.id)} aria-label="Delete">✕</button>}
            </div>
            <div className="msgtext">{m.body}</div>
          </div>
        ) : (
          <div key={m.id} className={'msg auto ' + m.kind}>
            <div className="msgtext">{m.body}</div>
            <div className="msgmeta">
              <span>{when(m.created_at)}</span>
              {m.corrected && <span className="tag">corrected</span>}
            </div>
          </div>
        ))}
      </div>

      <form className="composer" onSubmit={submit}>
        <input value={text} maxLength={MAX} placeholder="Message everyone…"
          onChange={e => setText(e.target.value)} aria-label="Message" />
        <button className="primary" disabled={busy || !text.trim()}>Send</button>
      </form>
      {err && <p className="err">{err}</p>}
    </div>
  );
}
