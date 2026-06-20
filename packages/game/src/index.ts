import type { MoveDirection } from '../../shared/src/types/database';

export const GRID_SIZE = 4;

export type Board = number[][];

export function createEmptyBoard(): Board {
  return Array.from({ length: GRID_SIZE }, () => Array(GRID_SIZE).fill(0));
}

export function cloneBoard(board: Board): Board {
  return board.map((row) => [...row]);
}

export function getEmptyCells(board: Board): [number, number][] {
  const cells: [number, number][] = [];
  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      if (board[r][c] === 0) cells.push([r, c]);
    }
  }
  return cells;
}

export function getHighestTile(board: Board): number {
  return board.reduce((max, row) => Math.max(max, ...row), 0);
}

export function spawnTile(board: Board, rng: () => number = Math.random): boolean {
  const empty = getEmptyCells(board);
  if (empty.length === 0) return false;
  const [r, c] = empty[Math.floor(rng() * empty.length)];
  board[r][c] = rng() < 0.9 ? 2 : 4;
  return true;
}

export function slideLeft(row: number[]): { newRow: number[]; gained: number } {
  const tiles = row.filter((v) => v !== 0);
  let gained = 0;

  for (let i = 0; i < tiles.length - 1; i++) {
    if (tiles[i] === tiles[i + 1]) {
      tiles[i] *= 2;
      gained += tiles[i];
      tiles.splice(i + 1, 1);
    }
  }

  while (tiles.length < GRID_SIZE) tiles.push(0);
  return { newRow: tiles, gained };
}

export function applyMove(
  board: Board,
  direction: MoveDirection,
): { board: Board; score: number; moved: boolean } {
  let grid = cloneBoard(board);
  let totalGained = 0;
  let moved = false;

  const transpose = (g: Board) => g[0].map((_, c) => g.map((row) => row[c]));
  const reverseRows = (g: Board) => g.map((row) => [...row].reverse());

  if (direction === 'right') grid = reverseRows(grid);
  else if (direction === 'up') grid = transpose(grid);
  else if (direction === 'down') {
    grid = transpose(grid);
    grid = reverseRows(grid);
  }

  grid = grid.map((row) => {
    const { newRow, gained } = slideLeft(row);
    totalGained += gained;
    if (newRow.some((v, i) => v !== row[i])) moved = true;
    return newRow;
  });

  if (direction === 'right') grid = reverseRows(grid);
  else if (direction === 'up') grid = transpose(grid);
  else if (direction === 'down') {
    grid = reverseRows(grid);
    grid = transpose(grid);
  }

  return { board: grid, score: totalGained, moved };
}

export function canMove(board: Board): boolean {
  if (getEmptyCells(board).length > 0) return true;
  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      const v = board[r][c];
      if (c + 1 < GRID_SIZE && board[r][c + 1] === v) return true;
      if (r + 1 < GRID_SIZE && board[r + 1][c] === v) return true;
    }
  }
  return false;
}

export function hasWon(board: Board): boolean {
  return board.some((row) => row.includes(2048));
}

export interface GameSnapshot {
  board: Board;
  score: number;
  highest_tile: number;
  game_over: boolean;
  won: boolean;
  move_count: number;
}

export class GameEngine {
  board: Board;
  score = 0;
  gameOver = false;
  won = false;
  moveCount = 0;

  constructor(
    private readonly rng: () => number = Math.random,
    initial?: Partial<GameSnapshot>,
  ) {
    this.board = initial?.board ? cloneBoard(initial.board) : createEmptyBoard();
    this.score = initial?.score ?? 0;
    this.gameOver = initial?.game_over ?? false;
    this.won = initial?.won ?? false;
    this.moveCount = initial?.move_count ?? 0;

    if (!initial?.board) {
      this.spawnStartingTiles();
    }
  }

  private spawnStartingTiles(): void {
    const empty = getEmptyCells(this.board);
    for (let i = 0; i < 2 && i < empty.length; i++) {
      const j = i + Math.floor(this.rng() * (empty.length - i));
      [empty[i], empty[j]] = [empty[j], empty[i]];
      this.board[empty[i][0]][empty[i][1]] = 2;
    }
  }

  move(direction: MoveDirection): boolean {
    if (this.gameOver) return false;

    const { board, score, moved } = applyMove(this.board, direction);
    if (!moved) return false;

    this.board = board;
    this.score += score;
    this.moveCount += 1;
    if (hasWon(board)) this.won = true;

    spawnTile(this.board, this.rng);
    if (!canMove(this.board)) this.gameOver = true;
    return true;
  }

  snapshot(): GameSnapshot {
    return {
      board: cloneBoard(this.board),
      score: this.score,
      highest_tile: getHighestTile(this.board),
      game_over: this.gameOver,
      won: this.won,
      move_count: this.moveCount,
    };
  }
}

/** Seeded RNG for deterministic server-side validation (Mulberry32). */
export function createSeededRng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashBoard(board: Board): string {
  return JSON.stringify(board);
}