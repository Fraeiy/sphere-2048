-- Sphere 2048 v2 — normalized production schema
-- Auth: Sphere wallet (DID + L1 address). No email/password.

-- Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";

-- ─── Enums ───────────────────────────────────────────────────────────────────

CREATE TYPE deposit_status AS ENUM ('pending', 'confirmed', 'failed', 'reversed');
CREATE TYPE session_status AS ENUM ('active', 'completed', 'abandoned', 'forfeited');
CREATE TYPE leaderboard_period AS ENUM ('global', 'weekly');
CREATE TYPE weekly_round_status AS ENUM ('active', 'settling', 'completed', 'cancelled');
CREATE TYPE payout_status AS ENUM ('pending', 'approved', 'sent', 'failed', 'cancelled');
CREATE TYPE supported_token AS ENUM ('UCT');

-- ─── Players & Wallets ───────────────────────────────────────────────────────

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

-- ─── Configurable credit tiers (DB-driven economy) ───────────────────────────

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

-- ─── Move balances (backend source of truth) ─────────────────────────────────

CREATE TABLE move_balances (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id           UUID NOT NULL UNIQUE REFERENCES players(id) ON DELETE CASCADE,
  credits_remaining   INTEGER NOT NULL DEFAULT 0 CHECK (credits_remaining >= 0),
  credits_lifetime    INTEGER NOT NULL DEFAULT 0 CHECK (credits_lifetime >= 0),
  version             INTEGER NOT NULL DEFAULT 1,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_move_balances_player ON move_balances(player_id);

-- ─── Weekly rounds & prize pool ──────────────────────────────────────────────

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

-- ─── Deposits (idempotent via tx_hash) ───────────────────────────────────────

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

-- ─── Prize pool ledger ───────────────────────────────────────────────────────

CREATE TABLE prize_pool_records (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  weekly_round_id   UUID NOT NULL REFERENCES weekly_rounds(id) ON DELETE CASCADE,
  deposit_id        UUID REFERENCES deposits(id) ON DELETE SET NULL,
  amount_atomic     BIGINT NOT NULL CHECK (amount_atomic > 0),
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_prize_pool_round ON prize_pool_records(weekly_round_id, recorded_at DESC);

-- ─── Game sessions (auditable) ───────────────────────────────────────────────

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

-- ─── Leaderboard entries ───────────────────────────────────────────────────────

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

-- ─── Payout records (settlement architecture) ────────────────────────────────

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

-- ─── Processed chain events (duplicate deposit protection) ───────────────────

CREATE TABLE processed_chain_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tx_hash       CITEXT NOT NULL UNIQUE,
  event_type    TEXT NOT NULL,
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload       JSONB
);

-- ─── Auth nonces (replay protection for wallet signatures) ───────────────────

CREATE TABLE auth_nonces (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address CITEXT NOT NULL,
  nonce         TEXT NOT NULL UNIQUE,
  expires_at    TIMESTAMPTZ NOT NULL,
  consumed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_auth_nonces_wallet ON auth_nonces(wallet_address, expires_at);

-- ─── Updated_at triggers ─────────────────────────────────────────────────────

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

-- ─── Helper: get or create active weekly round ───────────────────────────────

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

-- ─── Atomic credit deduction (optimistic locking) ────────────────────────────

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

-- ─── Atomic credit grant on deposit ────────────────────────────────────────────

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