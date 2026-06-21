import { create } from 'zustand';
import type { GameSession } from '@sphere-2048/shared';

interface GameState {
  session: GameSession | null;
  setSession: (session: GameSession | null) => void;
}

export const useGameStore = create<GameState>((set) => ({
  session: null,
  setSession: (session) => set({ session }),
}));