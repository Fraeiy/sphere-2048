import { useState, useCallback, useMemo } from 'react'
import {
  generateSpherePositions,
  computeAdjacency,
  initGame,
  addRandomTile,
  doMove,
  TILE_COUNT
} from '../utils/gameLogic'

const POSITIONS = generateSpherePositions(TILE_COUNT)
const ADJACENCY = computeAdjacency(POSITIONS, 4)

export function useGame() {
  const [gameState, setGameState] = useState(() => initGame())

  const move = useCallback(() => {
    setGameState(prev => {
      if (prev.gameOver) return prev
      const next = doMove(prev, ADJACENCY)
      if (!next.gameOver) {
        addRandomTile(next)
      }
      return next
    })
  }, [])

  const restart = useCallback(() => {
    setGameState(initGame())
  }, [])

  return {
    tiles: gameState.tiles,
    score: gameState.score,
    best: gameState.best,
    gameOver: gameState.gameOver,
    won: gameState.won,
    positions: POSITIONS,
    move,
    restart
  }
}
