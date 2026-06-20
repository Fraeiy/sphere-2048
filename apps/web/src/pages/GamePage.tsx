import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Board } from '@sphere-2048/game';
import { GameBoard } from '@/components/game/GameBoard';
import { ScoreBox } from '@/components/game/ScoreBox';
import { Button } from '@/components/ui/Button';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import { useGameStore } from '@/stores/gameStore';

export function GamePage() {
  const navigate = useNavigate();
  const { accessToken, moveBalance, setMoveBalance, isAuthenticated } = useAuthStore();
  const { session, setSession } = useGameStore();
  const [busy, setBusy] = useState(false);
  const [best, setBest] = useState(0);

  useEffect(() => {
    if (!isAuthenticated()) navigate('/connect');
    else if ((moveBalance?.credits_remaining ?? 0) <= 0) navigate('/deposit');
  }, [isAuthenticated, moveBalance, navigate]);

  const startGame = useCallback(async () => {
    if (!accessToken) return;
    setBusy(true);
    try {
      const result = await api.startGame(accessToken);
      setSession(result.session);
      setMoveBalance(result.move_balance);
    } finally {
      setBusy(false);
    }
  }, [accessToken, setSession, setMoveBalance]);

  useEffect(() => {
    if (!session && accessToken) startGame();
  }, [session, accessToken, startGame]);

  const handleMove = useCallback(async (direction: 'left' | 'right' | 'up' | 'down') => {
    if (!accessToken || !session || busy) return;
    setBusy(true);
    try {
      const result = await api.executeMove(accessToken, {
        session_id: session.id,
        direction,
        idempotency_key: crypto.randomUUID(),
      });
      setSession(result.session);
      setMoveBalance(result.move_balance);
      if (result.session.score > best) setBest(result.session.score);
    } finally {
      setBusy(false);
    }
  }, [accessToken, session, busy, setSession, setMoveBalance, best]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const map: Record<string, 'left' | 'right' | 'up' | 'down'> = {
        ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
      };
      if (map[e.key]) { e.preventDefault(); handleMove(map[e.key]); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleMove]);

  if (!session) {
    return <p className="text-center text-sm">Starting game…</p>;
  }

  return (
    <section className="flex flex-col items-center gap-4">
      <div className="flex w-full items-center justify-between">
        <div>
          <h1 className="text-4xl font-black text-ink">20<span className="text-orange-600">48</span></h1>
          <p className="text-xs text-ink-soft">Moves left: {moveBalance?.credits_remaining ?? 0}</p>
        </div>
        <div className="flex gap-2">
          <ScoreBox label="SCORE" value={session.score} />
          <ScoreBox label="BEST" value={best} />
        </div>
      </div>

      <GameBoard board={session.board_state as Board} onMove={handleMove} disabled={busy} />

      <p className="text-center text-xs font-semibold text-ink-soft/70">
        <span className="hidden md:inline">Use arrow keys or drag on the board</span>
        <span className="md:hidden">Swipe on the board to move</span>
      </p>

      {session.status === 'completed' && (
        <div className="w-full rounded-lg border border-[#f3d5b0] bg-[#fff8ef] p-4 text-center">
          <h3 className="text-xl font-bold text-ink">Game Over</h3>
          <p className="text-sm text-ink-soft">Final score: {session.score}</p>
          <Button className="mt-3" onClick={startGame} disabled={busy}>Play Again</Button>
        </div>
      )}
    </section>
  );
}