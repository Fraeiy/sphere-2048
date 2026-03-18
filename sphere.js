/**
 * sphere.js — Game Treasury & Deposit Address Management
 *
 * Handles:
 *   1. Game treasury address where players deposit UTC before playing
 *   2. Score tracking and game state (optional blockchain submission)
 *
 * The game wallet (sphere2048) is where players send deposits via the Sphere wallet UI.
 * Players use their own wallets to send UTC to the game treasury address.
 *
 * Configuration via env vars:
 *   GAME_TREASURY_ADDRESS   L1 address for deposits (e.g., alpha1qq8...)
 *   GAME_TREASURY_NAMETAG   Wallet nametag (sphere2048)
 *   SPHERE_NETWORK          "testnet" | "mainnet" | "dev"  (default: testnet)
 */

// ─── Module State ─────────────────────────────────────────────────────────────

/** Game treasury wallet info */
let treasuryInfo = { 
  address: null, 
  nametag: null, 
  network: null 
};

/** Known transactions to prevent double-crediting */
const processedTransactions = new Set();

/** Simulate transaction history (in production, query blockchain) */
let transactionHistory = [];

// ─── Initialisation ───────────────────────────────────────────────────────────

/**
 * Initializes the game treasury address from environment variables.
 * This is a simple configuration load — no blockchain connection needed.
 * 
 * Players use their own Sphere wallets to send deposits to this address.
 *
 * @returns {Promise<void>}
 */
export async function connectSphere() {
  const network  = process.env.SPHERE_NETWORK || 'testnet';
  const address  = process.env.GAME_TREASURY_ADDRESS;
  const nametag  = process.env.GAME_TREASURY_NAMETAG;

  console.log(`[Game Treasury] Setting up deposit wallet for ${network}…`);

  if (!address || !nametag) {
    console.error('[Game Treasury] ❌ Missing GAME_TREASURY_ADDRESS or GAME_TREASURY_NAMETAG in .env');
    console.warn('[Game Treasury]    Players will not be able to make deposits.');
    return;
  }

  treasuryInfo = {
    network,
    address,
    nametag,
  };

  console.log(`[Game Treasury] ✅ Treasury configured`);
  console.log(`[Game Treasury]    Nametag: ${treasuryInfo.nametag}`);
  console.log(`[Game Treasury]    Address: ${treasuryInfo.address}`);
  console.log(`[Game Treasury]    Network: ${treasuryInfo.network}`);
}

// ─── Score Submission ─────────────────────────────────────────────────────────

/**
 * Creates a game wallet handle for a player using their nametag.
 * Format: {nametag}_2048 (e.g., fraey_2048, john_2048)
 * 
 * @param {string} nametag - Player's Sphere wallet nametag
 * @returns {string} Game wallet handle
 */
function createGameHandle(nametag) {
  return `${nametag}_2048`;
}

/**
 * Publishes a player's game identity (optional blockchain feature).
 * In a simple setup, this just acknowledges the request.
 * 
 * @param {string} gameHandle - The player's game handle (e.g., "fraey_2048")
 * @returns {Promise<{ success: boolean, gameHandle?: string, error?: string }>}
 */
export async function publishGameWallet(gameHandle) {
  // Simple acknowledgment — blockchain publishing is optional
  console.log(`[Game] Game handle created: ${gameHandle}`);
  return { success: true, gameHandle };
}

/**
 * Submits the player's final score (optional blockchain feature).
 * In a simple setup, this just acknowledges the request.
 *
 * @param {number}   score    Final numeric score
 * @param {number[][]} board  Final board state (4×4 grid)
 * @returns {Promise<{ success: boolean, eventId?: string, error?: string }>}
 */
export async function submitScore(score, board) {
  // Simple acknowledgment — blockchain submission is optional
  console.log(`[Game] Score recorded: ${score}`);
  return { success: true, eventId: 'local' };
}

/**
 * Submits a batch state update after 5 user moves.
 * In production this should publish to chain/relay with proper signing.
 *
 * @param {{
 *   userId: string,
 *   moves: Array<{ direction: string, moved: boolean, score: number, ts: number }>,
 *   moveHash: string,
 *   finalState: { score: number, board: number[][], gameOver: boolean, won: boolean }
 * }} payload
 * @returns {Promise<{ success: boolean, txId?: string, moveHash?: string, error?: string }>}
 */
export async function submitMoveBatch(payload) {
  const txId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  console.log(
    `[Chain] Batched move update submitted: user=${payload.userId}, moves=${payload.moves.length}, hash=${payload.moveHash}, txId=${txId}`
  );
  return {
    success: true,
    txId,
    moveHash: payload.moveHash,
  };
}

// ─── Status ───────────────────────────────────────────────────────────────────

/**
 * Returns the game treasury address where players should send deposits.
 * @returns {string|null} Game treasury address (e.g., alpha1qq8...)
 */
export function getServerWalletAddress() {
  return treasuryInfo.address;
}

/**
 * Returns the game treasury configuration for the /api/sphere-status route.
 * @returns {{ connected: boolean, treasury: object }}
 */
export function getSphereStatus() {
  return {
    connected: treasuryInfo.address ? true : false,
    treasury:  treasuryInfo,
  };
}

// ─── Deposit Tracking ─────────────────────────────────────────────────────────

/**
 * Process a user deposit (for MVP, simulated or manual)
 * In production, this would query the blockchain for incoming transactions
 * 
 * @param {string} transactionId - Unique transaction ID
 * @param {string} senderAddress - Wallet address of sender
 * @param {number} amountAtomic - Amount in atomic units (18 decimals)
 * @param {string} memo - Transaction memo/reference (typically sender's wallet)
 * @returns {object} Transaction record
 */
export function recordDeposit(transactionId, senderAddress, amountAtomic, memo) {
  if (processedTransactions.has(transactionId)) {
    console.warn(`[Treasury] Duplicate transaction: ${transactionId}`);
    return null;
  }

  const transaction = {
    transactionId,
    senderAddress,
    amount: amountAtomic,
    memo,
    timestamp: Date.now(),
    status: 'confirmed'
  };

  processedTransactions.add(transactionId);
  transactionHistory.push(transaction);

  console.log(`[Treasury] Deposit recorded: ${transactionId} from ${senderAddress} (${amountAtomic})`);
  return transaction;
}

/**
 * Get all transactions for a user (identified by memo/wallet)
 * @param {string} userId - User identifier
 * @returns {object[]} Array of transactions for this user
 */
export function getUserDeposits(userId) {
  return transactionHistory.filter(tx => tx.memo === userId || tx.senderAddress === userId);
}

/**
 * For MVP: Manually add a deposit to test
 * In production, replace with actual blockchain query
 * 
 * @param {string} senderAddress - Sender wallet address
 * @param {number} uct - Amount in UCT
 * @param {string} memo - Recipient user ID (wallet address or nametag)
 * @returns {object} Transaction record
 */
export function simulateDeposit(senderAddress, uct, memo) {
  const amountAtomic = Math.round(uct * 1e18);
  const txId = `sim_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  return recordDeposit(txId, senderAddress, amountAtomic, memo);
}
