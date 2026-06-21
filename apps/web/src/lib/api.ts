import type {
  EndGameResponse,
  ExecuteMoveRequest,
  ExecuteMoveResponse,
  GetMoveBalanceResponse,
  LeaderboardResponse,
  ProcessDepositRequest,
  ProcessDepositResponse,
  RegisterPlayerResponse,
  StartGameResponse,
  WeeklyPoolResponse,
} from '@sphere-2048/shared';

const FUNCTIONS_BASE = import.meta.env.VITE_SUPABASE_FUNCTIONS_URL
  ?? `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

async function edgeFetch<T>(
  path: string,
  options: RequestInit & { token?: string } = {},
): Promise<T> {
  const { token, ...init } = options;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string>),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${FUNCTIONS_BASE}/${path}`, { ...init, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error ?? body.message ?? `API error ${res.status}`);
  }
  return body as T;
}

export const api = {
  registerPlayer: (payload: { did: string; nametag?: string; wallet_address: string }) =>
    edgeFetch<RegisterPlayerResponse>('register-player', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  getMoveBalance: (token: string) =>
    edgeFetch<GetMoveBalanceResponse>('get-move-balance', { method: 'GET', token }),

  startGame: (() => {
    let inflight: Promise<StartGameResponse> | null = null;
    let inflightToken: string | null = null;
    return (token: string, options?: { forceNew?: boolean }) => {
      const forceNew = options?.forceNew ?? false;
      if (!forceNew && inflight && inflightToken === token) return inflight;
      const request = edgeFetch<StartGameResponse>('start-game', {
        method: 'POST',
        body: JSON.stringify({ force_new: forceNew }),
        token,
      });
      if (!forceNew) {
        inflightToken = token;
        inflight = request.finally(() => { inflight = null; inflightToken = null; });
        return inflight;
      }
      return request;
    };
  })(),

  executeMove: (token: string, payload: ExecuteMoveRequest) =>
    edgeFetch<ExecuteMoveResponse>('execute-move', {
      method: 'POST',
      body: JSON.stringify(payload),
      token,
      headers: { 'x-idempotency-key': payload.idempotency_key },
    }),

  processDeposit: (token: string, payload: ProcessDepositRequest) =>
    edgeFetch<ProcessDepositResponse>('process-deposit', {
      method: 'POST',
      body: JSON.stringify(payload),
      token,
    }),

  getLeaderboard: (period: 'global' | 'weekly', limit = 50) =>
    edgeFetch<LeaderboardResponse>(`get-leaderboard?period=${period}&limit=${limit}`),

  getWeeklyPool: () => edgeFetch<WeeklyPoolResponse>('get-weekly-pool'),

  endGame: (token: string, sessionId: string) =>
    edgeFetch<EndGameResponse>('end-game', {
      method: 'POST',
      body: JSON.stringify({ session_id: sessionId }),
      token,
    }),
};