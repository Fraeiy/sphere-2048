import { handleCors, jsonResponse, errorResponse } from '../_shared/cors.ts';
import { createServiceClient } from '../_shared/supabase.ts';

/** Payout distribution: 50% / 30% / 20% for top 3 weekly scorers. */
const PAYOUT_SHARES = [0.5, 0.3, 0.2];

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const cronSecret = Deno.env.get('CRON_SECRET');
  if (cronSecret && req.headers.get('x-cron-secret') !== cronSecret) {
    return errorResponse('FORBIDDEN', 'Invalid cron secret', 403);
  }

  try {
    const supabase = createServiceClient();

    const { data: rounds } = await supabase
      .from('weekly_rounds')
      .select('*')
      .eq('status', 'active')
      .lt('ends_at', new Date().toISOString())
      .order('round_number', { ascending: true })
      .limit(1);

    const round = rounds?.[0];
    if (!round) return jsonResponse({ settled: false, message: 'No round ready for settlement' });

    await supabase.from('weekly_rounds').update({ status: 'settling' }).eq('id', round.id);

    const { data: winners } = await supabase
      .from('leaderboard_entries')
      .select('player_id, wallet_address, score, highest_tile')
      .eq('period_type', 'weekly')
      .eq('weekly_round_id', round.id)
      .order('score', { ascending: false })
      .limit(3);

    const pool = BigInt(round.prize_pool_atomic ?? 0);
    const payouts = [];

    for (let i = 0; i < (winners?.length ?? 0); i++) {
      const share = PAYOUT_SHARES[i] ?? 0;
      const amount = Number((pool * BigInt(Math.round(share * 10000))) / 10000n);
      if (amount <= 0) continue;
      payouts.push({
        weekly_round_id: round.id,
        player_id: winners![i].player_id,
        rank: i + 1,
        amount_atomic: amount,
        wallet_address: winners![i].wallet_address,
        status: 'pending',
      });
    }

    if (payouts.length) {
      await supabase.from('payout_records').upsert(payouts, {
        onConflict: 'weekly_round_id,rank',
      });
    }

    await supabase.from('weekly_rounds').update({
      status: 'completed',
      settled_at: new Date().toISOString(),
    }).eq('id', round.id);

    const nextStart = new Date(round.ends_at);
    const nextEnd = new Date(nextStart.getTime() + 7 * 24 * 60 * 60 * 1000);
    await supabase.from('weekly_rounds').insert({
      round_number: round.round_number + 1,
      starts_at: nextStart.toISOString(),
      ends_at: nextEnd.toISOString(),
      status: 'active',
    });

    return jsonResponse({
      settled: true,
      round_id: round.id,
      payouts_created: payouts.length,
      winners: winners ?? [],
    });
  } catch (err) {
    console.error('[settle-weekly-round]', err);
    return errorResponse('SETTLEMENT_FAILED', err instanceof Error ? err.message : 'Settlement failed', 500);
  }
});