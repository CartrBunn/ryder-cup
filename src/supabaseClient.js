import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
// Supabase's publishable key (sb_publishable_...) — the client-safe key that replaced
// the legacy "anon" key. Row Level Security still gates every query.
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!url || !publishableKey) {
  console.warn('Missing Supabase env vars — copy .env.example to .env.local and fill them in.');
}

export const supabase = createClient(url, publishableKey);

// A throwaway client that does NOT persist or share the main session. Used when an organizer
// creates a player account (signUp signs the caller in), so the organizer's own session stays put.
export const createTempClient = () =>
  createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, storageKey: 'sb-temp-admin' }
  });
