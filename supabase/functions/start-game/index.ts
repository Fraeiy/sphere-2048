import { handleCors, jsonResponse, errorResponse } from '../_shared/cors.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import { getBearerToken, verifyPlayerToken } from '../_shared/auth.ts';
import { canMove, createInitialBoard, createSeededRng, type Board } from '../_shared/game-engine.ts';

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED', 'POST required', 405);

  try {
    const token = getBearerToken(req);
    if (!token) return errorResponse('UNAUTHORIZED', 'Bearer token required', 401);
    const claims = await verifyPlayerToken(token);

    const body = await req.json().catch(() => ({})) as { force_new?: boolean };
    const forceNew = Boolean(body.force_new);

    const supabase = createServiceClient();

    const { data: balance, error: balErr } = await supabase
      .from('move_balances')
      .select('credits_remaining, version')
      .eq('player_id', claims.player_id)
      .single();

    if (balErr || !balance) return errorResponse('NO_BALANCE', 'Move balance not found', 404);
    if (balance.credits_remaining <= 0) {
      return errorResponse('INSUFFICIENT_CREDITS', 'Deposit tokens to receive move credits', 402);
    }

    const { data: activeSession } = await supabase
      .from('game_sessions')
      .select('*')
      .eq('player_id', claims.player_id)
      .eq('status', 'active')
      .maybeSingle();

    const { data: player } = await supabase
      .from('players')
      .select('best_score')
      .eq('id', claims.player_id)
      .single();
    const bestScore = player?.best_score ?? 0;

    if (activeSession) {
      const board = activeSession.board_state as Board;
      const isStuck = !canMove(board);

      if (!forceNew && !isStuck) {
        const { data: fullBalance } = await supabase
          .from('move_balances')
          .select('*')
          .eq('player_id', claims.player_id)
          .single();
        return jsonResponse({ session: activeSession, move_balance: fullBalance, best_score: bestScore });
      }

      await supabase.from('game_sessions').update({
        status: 'completed',
        ended_at: new Date().toISOString(),
        ending_credits: balance.credits_remaining,
      }).eq('id', activeSession.id);
    }

    const { data: roundId } = await supabase.rpc('get_active_weekly_round');
    const serverSeed = crypto.randomUUID();
    const seedNum = [...serverSeed].reduce((a, c) => a + c.charCodeAt(0), 0);
    const board = createInitialBoard(createSeededRng(seedNum));

    const { data: session, error: sessErr } = await supabase
      .from('game_sessions')
      .insert({
        player_id: claims.player_id,
        weekly_round_id: roundId,
        starting_credits: balance.credits_remaining,
        board_state: board,
        server_seed: serverSeed,
        status: 'active',
      })
      .select('*')
      .single();

    if (sessErr || !session) throw sessErr ?? new Error('Failed to create session');

    const { data: fullBalance } = await supabase
      .from('move_balances')
      .select('*')
      .eq('player_id', claims.player_id)
      .single();

    return jsonResponse({ session, move_balance: fullBalance, best_score: bestScore });
  } catch (err) {
    console.error('[start-game]', err);
    return errorResponse('START_GAME_FAILED', err instanceof Error ? err.message : 'Failed to start game', 500);
  }
});