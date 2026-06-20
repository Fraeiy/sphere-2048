import type {
  CreditTier,
  GameSession,
  LeaderboardEntry,
  MoveBalance,
  MoveDirection,
  Player,
  WeeklyRound,
  Wallet,
} from './database';

export interface SphereWalletIdentity {
  did: string;
  nametag: string | null;
  l1Address: string;
}

export interface AuthSessionClaims {
  player_id: string;
  did: string;
  wallet_address: string;
  exp: number;
  iat: number;
}

export interface RegisterPlayerRequest {
  did: string;
  nametag?: string;
  wallet_address: string;
}

export interface RegisterPlayerResponse {
  player: Player;
  wallet: Wallet;
  move_balance: MoveBalance;
  access_token: string;
}

export interface StartGameRequest {
  player_id: string;
}

export interface StartGameResponse {
  session: GameSession;
  move_balance: MoveBalance;
}

export interface ExecuteMoveRequest {
  session_id: string;
  direction: MoveDirection;
  idempotency_key: string;
}

export interface ExecuteMoveResponse {
  session: GameSession;
  moved: boolean;
  move_balance: MoveBalance;
  game_over: boolean;
  won: boolean;
}

export interface EndGameRequest {
  session_id: string;
}

export interface EndGameResponse {
  session: GameSession;
  leaderboard_entries: LeaderboardEntry[];
}

export interface ProcessDepositRequest {
  player_id: string;
  wallet_address: string;
  tx_hash: string;
  /** UCT atomic units as string (18 decimals) — avoids JS Number overflow above ~9 UCT */
  amount_atomic: string;
  memo?: string;
  block_time?: string;
}

export interface ProcessDepositResponse {
  deposit_id: string;
  moves_credited: number;
  move_balance: MoveBalance;
  credit_tier: CreditTier | null;
  prize_pool_contribution: string;
}

export interface LeaderboardQuery {
  period: 'global' | 'weekly';
  limit?: number;
  weekly_round_id?: string;
}

export interface LeaderboardResponse {
  entries: LeaderboardEntry[];
  weekly_round: WeeklyRound | null;
}

export interface WeeklyPoolResponse {
  round: WeeklyRound;
  prize_pool_atomic: string | number;
  deposit_count: number;
  top_entries: LeaderboardEntry[];
  pending_payouts: number;
}

export interface ApiError {
  error: string;
  code: string;
  details?: unknown;
}