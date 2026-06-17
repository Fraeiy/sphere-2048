/**
 * sphere.js — Game Treasury & Deposit Address Management
 *
 * Handles:
 *   1. Game treasury address where players deposit UCT before playing
 *   2. Score tracking and game state (optional blockchain submission)
 *
 * The game wallet (sphere2048) is where players send deposits via the Sphere wallet UI.
 * Players use their own wallets to send UCT to the game treasury address.
 *
 * Configuration via env vars:
 *   GAME_TREASURY_ADDRESS   L1 address for deposits (e.g., alpha1qq8...)
 *   GAME_TREASURY_NAMETAG   Wallet nametag (sphere2048)
 *   SPHERE_NETWORK          "testnet" | "mainnet" | "dev"  (default: testnet)
 */

import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

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

/** Sphere SDK wallet instance used for real on-chain submissions */
let sphereClient = null;

/** Chain runtime state */
let chainStatus = {
  connected: false,
  network: null,
  l1Address: null,
  dataDir: null,
  lastError: null,
};

const CHAIN_RETRY_ATTEMPTS = 3;
const CHAIN_RETRY_BASE_DELAY_MS = 750;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toBatchMemo(userId, moveCount, moveHash) {
  const compact = JSON.stringify({
    u: String(userId).slice(0, 24),
    n: moveCount,
    h: String(moveHash).slice(0, 40),
  });
  return compact.length <= 120 ? compact : compact.slice(0, 120);
}

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
  const dataDir  = process.env.SPHERE_DATA_DIR || './sphere-data';

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

  chainStatus.network = network;
  chainStatus.dataDir = dataDir;

  try {
    const providers = createNodeProviders({ network, dataDir });
    const initOptions = {
      ...providers,
      autoGenerate: true,
    };

    if (process.env.GAME_TREASURY_MNEMONIC) {
      initOptions.mnemonic = process.env.GAME_TREASURY_MNEMONIC;
      delete initOptions.autoGenerate;
    }

    const { sphere } = await Sphere.init(initOptions);
    sphereClient = sphere;

    chainStatus.connected = true;
    chainStatus.l1Address = sphere.identity?.l1Address || null;
    chainStatus.lastError = null;

    console.log('[Chain] ✅ Sphere SDK initialized for real transaction submission');
    console.log(`[Chain]    L1 Address: ${chainStatus.l1Address || 'unknown'}`);
  } catch (err) {
    chainStatus.connected = false;
    chainStatus.lastError = err?.message || String(err);
    console.error('[Chain] ❌ Failed to initialize Sphere SDK for on-chain submissions:', chainStatus.lastError);
  }

  console.log(`[Game Treasury] ✅ Treasury configured`);
  console.log(`[Game Treasury]    Nametag: ${treasuryInfo.nametag}`);
  console.log(`[Game Treasury]    Address: ${treasuryInfo.address}`);
  console.log(`[Game Treasury]    Network: ${treasuryInfo.network}`);
}

// ─── Score Submission ─────────────────────────────────────────────────────────

/**
 * Creates a unique, discoverable game handle for a player.
 * Format: @{prefix}_2048_{suffix}
 *
 * @param {string} playerAddress - Player wallet address or nametag
 * @returns {string}
 */
export function generatePlayerHandle(playerAddress) {
  const normalized = String(playerAddress || 'player').replace(/^@/, '');
  const prefix = normalized.slice(0, 6).toLowerCase().replace(/[^a-z0-9]/g, '') || 'player';
  const suffix = Math.random().toString(36).slice(2, 6);
  return `@${prefix}_2048_${suffix}`;
}

/**
 * Creates a game wallet handle for a player using their nametag.
 * Format: {nametag}_2048 (e.g., fraey_2048, john_2048)
 *
 * @param {string} nametag - Player's Sphere wallet nametag
 * @returns {string} Game wallet handle
 */
function createGameHandle(nametag) {
  const clean = String(nametag || 'player').replace(/^@/, '');
  return `${clean}_2048`;
}

/**
 * Publishes a player's game identity (optional blockchain feature).
 * In a simple setup, this just acknowledges the request.
 * 
 * @param {string} gameHandle - The player's game handle (e.g., "fraey_2048")
 * @returns {Promise<{ success: boolean, gameHandle?: string, error?: string }>}
 */
