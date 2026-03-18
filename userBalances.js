/**
 * userBalances.js — User Balance & Deposit Tracking
 *
 * Maintains in-memory user balances with the following structure:
 * {
 *   userId: {
 *     walletId: string,              // wallet address or nametag
 *     balance: number,               // current UTC balance (in smallest units)
 *     totalDeposited: number,        // lifetime deposits
 *     movesLeft: number,             // current moves available
 *     totalMoves: number,            // lifetime moves
 *     lastMove: timestamp,
 *     highScore: number,
 *     createdAt: timestamp
 *   }
 * }
 */

const MOVE_COST_UTC = 0.1; // Effective cost per move (0.1 UCT)
const MOVE_COST_ATOMIC = Math.round(MOVE_COST_UTC * 1e18); // 0.1 UCT in atomic units
const BILLING_CHUNK_MOVES = 10; // Charge once every 10 moves
const BILLING_CHUNK_ATOMIC = Math.round(BILLING_CHUNK_MOVES * MOVE_COST_ATOMIC); // 1 UCT in atomic units

/**
 * In-memory user balance store
 * @type {Map<string, object>}
 */
const userBalances = new Map();

/**
 * Create or update a user balance record
 * @param {string} userId - Unique identifier (wallet address or nametag)
 * @param {string} walletId - Wallet identifier for reference
 * @returns {object} Updated user balance record
 */
export function initializeUser(userId, walletId) {
  if (!userBalances.has(userId)) {
    userBalances.set(userId, {
      walletId,
      balance: 0,
      totalDeposited: 0,
      movesLeft: 0,
      pendingMovesInBatch: 0,
      totalMoves: 0,
      lastMove: null,
      highScore: 0,
      createdAt: Date.now(),
    });
  }
  return userBalances.get(userId);
}

/**
 * Add a deposit to a user's account
 * @param {string} userId - User identifier
 * @param {number} amount - Amount in atomic units (18 decimals for UCT)
 * @returns {object} Updated user record
 */
export function addDeposit(userId, amount) {
  const user = userBalances.get(userId);
  if (!user) {
    throw new Error(`User ${userId} not found`);
  }

  user.balance += amount;
  user.totalDeposited += amount;
  
  // Calculate moves from amount (0.1 UCT per move = MOVE_COST_ATOMIC)
  const newMoves = Math.floor(amount / MOVE_COST_ATOMIC);
  user.movesLeft += newMoves;

  console.log(`[Balance] Deposit: ${userId} +${amount} (${newMoves} moves)`);
  return user;
}

/**
 * Deduct move cost from user balance
 * @param {string} userId - User identifier
 * @returns {boolean} true if deduction successful, false if insufficient balance
 */
export function deductMove(userId) {
  const user = userBalances.get(userId);
  if (!user) {
    throw new Error(`User ${userId} not found`);
  }

  if (user.movesLeft <= 0) {
    return false; // No move credits left
  }

  user.movesLeft -= 1;
  user.totalMoves += 1;
  user.pendingMovesInBatch = (user.pendingMovesInBatch || 0) + 1;
  user.lastMove = Date.now();

  // Bill 1 UCT after every 10 successful moves.
  if (user.pendingMovesInBatch >= BILLING_CHUNK_MOVES) {
    if (user.balance < BILLING_CHUNK_ATOMIC) {
      // Safety guard: this should not happen if movesLeft is consistent.
      user.pendingMovesInBatch = BILLING_CHUNK_MOVES;
      user.movesLeft += 1;
      user.totalMoves -= 1;
      return false;
    }
    user.balance -= BILLING_CHUNK_ATOMIC;
    user.pendingMovesInBatch = 0;
  }

  // Final settlement: if all move credits are used, clear any remaining
  // partial batch so the displayed balance cannot stay non-zero.
  if (user.movesLeft === 0 && user.pendingMovesInBatch > 0) {
    const remainingCharge = user.pendingMovesInBatch * MOVE_COST_ATOMIC;
    user.balance = Math.max(0, user.balance - remainingCharge);
    user.pendingMovesInBatch = 0;
  }

  return true;
}

/**
 * Get user balance info
 * @param {string} userId - User identifier
 * @returns {object|null} User balance record or null if not found
 */
export function getBalance(userId) {
  return userBalances.get(userId) || null;
}

/**
 * Check if user has enough balance for a move
 * @param {string} userId - User identifier
 * @returns {boolean} true if user has sufficient balance
 */
export function canMove(userId) {
  const user = userBalances.get(userId);
  const hasBalance = !!user && user.movesLeft > 0;
  console.log(`[Balance] canMove(${userId}): user=${!!user}, movesLeft=${user?.movesLeft ?? 'N/A'}, pendingBatch=${user?.pendingMovesInBatch ?? 'N/A'}, can=${hasBalance}`);
  if (!user) {
    console.log(`[Balance] User not found in map. Keys: ${Array.from(userBalances.keys()).join(', ')}`);
  }
  return hasBalance;
}

/**
 * Update user high score
 * @param {string} userId - User identifier
 * @param {number} score - New score
 */
export function updateHighScore(userId, score) {
  const user = userBalances.get(userId);
  if (!user) return;

  if (score > user.highScore) {
    user.highScore = score;
    console.log(`[Balance] High score update: ${userId} → ${score}`);
  }
}

/**
 * Get all registered users (for leaderboard, etc.)
 * @returns {object[]} Array of user records
 */
export function getAllUsers() {
  return Array.from(userBalances.values());
}

/**
 * Get top users by high score
 * @param {number} limit - Number of users to return
 * @returns {object[]} Array of top users sorted by high score
 */
export function getLeaderboard(limit = 10) {
  return Array.from(userBalances.values())
    .sort((a, b) => b.highScore - a.highScore)
    .slice(0, limit);
}

/**
 * Format balance for display (convert from atomic units)
 * @param {number} atomicAmount - Amount in atomic units (18 decimals)
 * @returns {number} Amount in UCT (readable format)
 */
export function formatBalance(atomicAmount) {
  return (atomicAmount / 1e18).toFixed(2);
}

/**
 * Convert UCT amount to atomic units
 * @param {number} uct - Amount in UCT
 * @returns {number} Amount in atomic units
 */
export function toAtomicUnits(uct) {
  return Math.round(uct * 1e18);
}

/**
 * Get move cost in atomic units
 * @returns {number} Move cost in atomic units
 */
export function getMoveCost() {
  return MOVE_COST_ATOMIC;
}

/**
 * Export all user data (for persistence to JSON if needed)
 * @returns {object} User balances as plain object
 */
export function exportData() {
  const data = {};
  userBalances.forEach((value, key) => {
    data[key] = value;
  });
  return data;
}

/**
 * Import user data from file or object
 * @param {object} data - User data to import
 */
export function importData(data) {
  Object.entries(data).forEach(([userId, userRecord]) => {
    userBalances.set(userId, userRecord);
  });
  console.log(`[Balance] Imported ${Object.keys(data).length} user records`);
}
