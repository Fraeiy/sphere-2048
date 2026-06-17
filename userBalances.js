/**
 * userBalances.js — User balance state management & conversion utilities
 *
 * CONVERSION CONSTANTS:
 *   - Blockchain atomic: 1e18 units = 1 UCT
 *   - Display CENTS: 100 CENTS = 1 UCT  
 *   - Move cost: 0.1 UCT = 1e17 atomic = 10 CENTS
 */

const MOVE_COST_ATOMIC = 1n * BigInt(1e17);  // 0.1 UCT in atomic
const CENTS_PER_UCT = 100;

// In-memory user state cache
const userCache = new Map();

/**
 * Initialize a new user in memory
 * @param {string} userId - User ID
 * @param {string} walletId - Wallet address
 */
export function initializeUser(userId, walletId) {
  if (!userCache.has(userId)) {
    userCache.set(userId, {
      userId,
      walletId,
      balanceCents: 0,
      totalDepositedCents: 0,
      highScore: 0,
      totalMovesMade: 0,
    });
  }
}

/**
 * Sync user state from database to in-memory cache
 * @param {string} userId - User ID
 * @param {object} dbUser - DB user record (has balance/total_deposited in atomic units)
 */
export function syncFromDatabase(userId, dbUser) {
  const balanceCents = dbUser.balance ? Math.floor((dbUser.balance / 1e18) * CENTS_PER_UCT) : 0;
  const totalDepositedCents = dbUser.total_deposited ? Math.floor((dbUser.total_deposited / 1e18) * CENTS_PER_UCT) : 0;
  const highScore = dbUser.high_score || 0;
  
  userCache.set(userId, {
    userId,
    walletId: dbUser.wallet_id || dbUser.wallet_address || userId,
    balanceCents,
    totalDepositedCents,
    highScore,
    totalMovesMade: dbUser.total_moves || 0,
  });
}

/**
 * Get user balance from in-memory cache
 * @param {string} userId - User ID
 * @returns {object} User balance object with balanceCents, totalDepositedCents, highScore
 */
export function getBalance(userId) {
  if (!userCache.has(userId)) {
    initializeUser(userId, userId);
  }
  return userCache.get(userId);
}

/**
 * Calculate moves from balance in cents
 * @param {number} balanceCents - Balance in cents
 * @returns {number} Number of moves available
 */
export function calculateMoves(balanceCents) {
  const balanceAtomic = Math.floor((balanceCents / CENTS_PER_UCT) * 1e18);
  return calculateMovesFromAtomic(balanceAtomic);
}

/**
 * Convert cents to UCT string
 * @param {number} cents - Balance in cents
 * @returns {string} e.g., "30.50"
 */
export function centsToUCT(cents) {
  const uct = cents / CENTS_PER_UCT;
  return uct.toFixed(2);
}

/**
 * Add a deposit (in atomic units) to a user's balance
 * @param {string} userId - User ID
 * @param {number} amountAtomic - Amount in atomic units
 * @returns {object} Updated user balance object
 */
export function addDepositAtomic(userId, amountAtomic) {
  const user = getBalance(userId);
  const amountCents = Math.floor((amountAtomic / 1e18) * CENTS_PER_UCT);
  
  user.balanceCents += amountCents;
  user.totalDepositedCents += amountCents;
  
  return user;
}

/**
 * Update a user's high score
 * @param {string} userId - User ID
 * @param {number} score - New score
 */
export function updateHighScore(userId, score) {
  const user = getBalance(userId);
  if (score > user.highScore) {
    user.highScore = score;
  }
}

/**
 * Calculate moves from balance (atomic units)
 * @param {number} balanceAtomic - Balance in 1e18 atomic units
 * @returns {number} Number of moves available
 */
export function calculateMovesFromAtomic(balanceAtomic) {
  const moves = Math.floor(balanceAtomic / Number(MOVE_COST_ATOMIC));
  return moves;
}

/**
 * Convert atomic units to UCT string
 * @param {number} atomic - Balance in 1e18 atomic units
 * @returns {string} e.g., "30.50"
 */
export function atomicToUCT(atomic) {
  const uct = atomic / 1e18;
  return uct.toFixed(2);
}

/**
 * Calculate moves from UCT
 * @param {number} uct - Amount in UCT
 * @returns {number}
 */
export function calculateMovesFromUCT(uct) {
  const atomic = uct * 1e18;
  return calculateMovesFromAtomic(atomic);
}

/**
 * Returns true when the user has at least one paid move available.
 * @param {string} userId
 * @returns {boolean}
 */
export function canMove(userId) {
  const user = getBalance(userId);
  return calculateMoves(user.balanceCents) > 0;
}
