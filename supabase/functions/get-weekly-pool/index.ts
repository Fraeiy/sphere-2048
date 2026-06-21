import { handleCors, jsonResponse, errorResponse } from '../_shared/cors.ts';
import { createServiceClient } from '../_shared/supabase.ts';

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = createServiceClient();
    const { data: roundId } = await supabase.rpc('get_active_weekly_round');
    const { data: round, error: roundErr } = await supabase
      .from('weekly_rounds')
      .select('*')
      .eq('id', roundId)
      .single();
    if (roundErr || !round) throw roundErr ?? new Error('No active round');

    const { count: depositCount } = await supabase
      .from('deposits')
      .select('id', { count: 'exact', head: true })
      .eq('weekly_round_id', round.id)
      .eq('status', 'confirmed');

    const { data: topEntries } = await supabase.rpc('get_leaderboard', {
      p_period: 'weekly',
      p_weekly_round_id: round.id,
      p_limit: 10,
    });

    const { count: pendingPayouts } = await supabase
      .from('payout_records')
      .select('id', { count: 'exact', head: true })
      .eq('weekly_round_id', round.id)
      .eq('status', 'pending');

    const poolAtomic = String(round.prize_pool_atomic ?? '0');

    return jsonResponse({
      round: { ...round, prize_pool_atomic: poolAtomic },
      prize_pool_atomic: poolAtomic,
      deposit_count: depositCount ?? 0,
      top_entries: topEntries ?? [],
      pending_payouts: pendingPayouts ?? 0,
    });
  } catch (err) {
    console.error('[get-weekly-pool]', err);
    return errorResponse('POOL_FAILED', err instanceof Error ? err.message : 'Failed to load weekly pool', 500);
  }
});