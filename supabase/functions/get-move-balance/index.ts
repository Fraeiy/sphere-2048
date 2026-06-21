import { handleCors, jsonResponse, errorResponse } from '../_shared/cors.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import { getBearerToken, verifyPlayerToken } from '../_shared/auth.ts';

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'GET') return errorResponse('METHOD_NOT_ALLOWED', 'GET required', 405);

  try {
    const token = getBearerToken(req);
    if (!token) return errorResponse('UNAUTHORIZED', 'Bearer token required', 401);
    const claims = await verifyPlayerToken(token);

    const supabase = createServiceClient();
    const { data: balance, error } = await supabase
      .from('move_balances')
      .select('id, player_id, credits_remaining, credits_lifetime, version, updated_at')
      .eq('player_id', claims.player_id)
      .single();

    if (error || !balance) return errorResponse('NO_BALANCE', 'Move balance not found', 404);

    const { data: player } = await supabase
      .from('players')
      .select('best_score')
      .eq('id', claims.player_id)
      .single();

    return jsonResponse({
      move_balance: balance,
      best_score: player?.best_score ?? 0,
    });
  } catch (err) {
    console.error('[get-move-balance]', err);
    return errorResponse('BALANCE_FETCH_FAILED', err instanceof Error ? err.message : 'Failed to fetch balance', 500);
  }
});