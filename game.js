/**
 * game.js — Core 2048 Game Logic
 *
 * Manages the board state, tile spawning, directional moves,
 * merging logic, score tracking, and game-over detection.
 * All functions are pure (no side effects) except the GameState class.
 */

// ─── Constants ───────────────────────────────────────────────────────────────

/** Size of the board (4×4 grid). */
export const GRID_SIZE = 4;

// ─── Board Helpers ────────────────────────────────────────────────────────────

/**
 * Creates a new empty 4×4 board filled with zeros.
 * Zero means an empty cell.
 */
export function createEmptyBoard() {
  return Array.from({ length: GRID_SIZE }, () => Array(GRID_SIZE).fill(0));
}

/**
 * Deep-clones a board (2D array).
 * @param {number[][]} board
 * @returns {number[][]}
 */
export function cloneBoard(board) {
  return board.map(row => [...row]);
}

/**
 * Returns all coordinates of empty cells as [row, col] pairs.
 * @param {number[][]} board
 * @returns {[number, number][]}
 */
export function getEmptyCells(board) {
  const cells = [];
  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      if (board[r][c] === 0) cells.push([r, c]);
    }
  }
  return cells;
}

/**
 * Spawns a new tile (2 with 90% probability, 4 with 10%) in a random empty cell.
 * Mutates the board in place.
 * @param {number[][]} board
 * @returns {boolean} false if no empty cell was found
 */
export function spawnTile(board) {
  const empty = getEmptyCells(board);
  if (empty.length === 0) return false;
  const [r, c] = empty[Math.floor(Math.random() * empty.length)];
  board[r][c] = Math.random() < 0.9 ? 2 : 4;
  return true;
}

// ─── Move Logic ───────────────────────────────────────────────────────────────

/**
 * Slides and merges a single row to the left.
 * Returns the new row and the points gained from merges.
 *
 * Algorithm:
 *   1. Compact all non-zero tiles to the left.
 *   2. Merge adjacent equal tiles (each pair merges only once).
 *   3. Compact again to fill the gap left by the merge.
 *
 * @param {number[]} row
 * @returns {{ newRow: number[], gained: number }}
 */
export function slideLeft(row) {
  // Step 1: remove zeros
  let tiles = row.filter(v => v !== 0);
  let gained = 0;

  // Step 2: merge adjacent equals (left-to-right, one merge per tile)
  for (let i = 0; i < tiles.length - 1; i++) {
    if (tiles[i] === tiles[i + 1]) {
      tiles[i] *= 2;           // double the left tile
      gained += tiles[i];      // score the merged value
      tiles.splice(i + 1, 1); // remove the right tile
    }
  }

  // Step 3: pad with zeros on the right to restore row length
  while (tiles.length < GRID_SIZE) tiles.push(0);

  return { newRow: tiles, gained };
}

/**
 * Applies a move in the given direction to the entire board.
 * Internally rotates the board so that all moves reuse the left-slide logic.
 *
 * Rotation map:
 *   left  → slide rows left as-is
 *   right → reverse each row, slide left, reverse back
 *   up    → transpose, slide left, transpose back
 *   down  → transpose, reverse rows, slide left, reverse back, transpose back
 *
 * @param {number[][]} board
 * @param {'left'|'right'|'up'|'down'} direction
 * @returns {{ board: number[][], score: number, moved: boolean }}
 */
export function applyMove(board, direction) {
  let grid = cloneBoard(board);
  let totalGained = 0;
  let moved = false;

  // ── Helpers ──────────────────────────────────────────────────────────────
  const transpose = g =>
    g[0].map((_, c) => g.map(row => row[c]));

  const reverseRows = g =>
    g.map(row => [...row].reverse());

  // ── Transform to "left-slide" space ──────────────────────────────────────
  if (direction === 'right') {
    grid = reverseRows(grid);
  } else if (direction === 'up') {
    grid = transpose(grid);
  } else if (direction === 'down') {
    grid = transpose(grid);
    grid = reverseRows(grid);
  }

  // ── Slide every row to the left ───────────────────────────────────────────
  grid = grid.map(row => {
    const { newRow, gained } = slideLeft(row);
    totalGained += gained;
    // Detect movement: if new row differs from original, the board moved
    if (newRow.some((v, i) => v !== row[i])) moved = true;
    return newRow;
  });

  // ── Reverse transform back to original orientation ────────────────────────
  if (direction === 'right') {
    grid = reverseRows(grid);
  } else if (direction === 'up') {
    grid = transpose(grid);
  } else if (direction === 'down') {
    grid = reverseRows(grid);
    grid = transpose(grid);
  }

  return { board: grid, score: totalGained, moved };
}

// ─── Game-Over Detection ──────────────────────────────────────────────────────

/**
 * Returns true if the board has at least one empty cell or one possible merge.
 * @param {number[][]} board
 * @returns {boolean} true → game is still playable
 */
export function canMove(board) {
  // Any empty cell means a move is still possible
  if (getEmptyCells(board).length > 0) return true;

  // Check horizontal and vertical adjacency for mergeable pairs
  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      const v = board[r][c];
      if (c + 1 < GRID_SIZE && board[r][c + 1] === v) return true;  // right neighbor
      if (r + 1 < GRID_SIZE && board[r + 1][c] === v) return true;  // bottom neighbor
    }
  }
  return false;
}

/**
 * Returns true if any tile on the board equals 2048.
 * @param {number[][]} board
 * @returns {boolean}
 */
export function hasWon(board) {
  return board.some(row => row.includes(2048));
}

// ─── GameState Class ──────────────────────────────────────────────────────────

/**
 * GameState encapsulates the full game session:
 *   - board:    current 4×4 grid
 *   - score:    points earned this game
 *   - best:     highest score across all games (persisted in memory for now)
 *   - gameOver: true when no moves remain
 *   - won:      true once a 2048 tile is reached (player may continue)
 */
export class GameState {
  constructor(bestScore = 0) {
    this.board    = createEmptyBoard();
    this.score    = 0;
    this.best     = bestScore;
    this.gameOver = false;
    this.won      = false;

    // Spawn two starting tiles
    spawnTile(this.board);
    spawnTile(this.board);
  }

  /**
   * Attempts to move tiles in the given direction.
   * Spawns a new tile only when the board actually changed.
   *
   * @param {'left'|'right'|'up'|'down'} direction
   * @returns {boolean} true if the board changed
   */
  move(direction) {
    if (this.gameOver) return false;

    const { board, score, moved } = applyMove(this.board, direction);
    if (!moved) return false;

    this.board  = board;
    this.score += score;
    if (this.score > this.best) this.best = this.score;

    if (hasWon(board)) this.won = true;

    spawnTile(this.board);

    if (!canMove(this.board)) this.gameOver = true;

    return true;
  }

  /**
   * Serialises the state for JSON transfer to the frontend.
   * @returns {object}
   */
  toJSON() {
    return {
      board:    this.board,
      score:    this.score,
      best:     this.best,
      gameOver: this.gameOver,
      won:      this.won,
    };
  }
}
