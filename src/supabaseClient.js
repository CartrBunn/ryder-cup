import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
// Supabase's publishable key (sb_publishable_...) — the client-safe key that replaced
// the legacy "anon" key. Row Level Security still gates every query.
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!url || !publishableKey) {
  console.warn('Missing Supabase env vars — copy .env.example to .env.local and fill them in.');
}

export const supabase = createClient(url, publishableKey);