export async function publishPlayerIdentity(playerAddress, playerHandle) {
  if (!sphereClient || !chainStatus.connected) {
    console.warn('[Game] Sphere SDK unavailable — skipping identity publish');
    return { success: true, gameHandle: playerHandle, published: false };
  }

  try {
    const identity = sphereClient.identity;
    if (identity?.transport?.publishNametag) {
      await identity.transport.publishNametag(playerHandle.replace(/^@/, ''));
    }
    console.log(`[Game] Player identity published: ${playerHandle}`);
    return { success: true, gameHandle: playerHandle, published: true };
  } catch (err) {
    console.warn(`[Game] Identity publish skipped: ${err?.message || err}`);
    return { success: true, gameHandle: playerHandle, published: false };
  }
}

/**
 * @param {string} playerAddress
 * @returns {Promise<{ success: boolean, depositAddress: string|null, handle: string, gameHandle: string, published?: boolean, error?: string }>}
 */
export async function generateDepositAddress(playerAddress) {
  const handle = generatePlayerHandle(playerAddress);
  const publishResult = await publishPlayerIdentity(playerAddress, handle);
  const depositAddress = treasuryInfo.address || chainStatus.l1Address;

  if (!depositAddress) {
    return {
      success: false,
      error: 'Game treasury address is not configured',
      depositAddress: null,
      handle,
      gameHandle: handle,
    };
  }

  return {
    success: true,
    depositAddress,
    handle,
    gameHandle: publishResult.gameHandle || handle,
    published: publishResult.published ?? false,
  };
}

export async function publishGameWallet(gameHandle) {
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

async function submitMoveBatchOnce(payload) {
  if (!sphereClient || !chainStatus.connected) {
    throw new Error('Sphere SDK is not connected for chain submissions');
  }

  const l1 = sphereClient.payments?.l1;
  if (!l1) {
    throw new Error('L1 payments module is unavailable in current Sphere configuration');
  }

  const recipient = treasuryInfo.address || chainStatus.l1Address;
  if (!recipient) {
    throw new Error('No treasury L1 address available for batch transaction');
  }

  const memo = toBatchMemo(payload.userId, payload.moves.length, payload.moveHash);
  const sendResult = await l1.send({
    to: recipient,
    amount: '1',
    memo,
  });

  if (!sendResult.success || !sendResult.txHash) {
    throw new Error(sendResult.error || 'L1 send failed without txHash');
  }

  return sendResult.txHash;
}

/**
 * Submits a batch state update after 5 user moves as a real on-chain transaction.
 *
 * @param {{
 *   userId: string,
 *   moves: Array<{ direction: string, moved: boolean, score: number, moveNo: number }>,
 *   moveHash: string,
 *   finalState: { score: number, board: number[][], gameOver: boolean, won: boolean }
 * }} payload
 * @returns {Promise<{ success: boolean, txHash?: string, moveHash?: string, error?: string }>}
 */
export async function submitMoveBatch(payload) {
  let lastError = null;

  for (let attempt = 1; attempt <= CHAIN_RETRY_ATTEMPTS; attempt++) {
    try {
      const txHash = await submitMoveBatchOnce(payload);
      console.log(`[Chain] Real transaction submitted: user=${payload.userId}, txHash=${txHash}`);
      return {
        success: true,
        txHash,
        moveHash: payload.moveHash,
      };
    } catch (err) {
      lastError = err?.message || String(err);
      console.warn(`[Chain] Batch submission attempt ${attempt}/${CHAIN_RETRY_ATTEMPTS} failed for ${payload.userId}: ${lastError}`);
      if (attempt < CHAIN_RETRY_ATTEMPTS) {
        await sleep(CHAIN_RETRY_BASE_DELAY_MS * attempt);
      }
    }
  }

  return {
    success: false,
    error: lastError || 'Unknown chain submission error',
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
  const connected = Boolean(treasuryInfo.address) || chainStatus.connected;
  const wallet = {
    network: treasuryInfo.network || chainStatus.network,
    nametag: treasuryInfo.nametag,
    address: treasuryInfo.address || chainStatus.l1Address,
  };

  return {
    connected,
    treasury: treasuryInfo,
    chain: chainStatus,
    wallet,
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
