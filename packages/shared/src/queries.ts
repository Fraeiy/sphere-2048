/**
 * Canonical Supabase queries used by Edge Functions and client reads.
 * All balance/session mutations go through RPC or service-role Edge Functions.
 */

export const QUERIES = {
  playerByDid: `
    SELECT id, did, display_name, created_at, updated_at
    FROM players WHERE did = $1
  `,

  walletByAddress: `
    SELECT id, player_id, address, chain, is_primary, created_at
    FROM wallets WHERE address = $1
  `,

  moveBalanceByPlayer: `
    SELECT id, player_id, credits_remaining, credits_lifetime, version, updated_at
    FROM move_balances WHERE player_id = $1
  `,

  activeCreditTiers: `
    SELECT id, token_symbol, token_amount, moves_granted, label, sort_order
    FROM credit_tiers WHERE is_active = true ORDER BY sort_order ASC
  `,

  activeSession: `
    SELECT * FROM game_sessions
    WHERE player_id = $1 AND status = 'active' LIMIT 1
  `,

  globalLeaderboard: `
    SELECT * FROM get_leaderboard('global'::leaderboard_period, NULL, $1)
  `,

  weeklyLeaderboard: `
    SELECT * FROM get_leaderboard('weekly'::leaderboard_period, $1, $2)
  `,

  depositByTxHash: `
    SELECT id FROM deposits WHERE tx_hash = $1
  `,

  processedEventByTxHash: `
    SELECT id FROM processed_chain_events WHERE tx_hash = $1
  `,

  sessionMovesForValidation: `
    SELECT move_number, direction FROM session_moves
    WHERE session_id = $1 ORDER BY move_number ASC
  `,

  weeklyPoolSummary: `
    SELECT wr.*,
      (SELECT COUNT(*) FROM deposits d WHERE d.weekly_round_id = wr.id AND d.status = 'confirmed') AS deposit_count
    FROM weekly_rounds wr
    WHERE wr.id = $1
  `,
} as const;