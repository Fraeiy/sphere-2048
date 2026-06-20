import { handleCors, jsonResponse, errorResponse } from '../_shared/cors.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import { getBearerToken, verifyPlayerToken } from '../_shared/auth.ts';
import { validateMoveSequence } from '../_shared/game-engine.ts';

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED', 'POST required', 405);

  try {
    const token = getBearerToken(req);
    if (!token) return errorResponse('UNAUTHORIZED', 'Bearer token required', 401);
    const claims = await verifyPlayerToken(token);

    const { session_id } = await req.json() as { session_id: string };
    if (!session_id) return errorResponse('INVALID_INPUT', 'session_id required');

    const supabase = createServiceClient();

    const { data: session, error: sessErr } = await supabase
      .from('game_sessions')
      .select('*')
      .eq('id', session_id)
      .eq('player_id', claims.player_id)
      .single();
    if (sessErr || !session) return errorResponse('SESSION_NOT_FOUND', 'Session not found', 404);

    const { data: moves } = await supabase
      .from('session_moves')
      .select('move_number, direction')
      .eq('session_id', session_id)
      .order('move_number', { ascending: true });

    const validation = validateMoveSequence(
      session.server_seed,
      (moves ?? []).map((m) => ({ move_number: m.move_number, direction: m.direction })),
    );

    if (!validation.valid || validation.finalScore !== session.score) {
      await supabase.from('game_sessions').update({ validated: false, status: 'forfeited' }).eq('id', session_id);
      return errorResponse('SCORE_INVALID', 'Score failed server validation', 422);
    }

    const { data: balance } = await supabase.from('move_balances').select('credits_remaining').eq('player_id', claims.player_id).single();

    const { data: updated } = await supabase
      .from('game_sessions')
      .update({
        status: 'completed',
        validated: true,
        ended_at: new Date().toISOString(),
        ending_credits: balance?.credits_remaining ?? 0,
        highest_tile: validation.highestTile,
      })
      .eq('id', session_id)
      .select('*')
      .single();

    const entries = [];
    if (updated && updated.score > 0) {
      entries.push({
        player_id: claims.player_id,
        game_session_id: session_id,
        wallet_address: claims.wallet_address,
        player_did: claims.did,
        score: updated.score,
        highest_tile: updated.highest_tile,
        period_type: 'global',
      });
      if (updated.weekly_round_id) {
        entries.push({
          player_id: claims.player_id,
          game_session_id: session_id,
          wallet_address: claims.wallet_address,
          player_did: claims.did,
          score: updated.score,
          highest_tile: updated.highest_tile,
          period_type: 'weekly',
          weekly_round_id: updated.weekly_round_id,
        });
      }
      await supabase.from('leaderboard_entries').upsert(entries, { onConflict: 'game_session_id,period_type' });
    }

    const { data: leaderboard_entries } = await supabase
      .from('leaderboard_entries')
      .select('*')
      .eq('game_session_id', session_id);

    return jsonResponse({ session: updated, leaderboard_entries: leaderboard_entries ?? [] });
  } catch (err) {
    console.error('[end-game]', err);
    return errorResponse('END_GAME_FAILED', err instanceof Error ? err.message : 'Failed to end game', 500);
  }
});