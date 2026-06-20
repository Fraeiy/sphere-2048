import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anon) {
  console.warn('[Supabase] VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY required for realtime');
}

export const supabase = url && anon
  ? createClient(url, anon)
  : null;

/** Subscribe to leaderboard realtime inserts. */
export function subscribeLeaderboard(
  period: 'global' | 'weekly',
  onInsert: (entry: Record<string, unknown>) => void,
) {
  if (!supabase) return () => undefined;

  const channel = supabase
    .channel(`leaderboard:${period}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'leaderboard_entries',
        filter: `period_type=eq.${period}`,
      },
      (payload) => onInsert(payload.new as Record<string, unknown>),
    )
    .subscribe();

  return () => { supabase.removeChannel(channel); };
}