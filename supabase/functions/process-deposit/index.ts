import { handleCors, jsonResponse, errorResponse } from '../_shared/cors.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import { getBearerToken, verifyPlayerToken } from '../_shared/auth.ts';

const PRIZE_POOL_BPS = 5000n; // 50% of weekly deposits
const UCT_ATOMIC_PER_TOKEN = 10n ** 18n;

function parseAmountAtomic(raw: string | number): bigint {
  if (typeof raw === 'bigint') return raw;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) throw new Error('Invalid amount_atomic');
    return BigInt(Math.trunc(raw));
  }
  const trimmed = String(raw).trim();
  if (!/^\d+$/.test(trimmed)) throw new Error('amount_atomic must be a positive integer string');
  return BigInt(trimmed);
}

function resolveMoves(amountAtomic: bigint, tiers: { id: string; token_amount: string; moves_granted: number }[]) {
  const amountUct = Number(amountAtomic / UCT_ATOMIC_PER_TOKEN);
  const sorted = [...tiers].sort((a, b) => Number(b.token_amount) - Number(a.token_amount));

  for (const tier of sorted) {
    if (amountUct === Number(tier.token_amount)) {
      return { moves: tier.moves_granted, tier };
    }
  }

  const base = sorted.at(-1);
  if (!base) return { moves: 0, tier: null };
  const ratio = base.moves_granted / Number(base.token_amount);
  return { moves: Math.floor(amountUct * ratio), tier: base };
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED', 'POST required', 405);

  try {
    const token = getBearerToken(req);
    if (!token) return errorResponse('UNAUTHORIZED', 'Bearer token required', 401);
    const claims = await verifyPlayerToken(token);

    const body = await req.json() as {
      tx_hash: string;
      amount_atomic: string | number;
      memo?: string;
      block_time?: string;
    };

    if (!body.tx_hash) {
      return errorResponse('INVALID_INPUT', 'tx_hash required');
    }

    let amountAtomic: bigint;
    try {
      amountAtomic = parseAmountAtomic(body.amount_atomic);
    } catch {
      return errorResponse('INVALID_INPUT', 'positive amount_atomic required');
    }
    if (amountAtomic <= 0n) {
      return errorResponse('INVALID_INPUT', 'positive amount_atomic required');
    }

    const supabase = createServiceClient();

    const { data: existingEvent } = await supabase
      .from('processed_chain_events')
      .select('id')
      .eq('tx_hash', body.tx_hash)
      .maybeSingle();

    if (existingEvent) {
      return errorResponse('DUPLICATE_TX', 'Transaction already processed', 409);
    }

    const { data: wallet } = await supabase
      .from('wallets')
      .select('id')
      .eq('player_id', claims.player_id)
      .eq('address', claims.wallet_address)
      .single();

    if (!wallet) return errorResponse('WALLET_NOT_FOUND', 'Wallet not registered', 404);

    const { data: tiers } = await supabase
      .from('credit_tiers')
      .select('id, token_amount, moves_granted')
      .eq('is_active', true);

    const { moves, tier } = resolveMoves(amountAtomic, tiers ?? []);
    if (moves <= 0) return errorResponse('INVALID_AMOUNT', 'Deposit amount too small for any tier');

    const { data: roundId } = await supabase.rpc('get_active_weekly_round');
    const prizeContribution = (amountAtomic * PRIZE_POOL_BPS) / 10000n;
    const amountAtomicStr = amountAtomic.toString();

    const { data: deposit, error: depErr } = await supabase
      .from('deposits')
      .insert({
        player_id: claims.player_id,
        wallet_id: wallet.id,
        weekly_round_id: roundId,
        credit_tier_id: tier?.id ?? null,
        tx_hash: body.tx_hash,
        amount_atomic: amountAtomicStr,
        moves_credited: moves,
        status: 'confirmed',
        block_time: body.block_time ?? new Date().toISOString(),
        memo: body.memo ?? null,
        confirmed_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (depErr || !deposit) throw depErr ?? new Error('Deposit insert failed');

    const { error: eventErr } = await supabase.from('processed_chain_events').insert({
      tx_hash: body.tx_hash,
      event_type: 'deposit',
      payload: { ...body, amount_atomic: amountAtomicStr },
    });
    if (eventErr) throw eventErr;

    const { data: balanceRow, error: creditErr } = await supabase.rpc('credit_moves_from_deposit', {
      p_player_id: claims.player_id,
      p_moves: moves,
    });
    if (creditErr) throw creditErr;

    if (roundId && prizeContribution > 0n) {
      const prizeStr = prizeContribution.toString();
      const { error: poolErr } = await supabase.from('prize_pool_records').insert({
        weekly_round_id: roundId,
        deposit_id: deposit.id,
        amount_atomic: prizeStr,
      });
      if (poolErr) throw poolErr;

      const { data: round } = await supabase
        .from('weekly_rounds')
        .select('prize_pool_atomic')
        .eq('id', roundId)
        .single();

      if (round) {
        const current = BigInt(String(round.prize_pool_atomic ?? '0'));
        const { error: roundErr } = await supabase.from('weekly_rounds').update({
          prize_pool_atomic: (current + prizeContribution).toString(),
        }).eq('id', roundId);
        if (roundErr) throw roundErr;
      }
    }

    const tierId = tier?.id ?? null;
    const { data: creditTier } = tierId
      ? await supabase.from('credit_tiers').select('*').eq('id', tierId).single()
      : { data: null };

    return jsonResponse({
      deposit_id: deposit.id,
      moves_credited: moves,
      move_balance: balanceRow,
      credit_tier: creditTier,
      prize_pool_contribution: prizeContribution.toString(),
    });
  } catch (err) {
    console.error('[process-deposit]', err);
    return errorResponse('DEPOSIT_FAILED', err instanceof Error ? err.message : 'Deposit processing failed', 500);
  }
});