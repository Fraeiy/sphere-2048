import { handleCors, jsonResponse, errorResponse } from '../_shared/cors.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import { signPlayerToken } from '../_shared/auth.ts';

interface RegisterBody {
  did: string;
  nametag?: string;
  wallet_address: string;
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED', 'POST required', 405);

  try {
    const body = await req.json() as RegisterBody;
    if (!body.did || !body.wallet_address) {
      return errorResponse('INVALID_INPUT', 'did and wallet_address are required');
    }

    const supabase = createServiceClient();

    const { data: existingPlayer } = await supabase
      .from('players')
      .select('id, did, display_name, best_score, created_at, updated_at')
      .eq('did', body.did)
      .maybeSingle();

    let playerId: string;

    if (existingPlayer) {
      playerId = existingPlayer.id;
      if (body.nametag && body.nametag !== existingPlayer.display_name) {
        await supabase.from('players').update({ display_name: body.nametag }).eq('id', playerId);
      }
    } else {
      const { data: newPlayer, error: playerErr } = await supabase
        .from('players')
        .insert({ did: body.did, display_name: body.nametag ?? body.did })
        .select('id, did, display_name, best_score, created_at, updated_at')
        .single();
      if (playerErr || !newPlayer) throw playerErr ?? new Error('Failed to create player');
      playerId = newPlayer.id;
    }

    const { data: wallet, error: walletErr } = await supabase
      .from('wallets')
      .upsert({
        player_id: playerId,
        address: body.wallet_address,
        is_primary: true,
      }, { onConflict: 'address' })
      .select('id, player_id, address, chain, is_primary, created_at')
      .single();
    if (walletErr || !wallet) throw walletErr ?? new Error('Failed to upsert wallet');

    const { data: balance } = await supabase
      .from('move_balances')
      .select('id, player_id, credits_remaining, credits_lifetime, version, updated_at')
      .eq('player_id', playerId)
      .maybeSingle();

    let moveBalance = balance;
    if (!moveBalance) {
      const { data: created, error: balErr } = await supabase
        .from('move_balances')
        .insert({ player_id: playerId, credits_remaining: 0, credits_lifetime: 0 })
        .select('id, player_id, credits_remaining, credits_lifetime, version, updated_at')
        .single();
      if (balErr || !created) throw balErr ?? new Error('Failed to init balance');
      moveBalance = created;
    }

    const { data: player } = await supabase
      .from('players')
      .select('id, did, display_name, best_score, created_at, updated_at')
      .eq('id', playerId)
      .single();

    const access_token = await signPlayerToken({
      player_id: playerId,
      did: body.did,
      wallet_address: body.wallet_address,
      role: 'player',
    });

    return jsonResponse({ player, wallet, move_balance: moveBalance, access_token });
  } catch (err) {
    console.error('[register-player]', err);
    return errorResponse('REGISTER_FAILED', err instanceof Error ? err.message : 'Registration failed', 500);
  }
});