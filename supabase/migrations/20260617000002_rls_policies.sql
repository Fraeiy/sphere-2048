-- Row Level Security policies
-- Service role (Edge Functions) bypasses RLS.
-- Authenticated players read own data via JWT claims: sub = player_id, did, wallet_address.

ALTER TABLE players ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE move_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE deposits ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_moves ENABLE ROW LEVEL SECURITY;
ALTER TABLE leaderboard_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE weekly_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE prize_pool_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE payout_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_tiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE processed_chain_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_nonces ENABLE ROW LEVEL SECURITY;

-- Public read: credit tiers, leaderboards, weekly rounds
CREATE POLICY credit_tiers_public_read ON credit_tiers
  FOR SELECT USING (is_active = true);

CREATE POLICY weekly_rounds_public_read ON weekly_rounds
  FOR SELECT USING (true);

CREATE POLICY leaderboard_global_read ON leaderboard_entries
  FOR SELECT USING (true);

CREATE POLICY prize_pool_public_read ON prize_pool_records
  FOR SELECT USING (true);

-- Players: read/update own profile
CREATE POLICY players_read_own ON players
  FOR SELECT USING (id::text = auth.jwt() ->> 'player_id');

CREATE POLICY players_update_own ON players
  FOR UPDATE USING (id::text = auth.jwt() ->> 'player_id');

-- Wallets: read own wallets
CREATE POLICY wallets_read_own ON wallets
  FOR SELECT USING (player_id::text = auth.jwt() ->> 'player_id');

-- Move balances: read own balance only (writes via service role)
CREATE POLICY move_balances_read_own ON move_balances
  FOR SELECT USING (player_id::text = auth.jwt() ->> 'player_id');

-- Deposits: read own deposits
CREATE POLICY deposits_read_own ON deposits
  FOR SELECT USING (player_id::text = auth.jwt() ->> 'player_id');

-- Game sessions: read own sessions
CREATE POLICY game_sessions_read_own ON game_sessions
  FOR SELECT USING (player_id::text = auth.jwt() ->> 'player_id');

-- Session moves: read own session moves (via session ownership)
CREATE POLICY session_moves_read_own ON session_moves
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM game_sessions gs
      WHERE gs.id = session_moves.session_id
        AND gs.player_id::text = auth.jwt() ->> 'player_id'
    )
  );

-- Payouts: read own payout records
CREATE POLICY payout_records_read_own ON payout_records
  FOR SELECT USING (player_id::text = auth.jwt() ->> 'player_id');

-- Deny all client writes on sensitive tables (service role only)
CREATE POLICY move_balances_no_client_write ON move_balances
  FOR ALL USING (false) WITH CHECK (false);

CREATE POLICY deposits_no_client_write ON deposits
  FOR INSERT WITH CHECK (false);

CREATE POLICY game_sessions_no_client_write ON game_sessions
  FOR INSERT WITH CHECK (false);

CREATE POLICY session_moves_no_client_write ON session_moves
  FOR INSERT WITH CHECK (false);

CREATE POLICY leaderboard_no_client_write ON leaderboard_entries
  FOR INSERT WITH CHECK (false);

CREATE POLICY processed_events_service_only ON processed_chain_events
  FOR ALL USING (false);

CREATE POLICY auth_nonces_service_only ON auth_nonces
  FOR ALL USING (false);