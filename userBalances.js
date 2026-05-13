/**
 * userBalances.js — User Balance & Deposit Tracking (REDESIGNED)
 *
 * SIMPLE MODEL:
 *   - Everything in CENTS (100 CENTS = 1 UCT)
 *   - No floating point arithmetic
 *   - 1 move costs exactly 10 CENTS (0.1 UCT)
 *   - Moves = balanceCents / 10 (integer division)
 *
 * User record structure:
 * {
 *   walletId: string,           // wallet address or nametag
 *   balanceCents: number,       // balance in CENTS (100 = 1 UCT)
 *   totalDepositedCents: number,// lifetime deposits in CENTS
 *   totalMovesMade: number,     // lifetime moves
 *   highScore: number,          // best score
 *   createdAt: timestamp
 * }
 */

// CONSTANTS - All in CENTS
const MOVE_COST_CENTS = 10;        // 0.1 UCT = 10 CENTS
const CENTS_PER_UCT = 100;         // 1 UCT = 100 CENTS

/**
 * In-memory user balance store
 * @type {Map<string, object>}
 */
const userBalances = new Map();

/**
 * Initialize or get user balance record
 * @param {string} userId - User identifier
 * @param {string} walletId - Wallet address/nametag
 * @returns {object} User record
 */
export function initializeUser(userId, walletId) {
  if (!userBalances.has(userId)) {
    const record = {
      walletId,
      balanceCents: 0,
      totalDepositedCents: 0,
      totalMovesMade: 0,
      highScore: 0,
      createdAt: Date.now(),
    };
    userBalances.set(userId, record);
    console.log(`[Balance] Initialized user: ${userId}`);
  } else {
    const user = userBalances.get(userId);
    if (walletId && walletId !== user.walletId) {
      user.walletId = walletId;
    }
  }
  return userBalances.get(userId);
}

/**
 * Get user record
 * @param {string} userId - User identifier
 * @returns {object|null}
 */
export function getBalance(userId) {
  return userBalances.get(userId) || null;
}

/**
 * Add a deposit in UCT (converts to CENTS internally)
 * @param {string} userId - User identifier
 * @param {number} uct - Amount in UCT (e.g., 30.5)
 * @returns {object} Updated user record
 */
export function addDepositUCT(userId, uct) {
  const user = userBalances.get(userId);
  if (!user) {
    throw new Error(`User ${userId} not found - call initializeUser first`);
  }

  // Convert UCT to CENTS: e.g., 30.5 UCT = 3050 CENTS
  const depositCents = Math.round(uct * CENTS_PER_UCT);
  const movesGained = Math.floor(depositCents / MOVE_COST_CENTS);

  user.balanceCents += depositCents;
  user.totalDepositedCents += depositCents;

  console.log(
    `[Balance] Deposit: ${userId} +${uct} UCT. ` +
    `Balance: ${centsToUCT(user.balanceCents)} UCT, ` +
    `Moves: ${calculateMoves(user.balanceCents)}, ` +
    `Total deposited: ${centsToUCT(user.totalDepositedCents)} UCT`
  );

  return user;
}

/**
 * Add deposit from atomic units (blockchain)
 * @param {string} userId - User identifier
 * @param {number} atomicUnits - Amount in 1e18 units
 * @returns {object} Updated user record
 */
export function addDepositAtomic(userId, atomicUnits) {
  // Convert from atomic units to UCT: divide by 1e18
  const uct = atomicUnits / 1e18;
  return addDepositUCT(userId, uct);
}

/**
 * Calculate moves from balance (simple integer division)
 * @param {number} balanceCents - Balance in CENTS
 * @returns {number} Number of moves available
 */
export function calculateMoves(balanceCents) {
  return Math.floor(balanceCents / MOVE_COST_CENTS);
}

/**
 * Check if user can make a move
 * @param {string} userId - User identifier
 * @returns {boolean}
 */
export function canMove(userId) {
  const user = userBalances.get(userId);
  if (!user) {
    console.log(`[Balance] canMove: user ${userId} not found`);
    return false;
  }

  const movesAvailable = calculateMoves(user.balanceCents);
  const can = movesAvailable > 0;

  console.log(
    `[Balance] canMove(${userId}): balance=${centsToUCT(user.balanceCents)} UCT, ` +
    `moves=${movesAvailable}, available=${can}`
  );

  return can;
}

