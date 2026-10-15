import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { supabase } from '../supabaseClient';
import { useAuth } from './AuthContext';

// Event chat: the latest messages, kept live over realtime, plus the unread count and the
// per-device alert mute. Lives above the routes so the nav badge and pop-up alerts work on
// every page.
const ChatCtx = createContext(null);
export const useChat = () => useContext(ChatCtx);

const LIMIT = 300;
const ls = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} }
};
const time = m => new Date(m.created_at).getTime();

export function ChatProvider({ children }) {
  const { realProfile } = useAuth();
  const evt = realProfile?.event_id, me = realProfile?.id;
  const [messages, setMessages] = useState([]);
  const [lastRead, setLastRead] = useState(0);
  const [muted, setMutedState] = useState(() => ls.get('alertsMuted') === '1');
  const listeners = useRef(new Set());   // live-insert callbacks (Alerts)

  const setMuted = v => { setMutedState(v); ls.set('alertsMuted', v ? '1' : '0'); };

  async function load() {
    const { data, error } = await supabase.from('messages').select('*')
      .eq('event_id', evt).order('created_at', { ascending: false }).limit(LIMIT);
    if (error) return;
    const rows = data.reverse();
    setMessages(rows);
    // A device opening chat for the first time starts caught up, not with the whole history unread.
    if (ls.get('chatRead:' + evt) == null) {
      const latest = rows.length ? time(rows[rows.length - 1]) : Date.now();
      ls.set('chatRead:' + evt, String(latest));
    }
    setLastRead(Number(ls.get('chatRead:' + evt)) || 0);
  }

  useEffect(() => {
    if (!evt) { setMessages([]); return; }
    load();
    const ch = supabase.channel('chat-' + evt)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `event_id=eq.${evt}` },
        ({ new: row }) => {
          setMessages(prev => prev.some(m => m.id === row.id) ? prev : [...prev, row].slice(-LIMIT));
          listeners.current.forEach(fn => fn(row));
        })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter: `event_id=eq.${evt}` },
        ({ new: row }) => setMessages(prev => prev.map(m => m.id === row.id ? row : m)))
      // DELETE payloads carry only the id and can't be filtered by event.
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' },
        ({ old }) => setMessages(prev => prev.filter(m => m.id !== old?.id)))
      .subscribe();
    // Catch up on anything missed while the phone was asleep.
    const onVisible = () => { if (!document.hidden) load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { supabase.removeChannel(ch); document.removeEventListener('visibilitychange', onVisible); };
  }, [evt]);

  const visible = messages.filter(m => !m.retracted);
  const unread = visible.filter(m => m.author_id !== me && time(m) > lastRead).length;

  function markRead() {
    const latest = visible.length ? time(visible[visible.length - 1]) : 0;
    if (latest > lastRead) { setLastRead(latest); ls.set('chatRead:' + evt, String(latest)); }
  }

  async function send(body) {
    const { data, error } = await supabase.from('messages')
      .insert({ event_id: evt, author_id: me, body }).select().single();
    if (error) throw error;
    setMessages(prev => prev.some(m => m.id === data.id) ? prev : [...prev, data]);
  }

  async function remove(id) {
    const { error } = await supabase.from('messages').delete().eq('id', id);
    if (error) throw error;
    setMessages(prev => prev.filter(m => m.id !== id));
  }

  const onLiveInsert = fn => { listeners.current.add(fn); return () => listeners.current.delete(fn); };

  return (
    <ChatCtx.Provider value={{ messages: visible, unread, markRead, send, remove, onLiveInsert, muted, setMuted }}>
      {children}
    </ChatCtx.Provider>
  );
}
