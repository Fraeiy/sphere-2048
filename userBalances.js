/**
 * userBalances.js — Pure utility functions for balance calculations
 * ⚠️  No in-memory state! All reads/writes go through DB layer.
 *
 * CONVERSION CONSTANTS:
 *   - Blockchain atomic: 1e18 units = 1 UCT
 *   - Display CENTS: 100 CENTS = 1 UCT  
 *   - Move cost: 0.1 UCT = 1e17 atomic = 10 CENTS
 */

const MOVE_COST_ATOMIC = 1n * BigInt(1e17);  // 0.1 UCT in atomic
const CENTS_PER_UCT = 100;

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
