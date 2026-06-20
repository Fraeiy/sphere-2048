import { handleCors, jsonResponse, errorResponse } from '../_shared/cors.ts';
import { createServiceClient } from '../_shared/supabase.ts';

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const url = new URL(req.url);
  const period = url.searchParams.get('period') ?? 'global';
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 100);
  const weeklyRoundId = url.searchParams.get('weekly_round_id');

  if (period !== 'global' && period !== 'weekly') {
    return errorResponse('INVALID_PERIOD', 'period must be global or weekly');
  }

  try {
    const supabase = createServiceClient();

    let round = null;
    if (period === 'weekly') {
      if (weeklyRoundId) {
        const { data } = await supabase.from('weekly_rounds').select('*').eq('id', weeklyRoundId).single();
        round = data;
      } else {
        const { data: roundId } = await supabase.rpc('get_active_weekly_round');
        const { data } = await supabase.from('weekly_rounds').select('*').eq('id', roundId).single();
        round = data;
      }
    }

    let query = supabase
      .from('leaderboard_entries')
      .select('*')
      .eq('period_type', period)
      .order('score', { ascending: false })
      .order('recorded_at', { ascending: false })
      .limit(limit);

    if (period === 'weekly' && round?.id) {
      query = query.eq('weekly_round_id', round.id);
    }

    const { data: entries, error } = await query;
    if (error) throw error;

    return jsonResponse({ entries: entries ?? [], weekly_round: round });
  } catch (err) {
    console.error('[get-leaderboard]', err);
    return errorResponse('LEADERBOARD_FAILED', err instanceof Error ? err.message : 'Failed to load leaderboard', 500);
  }
});