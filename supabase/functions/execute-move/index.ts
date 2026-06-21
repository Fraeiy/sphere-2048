import { handleCors, jsonResponse, errorResponse } from '../_shared/cors.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import { getBearerToken, verifyPlayerToken } from '../_shared/auth.ts';
import {
  applyMove,
  canMove,
  createSeededRng,
  getHighestTile,
  hasWon,
  spawnTile,
  type Board,
  type MoveDirection,
} from '../_shared/game-engine.ts';

const VALID_DIRECTIONS = new Set(['left', 'right', 'up', 'down']);

/** Inline credit deduction — avoids broken deduct_move_credit RPC (PG 42702 ambiguous column). */
async function deductMoveCredit(
  supabase: ReturnType<typeof createServiceClient>,
  playerId: string,
): Promise<{ success: boolean; credits_remaining: number; new_version: number }> {
  const { data: row, error: fetchErr } = await supabase
    .from('move_balances')
    .select('credits_remaining, version')
    .eq('player_id', playerId)
    .single();

  if (fetchErr || !row || row.credits_remaining <= 0) {
    return { success: false, credits_remaining: row?.credits_remaining ?? 0, new_version: row?.version ?? 0 };
  }

  const { data: updated, error: updateErr } = await supabase
    .from('move_balances')
    .update({
      credits_remaining: row.credits_remaining - 1,
      version: row.version + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('player_id', playerId)
    .eq('version', row.version)
    .gt('credits_remaining', 0)
    .select('credits_remaining, version')
    .maybeSingle();

  if (updateErr || !updated) {
    return { success: false, credits_remaining: row.credits_remaining, new_version: row.version };
  }

  return { success: true, credits_remaining: updated.credits_remaining, new_version: updated.version };
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED', 'POST required', 405);

  try {
    const token = getBearerToken(req);
    if (!token) return errorResponse('UNAUTHORIZED', 'Bearer token required', 401);
    const claims = await verifyPlayerToken(token);

    const body = await req.json() as { session_id: string; direction: MoveDirection };
    const idempotencyKey = req.headers.get('x-idempotency-key');

    if (!body.session_id || !body.direction) {
      return errorResponse('INVALID_INPUT', 'session_id and direction required');
    }
    if (!VALID_DIRECTIONS.has(body.direction)) {
      return errorResponse('INVALID_DIRECTION', 'Invalid move direction');
    }

    const supabase = createServiceClient();

    const { data: session, error: sessErr } = await supabase
      .from('game_sessions')
      .select('*')
      .eq('id', body.session_id)
      .eq('player_id', claims.player_id)
      .eq('status', 'active')
      .single();

    if (sessErr || !session) return errorResponse('SESSION_NOT_FOUND', 'Active session not found', 404);

    const board = session.board_state as Board;
    const { board: nextBoard, score: gained, moved } = applyMove(board, body.direction);

    if (!moved) {
      const [{ data: balance }, { data: player }] = await Promise.all([
        supabase.from('move_balances').select('*').eq('player_id', claims.player_id).single(),
        supabase.from('players').select('best_score').eq('id', claims.player_id).single(),
      ]);
      return jsonResponse({
        session,
        moved: false,
        move_balance: balance,
        game_over: !canMove(board),
        won: hasWon(board),
        best_score: player?.best_score ?? 0,
      });
    }

    const deduction = await deductMoveCredit(supabase, claims.player_id);
    if (!deduction.success) {
      return errorResponse('INSUFFICIENT_CREDITS', 'No move credits remaining', 402);
    }

    const seedNum = [...session.server_seed].reduce((a, c) => a + c.charCodeAt(0), 0);
    const rng = createSeededRng(seedNum + session.move_count + 1);
    spawnTile(nextBoard, rng);

    const newScore = session.score + gained;
    const newMoveCount = session.move_count + 1;
    const highestTile = getHighestTile(nextBoard);
    const gameOver = !canMove(nextBoard);
    const won = hasWon(nextBoard);

    const { data: updated, error: updateErr } = await supabase
      .from('game_sessions')
      .update({
        board_state: nextBoard,
        score: newScore,
        highest_tile: highestTile,
        move_count: newMoveCount,
        status: gameOver ? 'completed' : 'active',
        ended_at: gameOver ? new Date().toISOString() : null,
        ending_credits: gameOver ? deduction.credits_remaining : null,
      })
      .eq('id', body.session_id)
      .select('*')
      .single();
    if (updateErr || !updated) throw updateErr ?? new Error('Failed to update session');

    const { error: moveLogErr } = await supabase.from('session_moves').insert({
      session_id: body.session_id,
      move_number: newMoveCount,
      direction: body.direction,
      score_after: newScore,
      highest_tile_after: highestTile,
      board_after: nextBoard,
    });
    if (moveLogErr) throw moveLogErr;

    const [{ data: balance }, { data: bestScore }] = await Promise.all([
      supabase.from('move_balances').select('*').eq('player_id', claims.player_id).single(),
      supabase.rpc('update_best_score_if_higher', { p_player_id: claims.player_id, p_score: newScore }),
    ]);

    if (gameOver) {
      await recordLeaderboardEntries(supabase, updated, claims);
    }

    return jsonResponse({
      session: updated,
      moved: true,
      move_balance: balance,
      game_over: gameOver,
      won,
      best_score: bestScore ?? 0,
    });
  } catch (err) {
    console.error('[execute-move]', err);
    return errorResponse('MOVE_FAILED', err instanceof Error ? err.message : 'Move failed', 500);
  }
});

async function recordLeaderboardEntries(
  supabase: ReturnType<typeof createServiceClient>,
  session: Record<string, unknown>,
  claims: { player_id: string; did: string; wallet_address: string },
) {
  if (!session.score || (session.score as number) <= 0) return;

  const entries = [
    {
      player_id: claims.player_id,
      game_session_id: session.id,
      wallet_address: claims.wallet_address,
      player_did: claims.did,
      score: session.score,
      highest_tile: session.highest_tile,
      period_type: 'global',
      weekly_round_id: null,
    },
  ];

  if (session.weekly_round_id) {
    entries.push({
      player_id: claims.player_id,
      game_session_id: session.id as string,
      wallet_address: claims.wallet_address,
      player_did: claims.did,
      score: session.score as number,
      highest_tile: session.highest_tile as number,
      period_type: 'weekly',
      weekly_round_id: session.weekly_round_id as string,
    });
  }

  await supabase.from('leaderboard_entries').upsert(entries, {
    onConflict: 'game_session_id,period_type',
  });
}