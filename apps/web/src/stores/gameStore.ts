import { create } from 'zustand';
import type { GameSession } from '@sphere-2048/shared';

interface GameState {
  session: GameSession | null;
  setSession: (session: GameSession | null) => void;
  updateSession: (partial: Partial<GameSession>) => void;
}

export const useGameStore = create<GameState>((set) => ({
  session: null,
  setSession: (session) => set({ session }),
  updateSession: (partial) =>
    set((state) => ({
      session: state.session ? { ...state.session, ...partial } : null,
    })),
}));