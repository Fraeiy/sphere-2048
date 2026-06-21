-- Sphere 2048 v2 â€” normalized production schema
-- Auth: Sphere wallet (DID + L1 address). No email/password.

-- Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";

-- â”€â”€â”€ Enums â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

CREATE TYPE deposit_status AS ENUM ('pending', 'confirmed', 'failed', 'reversed');
CREATE TYPE session_status AS ENUM ('active', 'completed', 'abandoned', 'forfeited');
CREATE TYPE leaderboard_period AS ENUM ('global', 'weekly');
CREATE TYPE weekly_round_status AS ENUM ('active', 'settling', 'completed', 'cancelled');
CREATE TYPE payout_status AS ENUM ('pending', 'approved', 'sent', 'failed', 'cancelled');
CREATE TYPE supported_token AS ENUM ('UCT');

-- â”€â”€â”€ Players & Wallets â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

CREATE TABLE players (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  did           CITEXT NOT NULL UNIQUE,
  display_name  CITEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE wallets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id     UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  address       CITEXT NOT NULL,
  chain         TEXT NOT NULL DEFAULT 'unicity-l1',
  is_primary    BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (player_id, address),
  UNIQUE (address)
);

CREATE INDEX idx_wallets_player_id ON wallets(player_id);
CREATE INDEX idx_wallets_address ON wallets(address);

-- â”€â”€â”€ Configurable credit tiers (DB-driven economy) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

CREATE TABLE credit_tiers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_symbol    supported_token NOT NULL DEFAULT 'UCT',
  token_amount    NUMERIC(36, 18) NOT NULL CHECK (token_amount > 0),
  moves_granted   INTEGER NOT NULL CHECK (moves_granted > 0),
  label           TEXT NOT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (token_symbol, token_amount)
);

CREATE INDEX idx_credit_tiers_active ON credit_tiers(is_active, sort_order);

-- â”€â”€â”€ Move balances (backend source of truth) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

