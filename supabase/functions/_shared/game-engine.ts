/** Deno-compatible copy of core game logic for server-side move validation. */

export type MoveDirection = 'left' | 'right' | 'up' | 'down';
export type Board = number[][];
const GRID_SIZE = 4;

export function cloneBoard(board: Board): Board {
  return board.map((row) => [...row]);
}

function getEmptyCells(board: Board): [number, number][] {
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

function slideLeft(row: number[]): { newRow: number[]; gained: number } {
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

export function applyMove(board: Board, direction: MoveDirection) {
  let grid = cloneBoard(board);
  let totalGained = 0;
  let moved = false;
  const transpose = (g: Board) => g[0].map((_, c) => g.map((row) => row[c]));
  const reverseRows = (g: Board) => g.map((row) => [...row].reverse());

  if (direction === 'right') grid = reverseRows(grid);
  else if (direction === 'up') grid = transpose(grid);
  else if (direction === 'down') { grid = transpose(grid); grid = reverseRows(grid); }

  grid = grid.map((row) => {
    const { newRow, gained } = slideLeft(row);
    totalGained += gained;
    if (newRow.some((v, i) => v !== row[i])) moved = true;
    return newRow;
  });

  if (direction === 'right') grid = reverseRows(grid);
  else if (direction === 'up') grid = transpose(grid);
  else if (direction === 'down') { grid = reverseRows(grid); grid = transpose(grid); }

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

export function spawnTile(board: Board, rng: () => number): boolean {
  const empty = getEmptyCells(board);
  if (!empty.length) return false;
  const [r, c] = empty[Math.floor(rng() * empty.length)];
  board[r][c] = rng() < 0.9 ? 2 : 4;
  return true;
}

export function createSeededRng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export function createInitialBoard(rng: () => number): Board {
  const board: Board = Array.from({ length: GRID_SIZE }, () => Array(GRID_SIZE).fill(0));
  const empty = getEmptyCells(board);
  for (let i = 0; i < 2 && i < empty.length; i++) {
    const j = i + Math.floor(rng() * (empty.length - i));
    [empty[i], empty[j]] = [empty[j], empty[i]];
    board[empty[i][0]][empty[i][1]] = 2;
  }
  return board;
}

/** Replay a move sequence to validate client-claimed score. */
export function validateMoveSequence(
  serverSeed: string,
  moves: { direction: MoveDirection; move_number: number }[],
): { valid: boolean; finalScore: number; finalBoard: Board; highestTile: number } {
  const seedNum = [...serverSeed].reduce((a, c) => a + c.charCodeAt(0), 0);
  const rng = createSeededRng(seedNum);
  let board = createInitialBoard(rng);
  let score = 0;

  const sorted = [...moves].sort((a, b) => a.move_number - b.move_number);
  for (const move of sorted) {
    const { board: next, score: gained, moved } = applyMove(board, move.direction);
    if (!moved) return { valid: false, finalScore: score, finalBoard: board, highestTile: getHighestTile(board) };
    board = next;
    score += gained;
    spawnTile(board, rng);
  }

  return { valid: true, finalScore: score, finalBoard: board, highestTile: getHighestTile(board) };
}