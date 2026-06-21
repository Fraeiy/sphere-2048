import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { MoveBalance, Player, Wallet } from '@sphere-2048/shared';

interface AuthState {
  accessToken: string | null;
  player: Player | null;
  wallet: Wallet | null;
  moveBalance: MoveBalance | null;
  setSession: (data: {
    accessToken: string;
    player: Player;
    wallet: Wallet;
    moveBalance: MoveBalance;
  }) => void;
  setMoveBalance: (balance: MoveBalance) => void;
  setPlayerBestScore: (score: number) => void;
  clearSession: () => void;
  isAuthenticated: () => boolean;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      accessToken: null,
      player: null,
      wallet: null,
      moveBalance: null,
      setSession: ({ accessToken, player, wallet, moveBalance }) =>
        set({ accessToken, player, wallet, moveBalance }),
      setMoveBalance: (moveBalance) => set({ moveBalance }),
      setPlayerBestScore: (score) =>
        set((state) => ({
          player: state.player && score > state.player.best_score
            ? { ...state.player, best_score: score }
            : state.player,
        })),
      clearSession: () => set({ accessToken: null, player: null, wallet: null, moveBalance: null }),
      isAuthenticated: () => Boolean(get().accessToken && get().player),
    }),
    { name: 'sphere2048-auth' },
  ),
);