CREATE TABLE move_balances (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id           UUID NOT NULL UNIQUE REFERENCES players(id) ON DELETE CASCADE,
  credits_remaining   INTEGER NOT NULL DEFAULT 0 CHECK (credits_remaining >= 0),
  credits_lifetime    INTEGER NOT NULL DEFAULT 0 CHECK (credits_lifetime >= 0),
  version             INTEGER NOT NULL DEFAULT 1,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_move_balances_player ON move_balances(player_id);

-- â”€â”€â”€ Weekly rounds & prize pool â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

CREATE TABLE weekly_rounds (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_number        INTEGER NOT NULL UNIQUE,
  starts_at           TIMESTAMPTZ NOT NULL,
  ends_at             TIMESTAMPTZ NOT NULL,
  status              weekly_round_status NOT NULL DEFAULT 'active',
  prize_pool_atomic   BIGINT NOT NULL DEFAULT 0 CHECK (prize_pool_atomic >= 0),
  settled_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE INDEX idx_weekly_rounds_status ON weekly_rounds(status, ends_at DESC);

-- â”€â”€â”€ Deposits (idempotent via tx_hash) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

CREATE TABLE deposits (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id         UUID NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  wallet_id         UUID NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
  weekly_round_id   UUID REFERENCES weekly_rounds(id) ON DELETE SET NULL,
  credit_tier_id    UUID REFERENCES credit_tiers(id) ON DELETE SET NULL,
  tx_hash           CITEXT NOT NULL UNIQUE,
  token_symbol      supported_token NOT NULL DEFAULT 'UCT',
  amount_atomic     BIGINT NOT NULL CHECK (amount_atomic > 0),
  moves_credited    INTEGER NOT NULL CHECK (moves_credited > 0),
  status            deposit_status NOT NULL DEFAULT 'pending',
  block_time        TIMESTAMPTZ,
  memo              TEXT,
  raw_payload       JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at      TIMESTAMPTZ
);

CREATE INDEX idx_deposits_player ON deposits(player_id, created_at DESC);
CREATE INDEX idx_deposits_status ON deposits(status, created_at DESC);
CREATE INDEX idx_deposits_weekly_round ON deposits(weekly_round_id);

-- â”€â”€â”€ Prize pool ledger â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

CREATE TABLE prize_pool_records (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  weekly_round_id   UUID NOT NULL REFERENCES weekly_rounds(id) ON DELETE CASCADE,
  deposit_id        UUID REFERENCES deposits(id) ON DELETE SET NULL,
  amount_atomic     BIGINT NOT NULL CHECK (amount_atomic > 0),
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_prize_pool_round ON prize_pool_records(weekly_round_id, recorded_at DESC);

-- â”€â”€â”€ Game sessions (auditable) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

CREATE TABLE game_sessions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id           UUID NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  weekly_round_id     UUID REFERENCES weekly_rounds(id) ON DELETE SET NULL,
  status              session_status NOT NULL DEFAULT 'active',
  starting_credits    INTEGER NOT NULL CHECK (starting_credits >= 0),
  ending_credits      INTEGER CHECK (ending_credits IS NULL OR ending_credits >= 0),
  score               INTEGER NOT NULL DEFAULT 0 CHECK (score >= 0),
  highest_tile        INTEGER NOT NULL DEFAULT 0 CHECK (highest_tile >= 0),
  move_count          INTEGER NOT NULL DEFAULT 0 CHECK (move_count >= 0),
  board_state         JSONB NOT NULL,
  move_log_hash       TEXT,
  server_seed         TEXT NOT NULL,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at            TIMESTAMPTZ,
  validated           BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX idx_game_sessions_player ON game_sessions(player_id, started_at DESC);
CREATE INDEX idx_game_sessions_status ON game_sessions(status, started_at DESC);
CREATE INDEX idx_game_sessions_weekly ON game_sessions(weekly_round_id, score DESC);

-- Per-session move audit trail (replay protection + score validation)
CREATE TABLE session_moves (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  move_number     INTEGER NOT NULL CHECK (move_number > 0),
  direction       TEXT NOT NULL CHECK (direction IN ('left', 'right', 'up', 'down')),
  score_after     INTEGER NOT NULL CHECK (score_after >= 0),
  highest_tile_after INTEGER NOT NULL CHECK (highest_tile_after >= 0),
  board_after     JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, move_number)
);

CREATE INDEX idx_session_moves_session ON session_moves(session_id, move_number);

-- â”€â”€â”€ Leaderboard entries â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

CREATE TABLE leaderboard_entries (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id         UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  game_session_id   UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  wallet_address    CITEXT NOT NULL,
  player_did        CITEXT NOT NULL,
  score             INTEGER NOT NULL CHECK (score > 0),
  highest_tile      INTEGER NOT NULL CHECK (highest_tile > 0),
  period_type       leaderboard_period NOT NULL,
  weekly_round_id   UUID REFERENCES weekly_rounds(id) ON DELETE CASCADE,
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (game_session_id, period_type)
);

CREATE INDEX idx_leaderboard_global ON leaderboard_entries(period_type, score DESC, recorded_at DESC)
  WHERE period_type = 'global';
CREATE INDEX idx_leaderboard_weekly ON leaderboard_entries(weekly_round_id, score DESC, recorded_at DESC)
  WHERE period_type = 'weekly';
CREATE INDEX idx_leaderboard_player ON leaderboard_entries(player_id, recorded_at DESC);

-- â”€â”€â”€ Payout records (settlement architecture) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

CREATE TABLE payout_records (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  weekly_round_id   UUID NOT NULL REFERENCES weekly_rounds(id) ON DELETE CASCADE,
  player_id         UUID NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  rank              INTEGER NOT NULL CHECK (rank > 0),
  amount_atomic     BIGINT NOT NULL CHECK (amount_atomic > 0),
  wallet_address    CITEXT NOT NULL,
  status            payout_status NOT NULL DEFAULT 'pending',
  tx_hash           CITEXT UNIQUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at           TIMESTAMPTZ,
  UNIQUE (weekly_round_id, player_id),
  UNIQUE (weekly_round_id, rank)
);

CREATE INDEX idx_payout_records_round ON payout_records(weekly_round_id, status);

-- â”€â”€â”€ Processed chain events (duplicate deposit protection) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

CREATE TABLE processed_chain_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tx_hash       CITEXT NOT NULL UNIQUE,
  event_type    TEXT NOT NULL,
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload       JSONB
);

-- â”€â”€â”€ Auth nonces (replay protection for wallet signatures) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

CREATE TABLE auth_nonces (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address CITEXT NOT NULL,
  nonce         TEXT NOT NULL UNIQUE,
  expires_at    TIMESTAMPTZ NOT NULL,
  consumed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_auth_nonces_wallet ON auth_nonces(wallet_address, expires_at);

-- â”€â”€â”€ Updated_at triggers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_players_updated_at
  BEFORE UPDATE ON players FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_credit_tiers_updated_at
  BEFORE UPDATE ON credit_tiers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- â”€â”€â”€ Helper: get or create active weekly round â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

CREATE OR REPLACE FUNCTION get_active_weekly_round()
RETURNS UUID AS $$
DECLARE
  round_id UUID;
BEGIN
  SELECT id INTO round_id
  FROM weekly_rounds
  WHERE status = 'active'
    AND starts_at <= now()
    AND ends_at > now()
  ORDER BY round_number DESC
  LIMIT 1;

  IF round_id IS NULL THEN
    INSERT INTO weekly_rounds (round_number, starts_at, ends_at)
    VALUES (
      COALESCE((SELECT MAX(round_number) FROM weekly_rounds), 0) + 1,
      date_trunc('week', now()),
      date_trunc('week', now()) + interval '7 days'
    )
    RETURNING id INTO round_id;
  END IF;

  RETURN round_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- â”€â”€â”€ Atomic credit deduction (optimistic locking) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

CREATE OR REPLACE FUNCTION deduct_move_credit(p_player_id UUID)
RETURNS TABLE (
  success BOOLEAN,
  credits_remaining INTEGER,
  new_version INTEGER
) AS $$
DECLARE
  v_row move_balances%ROWTYPE;
  v_remaining INTEGER;
  v_version INTEGER;
BEGIN
  SELECT * INTO v_row FROM move_balances WHERE player_id = p_player_id FOR UPDATE;

  IF NOT FOUND OR v_row.credits_remaining <= 0 THEN
    RETURN QUERY SELECT false, COALESCE(v_row.credits_remaining, 0), COALESCE(v_row.version, 0);
    RETURN;
  END IF;

  UPDATE move_balances
  SET credits_remaining = move_balances.credits_remaining - 1,
      version = move_balances.version + 1,
      updated_at = now()
  WHERE player_id = p_player_id
  RETURNING move_balances.credits_remaining, move_balances.version
  INTO v_remaining, v_version;

  RETURN QUERY SELECT true, v_remaining, v_version;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- â”€â”€â”€ Atomic credit grant on deposit â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

CREATE OR REPLACE FUNCTION credit_moves_from_deposit(
  p_player_id UUID,
  p_moves INTEGER
)
RETURNS move_balances AS $$
DECLARE
  v_balance move_balances%ROWTYPE;
BEGIN
  INSERT INTO move_balances (player_id, credits_remaining, credits_lifetime)
  VALUES (p_player_id, p_moves, p_moves)
  ON CONFLICT (player_id) DO UPDATE
  SET credits_remaining = move_balances.credits_remaining + EXCLUDED.credits_remaining,
      credits_lifetime = move_balances.credits_lifetime + EXCLUDED.credits_lifetime,
      version = move_balances.version + 1,
      updated_at = now()
  RETURNING * INTO v_balance;

  RETURN v_balance;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
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
-- Configurable deposit â†’ move credit tiers
-- token_amount in whole UCT tokens; moves_granted per tier

INSERT INTO credit_tiers (token_symbol, token_amount, moves_granted, label, sort_order) VALUES
  ('UCT', 1,  50,  'Starter â€” 1 UCT',   1),
  ('UCT', 5,  300, 'Standard â€” 5 UCT',  2),
  ('UCT', 10, 700, 'Pro â€” 10 UCT',      3)
ON CONFLICT (token_symbol, token_amount) DO UPDATE
SET moves_granted = EXCLUDED.moves_granted,
    label = EXCLUDED.label,
    is_active = true,
    sort_order = EXCLUDED.sort_order,
    updated_at = now();

-- Bootstrap first weekly round
INSERT INTO weekly_rounds (round_number, starts_at, ends_at, status)
SELECT 1,
       date_trunc('week', now()),
       date_trunc('week', now()) + interval '7 days',
       'active'
WHERE NOT EXISTS (SELECT 1 FROM weekly_rounds);
-- Enable Supabase Realtime for leaderboard live updates
ALTER PUBLICATION supabase_realtime ADD TABLE leaderboard_entries;
