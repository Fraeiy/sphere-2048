import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Board } from '@sphere-2048/game';
import {
  applyMove,
  canMove,
  createSeededRng,
  getHighestTile,
  hasWon,
  spawnTile,
} from '@sphere-2048/game';
import type { GameSession } from '@sphere-2048/shared';
import { GameBoard } from '@/components/game/GameBoard';
import { ScoreBox } from '@/components/game/ScoreBox';
import { Button } from '@/components/ui/Button';
import { useAuthReady } from '@/hooks/useAuthReady';
import { useTimedError } from '@/hooks/useTimedError';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import { useGameStore } from '@/stores/gameStore';

type MoveDirection = 'left' | 'right' | 'up' | 'down';

function predictNextState(session: GameSession, direction: MoveDirection) {
  const board = session.board_state as Board;
  const { board: nextBoard, score: gained, moved } = applyMove(board, direction);
  if (!moved) return null;

  const seedNum = [...session.server_seed].reduce((a, c) => a + c.charCodeAt(0), 0);
  const rng = createSeededRng(seedNum + session.move_count + 1);
  spawnTile(nextBoard, rng);

  const newScore = session.score + gained;
  const gameOver = !canMove(nextBoard);

  return {
    board_state: nextBoard,
    score: newScore,
    highest_tile: getHighestTile(nextBoard),
    move_count: session.move_count + 1,
    status: gameOver ? 'completed' as const : session.status,
    ended_at: gameOver ? new Date().toISOString() : session.ended_at,
    game_over: gameOver,
    won: hasWon(nextBoard),
  };
}

export function GamePage() {
  const navigate = useNavigate();
  const authReady = useAuthReady();
  const { accessToken, moveBalance, setMoveBalance, player, setPlayerBestScore, isAuthenticated } = useAuthStore();
  const { session, setSession } = useGameStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useTimedError();
  const [best, setBest] = useState(player?.best_score ?? 0);
  const startingRef = useRef(false);
  const bestRef = useRef(best);
  const sessionRef = useRef(session);
  const accessTokenRef = useRef(accessToken);
  const moveQueueRef = useRef<MoveDirection[]>([]);
  const drainingRef = useRef(false);

  useEffect(() => {
    bestRef.current = best;
  }, [best]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    accessTokenRef.current = accessToken;
  }, [accessToken]);

  useEffect(() => {
    if (player?.best_score != null) {
      setBest((prev) => Math.max(prev, player.best_score));
    }
  }, [player?.best_score]);

  useEffect(() => {
    if (!authReady) return;
    if (!isAuthenticated()) navigate('/connect');
    else if ((moveBalance?.credits_remaining ?? 0) <= 0) navigate('/deposit');
  }, [authReady, isAuthenticated, moveBalance, navigate]);

  const applyBestScore = useCallback((score: number) => {
    if (score > bestRef.current) {
      bestRef.current = score;
      setBest(score);
      setPlayerBestScore(score);
    }
  }, [setPlayerBestScore]);

  const drainMoveQueue = useCallback(async () => {
    if (drainingRef.current) return;
    drainingRef.current = true;

    let lastGoodSession = sessionRef.current;

    try {
      while (moveQueueRef.current.length > 0) {
        const token = accessTokenRef.current;
        const sess = sessionRef.current;
        if (!token || !sess || sess.status === 'completed') {
          moveQueueRef.current = [];
          break;
        }

        const direction = moveQueueRef.current[0];

        try {
          const result = await api.executeMove(token, {
            session_id: sess.id,
            direction,
            idempotency_key: crypto.randomUUID(),
          });

          moveQueueRef.current.shift();

          if (!result.moved) {
            moveQueueRef.current = [];
            lastGoodSession = result.session;
            break;
          }

          lastGoodSession = result.session;
          setMoveBalance(result.move_balance);
          applyBestScore(result.best_score);
        } catch (err) {
          moveQueueRef.current = [];
          setError(err instanceof Error ? err.message : 'Move failed');
          break;
        }
      }

      if (lastGoodSession) {
        sessionRef.current = lastGoodSession;
        setSession(lastGoodSession);
      }
    } finally {
      drainingRef.current = false;
      if (moveQueueRef.current.length > 0) {
        void drainMoveQueue();
      }
    }
  }, [setSession, setMoveBalance, applyBestScore, setError]);

  const waitForMoveQueue = useCallback(async () => {
    while (drainingRef.current || moveQueueRef.current.length > 0) {
      await new Promise((r) => setTimeout(r, 32));
    }
  }, []);

  const startGame = useCallback(async (forceNew = false) => {
    if (!accessToken || startingRef.current) return;
    startingRef.current = true;
    setBusy(true);
    setError('');
    try {
      if (forceNew) {
        moveQueueRef.current = [];
        await waitForMoveQueue();
      }
      const result = await api.startGame(accessToken, { forceNew });
      sessionRef.current = result.session;
      setSession(result.session);
      setMoveBalance(result.move_balance);
      applyBestScore(result.best_score);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start game');
    } finally {
      setBusy(false);
      startingRef.current = false;
    }
  }, [accessToken, setSession, setMoveBalance, applyBestScore, setError, waitForMoveQueue]);

  useEffect(() => {
    if (!authReady || !accessToken || session) return;
    startGame();
  }, [authReady, accessToken, session, startGame]);

  const handleMove = useCallback((direction: MoveDirection) => {
    const sess = sessionRef.current;
    if (!accessTokenRef.current || !sess || sess.status === 'completed') return;

    const predicted = predictNextState(sess, direction);
    if (!predicted) return;

    const nextSession = { ...sess, ...predicted };
    sessionRef.current = nextSession;
    setSession(nextSession);
    if (predicted.score > bestRef.current) applyBestScore(predicted.score);

    moveQueueRef.current.push(direction);
    void drainMoveQueue();
  }, [setSession, applyBestScore, drainMoveQueue]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const map: Record<string, MoveDirection> = {
        ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
      };
      if (map[e.key]) { e.preventDefault(); handleMove(map[e.key]); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleMove]);

  if (!authReady || !session) {
    return (
      <p className="text-center text-sm text-ink-soft">
        {error || 'Starting game…'}
      </p>
    );
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

      {error && (
        <p className="w-full rounded-lg bg-red-100 px-3 py-2 text-center text-sm text-red-800">{error}</p>
      )}

      <GameBoard board={session.board_state as Board} onMove={handleMove} disabled={busy} />

      <p className="text-center text-xs font-semibold text-ink-soft/70">
        <span className="hidden md:inline">Use arrow keys or drag on the board</span>
        <span className="md:hidden">Swipe on the board to move</span>
      </p>

      {session.status === 'completed' && (
        <div className="w-full rounded-lg border border-[#f3d5b0] bg-[#fff8ef] p-4 text-center">
          <h3 className="text-xl font-bold text-ink">Game Over</h3>
          <p className="text-sm text-ink-soft">Final score: {session.score}</p>
          <Button className="mt-3" onClick={() => void startGame(true)} disabled={busy}>New Game</Button>
        </div>
      )}
    </section>
  );
}