export type DepositStatus = 'pending' | 'confirmed' | 'failed' | 'reversed';
export type SessionStatus = 'active' | 'completed' | 'abandoned' | 'forfeited';
export type LeaderboardPeriod = 'global' | 'weekly';
export type WeeklyRoundStatus = 'active' | 'settling' | 'completed' | 'cancelled';
export type PayoutStatus = 'pending' | 'approved' | 'sent' | 'failed' | 'cancelled';
export type SupportedToken = 'UCT';
export type MoveDirection = 'left' | 'right' | 'up' | 'down';

export interface Player {
  id: string;
  did: string;
  display_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface Wallet {
  id: string;
  player_id: string;
  address: string;
  chain: string;
  is_primary: boolean;
  created_at: string;
}

export interface CreditTier {
  id: string;
  token_symbol: SupportedToken;
  token_amount: string;
  moves_granted: number;
  label: string;
  is_active: boolean;
  sort_order: number;
}

export interface MoveBalance {
  id: string;
  player_id: string;
  credits_remaining: number;
  credits_lifetime: number;
  version: number;
  updated_at: string;
}

export interface Deposit {
  id: string;
  player_id: string;
  wallet_id: string;
  weekly_round_id: string | null;
  credit_tier_id: string | null;
  tx_hash: string;
  token_symbol: SupportedToken;
  amount_atomic: number;
  moves_credited: number;
  status: DepositStatus;
  block_time: string | null;
  memo: string | null;
  created_at: string;
  confirmed_at: string | null;
}

export interface GameSession {
  id: string;
  player_id: string;
  weekly_round_id: string | null;
  status: SessionStatus;
  starting_credits: number;
  ending_credits: number | null;
  score: number;
  highest_tile: number;
  move_count: number;
  board_state: number[][];
  server_seed: string;
  started_at: string;
  ended_at: string | null;
  validated: boolean;
}

export interface SessionMove {
  id: string;
  session_id: string;
  move_number: number;
  direction: MoveDirection;
  score_after: number;
  highest_tile_after: number;
  board_after: number[][];
  created_at: string;
}

export interface LeaderboardEntry {
  id: string;
  player_id: string;
  game_session_id: string;
  wallet_address: string;
  player_did: string;
  score: number;
  highest_tile: number;
  period_type: LeaderboardPeriod;
  weekly_round_id: string | null;
  recorded_at: string;
}

export interface WeeklyRound {
  id: string;
  round_number: number;
  starts_at: string;
  ends_at: string;
  status: WeeklyRoundStatus;
  prize_pool_atomic: number;
  settled_at: string | null;
}

export interface PrizePoolRecord {
  id: string;
  weekly_round_id: string;
  deposit_id: string | null;
  amount_atomic: number;
  recorded_at: string;
}

export interface PayoutRecord {
  id: string;
  weekly_round_id: string;
  player_id: string;
  rank: number;
  amount_atomic: number;
  wallet_address: string;
  status: PayoutStatus;
  tx_hash: string | null;
  created_at: string;
  sent_at: string | null;
}