/**
 * Deduct a move from user balance
 * @param {string} userId - User identifier
 * @returns {boolean} true if successful
 */
export function deductMove(userId) {
  const user = userBalances.get(userId);
  if (!user) {
    throw new Error(`User ${userId} not found`);
  }

  const movesAvailable = calculateMoves(user.balanceCents);
  if (movesAvailable <= 0) {
    console.log(
      `[Balance] Cannot deduct move: ${userId} has 0 moves (${centsToUCT(user.balanceCents)} UCT)`
    );
    return false;
  }

  user.balanceCents -= MOVE_COST_CENTS;
  user.totalMovesMade += 1;

  console.log(
    `[Balance] Move deducted: ${userId}. ` +
    `Remaining: ${centsToUCT(user.balanceCents)} UCT (${calculateMoves(user.balanceCents)} moves left). ` +
    `Total moves: ${user.totalMovesMade}`
  );

  return true;
}

/**
 * Update high score
 * @param {string} userId - User identifier
 * @param {number} score - New score
 */
export function updateHighScore(userId, score) {
  const user = userBalances.get(userId);
  if (!user) return;

  if (score > user.highScore) {
    user.highScore = score;
    console.log(`[Balance] High score: ${userId} → ${score}`);
  }
}

/**
 * Get all users for leaderboard
 * @returns {object[]}
 */
export function getAllUsers() {
  return Array.from(userBalances.values());
}

/**
 * Get top users by high score
 * @param {number} limit
 * @returns {object[]}
 */
export function getLeaderboard(limit = 10) {
  return getAllUsers()
    .sort((a, b) => b.highScore - a.highScore)
    .slice(0, limit);
}

/**
 * Format CENTS to UCT string (e.g., 3050 CENTS → "30.50")
 * @param {number} cents
 * @returns {string}
 */
export function centsToUCT(cents) {
  const uct = cents / CENTS_PER_UCT;
  return uct.toFixed(2);
}

/**
 * Format balance as display object
 * @param {number} cents
 * @returns {object}
 */
export function formatBalance(cents) {
  return {
    uct: centsToUCT(cents),
    cents: cents,
    moves: calculateMoves(cents),
  };
}

/**
 * Sync from database record
 * @param {string} userId
 * @param {object} dbRecord - { balance, total_deposited, total_moves, high_score, wallet_id }
 */
export function syncFromDatabase(userId, dbRecord) {
  if (!dbRecord) return;

  const user = initializeUser(userId, dbRecord.wallet_id);

  // Convert from atomic units (1e18) to CENTS
  // 1e18 atomic units = 1 UCT = 100 CENTS
  // So: cents = atomicUnits / 1e16
  user.balanceCents = Math.round((dbRecord.balance || 0) / 1e16);
  user.totalDepositedCents = Math.round((dbRecord.total_deposited || 0) / 1e16);
  user.totalMovesMade = dbRecord.total_moves || 0;
  user.highScore = dbRecord.high_score || 0;

  console.log(
    `[Balance] Synced from DB: ${userId} ` +
    `balance=${centsToUCT(user.balanceCents)} UCT, ` +
    `moves=${calculateMoves(user.balanceCents)}, ` +
    `total_deposited=${centsToUCT(user.totalDepositedCents)} UCT`
  );

  return user;
}

/**
 * Export user state for persistence
 * @param {string} userId
 * @returns {object}
 */
export function exportUserState(userId) {
  const user = userBalances.get(userId);
  if (!user) return null;

  return {
    walletId: user.walletId,
    balanceUCT: centsToUCT(user.balanceCents),
    balanceCents: user.balanceCents,
    totalDepositedUCT: centsToUCT(user.totalDepositedCents),
    totalDepositedCents: user.totalDepositedCents,
    movesLeft: calculateMoves(user.balanceCents),
    totalMovesMade: user.totalMovesMade,
    highScore: user.highScore,
  };
}

// Legacy function names for compatibility
export function addDeposit(userId, atomicUnits) {
  return addDepositAtomic(userId, atomicUnits);
}
