/**
 * index.js — Express Server
 *
 * Responsibilities:
 *   • Serve the static frontend from /public
 *   • Hold per-session game state in memory (Map keyed by session ID)
 *   • Expose a REST API consumed by the frontend:
 *       GET  /api/state           → return current board + score
 *       POST /api/new             → start a new game
 *       POST /api/move            → apply a directional move
 *       POST /api/submit-score    → push final score to the Unicity chain
 *       GET  /api/sphere-status   → Sphere SDK connection info
 *   • Initialise the Sphere SDK at startup
 */

// Load environment variables from .env file
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';
import { randomUUID }     from 'crypto';

import { GameState }    from './game.js';
import { connectSphere, submitScore, getSphereStatus, publishGameWallet, getServerWalletAddress, simulateDeposit, getUserDeposits } from './sphere.js';
import * as UserBalances from './userBalances.js';

// ─── Setup ────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const app  = express();
const PORT = 5000;

// ─── Global Error Handlers ────────────────────────────────────────────────────

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Server] Unhandled Rejection at:', promise, 'reason:', reason);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('[Server] Uncaught Exception:', error);
  process.exit(1);
});

// Parse JSON request bodies
app.use(express.json());

// Serve static files (HTML, CSS, JS) from the /public directory
app.use(express.static(join(__dirname, 'public')));

// ─── In-Memory Session Store ──────────────────────────────────────────────────

/**
 * Sessions map: sessionId → { userId, gameState, createdAt }
 * Each browser session is linked to a userId (wallet address or nametag)
 */
const sessions = new Map();

/** Best score per user: userId → bestScore */
const userBestScores = new Map();

/** Session to userId mapping for quick lookup */
const sessionUserMap = new Map();

/**
 * Retrieves or creates a GameState for the given user.
 * @param {string} userId - Unique user identifier
 * @returns {GameState}
 */
function getSession(userId) {
  if (!sessions.has(userId)) {
    const best = userBestScores.get(userId) ?? 0;
    const state = new GameState(best);
    sessions.set(userId, { 
      userId, 
      gameState: state,
      createdAt: Date.now()
    });
  }
  const session = sessions.get(userId);
  return session.gameState;
}

// ─── API Routes ───────────────────────────────────────────────────────────────

/**
 * POST /api/connect
 * Connects a wallet to the game and initializes balance tracking.
 *
 * Body:
 *   { walletId: string }  — Wallet address or nametag (e.g., "alpha1qq8..." or "myname")
 *
 * Response:
 *   { success: boolean, userId: string, balance: object, treasuryAddress: string }
 */
app.post('/api/connect', (req, res) => {
  const { walletId } = req.body;

  if (!walletId || typeof walletId !== 'string') {
    return res.status(400).json({ 
      success: false, 
      error: 'walletId required' 
    });
  }

  try {
    const userId = walletId; // Use wallet ID as user ID
    
    // Initialize or retrieve user balance
    const user = UserBalances.initializeUser(userId, walletId);
    
    // Get treasury address
    const treasuryAddress = getServerWalletAddress();
    
    console.log(`[Server] User connected: ${userId}`);
    
    res.json({ 
      success: true, 
      userId,
      balance: {
        current: UserBalances.formatBalance(user.balance),
        totalDeposited: UserBalances.formatBalance(user.totalDeposited),
        movesLeft: user.movesLeft
      },
      treasuryAddress,
      treasuryNametag: 'sphere2048'
    });
  } catch (err) {
    console.error('[Server] Connection error:', err);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

/**
 * POST /api/register
 * Registers a player with the game using their wallet identity.
 * Simply stores their wallet address for balance tracking.
 *
 * Body:
 *   { nametag?: string, address?: string }
 *
 * Response:
 *   { success: boolean, treasuryAddress: string, treasuryNametag: string }
 */
app.post('/api/register', (req, res) => {
  const sid = req.headers['x-session-id'] || randomUUID();
  const { nametag, address } = req.body;

  if (!nametag && !address) {
    return res.status(400).json({ 
      success: false, 
      error: 'nametag or address required' 
    });
  }

  try {
    // Use nametag as userId if available, otherwise address
    const userId = nametag || address;
    
    // Initialize user balance tracking
    UserBalances.initializeUser(userId, address);
    
    // Get treasury address
    const treasuryAddress = getServerWalletAddress();
    
    console.log(`[Server] Player registered: ${userId}`);
    
    res.json({ 
      success: true,
      userId,
      treasuryAddress,
      treasuryNametag: '2048game'
    });
  } catch (err) {
    console.error('[Server] Registration error:', err);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

/**
 * GET /api/balance
 * Returns user balance and moves left.
 *
 * Query params:
 *   userId - User identifier
 *
 * Response:
 *   { success: boolean, balance: object }
 */
app.get('/api/balance', (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ 
      success: false, 
      error: 'userId required' 
    });
  }

  try {
    const user = UserBalances.getBalance(userId);
    
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        error: 'User not found' 
      });
    }

    res.json({ 
      success: true,
      userId,
      balance: {
        current: UserBalances.formatBalance(user.balance),
        totalDeposited: UserBalances.formatBalance(user.totalDeposited),
        movesLeft: user.movesLeft,
        totalMoves: user.totalMoves,
        highScore: user.highScore
      }
    });
  } catch (err) {
    console.error('[Server] Balance check error:', err);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

/**
 * POST /api/verify-deposit
 * Manually process user deposits (for MVP testing).
 * In production, this would query the blockchain.
 *
 * Body:
 *   { userId: string, senderAddress: string, uct: number }
 *
 * Response:
 *   { success: boolean, transaction?: object, balance?: object }
 */
app.post('/api/verify-deposit', (req, res) => {
  const { userId, senderAddress, uct } = req.body;

  if (!userId || !senderAddress || uct === undefined) {
    return res.status(400).json({ 
      success: false, 
      error: 'userId, senderAddress, and uct required' 
    });
  }

  if (typeof uct !== 'number' || uct <= 0) {
    return res.status(400).json({ 
      success: false, 
      error: 'uct must be a positive number' 
    });
  }

  try {
    // Ensure user exists
    UserBalances.initializeUser(userId, userId);

    // Record the deposit
    const tx = simulateDeposit(senderAddress, uct, userId);
    
    if (!tx) {
      return res.status(400).json({ 
        success: false, 
        error: 'Duplicate transaction' 
      });
    }

    // Add deposit to user balance
    const amountAtomic = Math.round(uct * 1e18);
    const user = UserBalances.addDeposit(userId, amountAtomic);

    res.json({ 
      success: true,
      transaction: tx,
      balance: {
        current: UserBalances.formatBalance(user.balance),
        totalDeposited: UserBalances.formatBalance(user.totalDeposited),
        movesLeft: user.movesLeft
      }
    });
  } catch (err) {
    console.error('[Server] Deposit processing error:', err);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

/**
 * GET /api/state
 * Returns the current game state for the given user.
 *
 * Query params:
 *   userId - User identifier
 */
app.get('/api/state', (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ 
      success: false, 
      error: 'userId required' 
    });
  }

  try {
    const state = getSession(userId);
    const user = UserBalances.getBalance(userId);

    res.json({ 
      userId,
      canPlay: user ? UserBalances.canMove(userId) : false,
      balance: user ? {
        current: UserBalances.formatBalance(user.balance),
        movesLeft: user.movesLeft
      } : null,
      ...state.toJSON() 
    });
  } catch (err) {
    console.error('[Server] State fetch error:', err);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

/**
 * POST /api/new
 * Starts a fresh game for the user.
 *
 * Query params:
 *   userId - User identifier
 */
app.post('/api/new', (req, res) => {
  const { userId } = req.query || req.body;

  if (!userId) {
    return res.status(400).json({ 
      success: false, 
      error: 'userId required' 
    });
  }

  try {
    const best = userBestScores.get(userId) ?? 0;
    const state = new GameState(best);
    
    sessions.set(userId, { 
      userId, 
      gameState: state,
      createdAt: Date.now()
    });

    const user = UserBalances.getBalance(userId);

    res.json({ 
      userId,
      canPlay: user ? UserBalances.canMove(userId) : false,
      ...state.toJSON() 
    });
  } catch (err) {
    console.error('[Server] New game error:', err);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

/**
 * POST /api/move
 * Applies a directional move to the current game.
 * REQUIRES sufficient balance before move is processed.
 *
 * Body:
 *   { userId: string, direction: 'left' | 'right' | 'up' | 'down' }
 *
 * Response:
 *   { success: boolean, moved: boolean, balance?: object, ...gameState }
 */
app.post('/api/move', (req, res) => {
  const { userId, direction } = req.body;

  if (!userId) {
    return res.status(400).json({ 
      success: false, 
      error: 'userId required' 
    });
  }

  // Validate direction
  const valid = ['left', 'right', 'up', 'down'];
  if (!valid.includes(direction)) {
    return res.status(400).json({ 
      success: false,
      error: `Invalid direction. Must be one of: ${valid.join(', ')}` 
    });
  }

  try {
    // Check user balance FIRST (server-side validation)
    if (!UserBalances.canMove(userId)) {
      return res.status(402).json({ 
        success: false,
        error: 'Insufficient balance for move',
        canPlay: false
      });
    }

    // Deduct balance before moving
    const deducted = UserBalances.deductMove(userId);
    
    if (!deducted) {
      return res.status(402).json({ 
        success: false,
        error: 'Failed to deduct move cost'
      });
    }

    // Apply move to game
    const state = getSession(userId);
    const moved = state.move(direction);

    // Update high score if needed
    if (state.score > (userBestScores.get(userId) ?? 0)) {
      userBestScores.set(userId, state.score);
    }

    const user = UserBalances.getBalance(userId);

    res.json({ 
      success: true,
      userId,
      moved,
      canPlay: UserBalances.canMove(userId),
      balance: {
        current: UserBalances.formatBalance(user.balance),
        movesLeft: user.movesLeft
      },
      ...state.toJSON() 
    });
  } catch (err) {
    console.error('[Server] Move error:', err);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

/**
 * POST /api/submit-score
 * Submits the current game score.
 *
 * Body:
 *   { userId: string }
 *
 * Response:
 *   { success: boolean, score: number }
 */
app.post('/api/submit-score', (req, res) => {
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ 
      success: false, 
      error: 'userId required' 
    });
  }

  try {
    const state = getSession(userId);
    UserBalances.updateHighScore(userId, state.score);

    res.json({ 
      success: true,
      userId,
      score: state.score,
      highScore: UserBalances.getBalance(userId)?.highScore
    });
  } catch (err) {
    console.error('[Server] Score submission error:', err);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

/**
 * GET /api/leaderboard
 * Returns top players by high score.
 *
 * Query params:
 *   limit - Number of results (default: 10)
 */
app.get('/api/leaderboard', (req, res) => {
  const limit = parseInt(req.query.limit) || 10;

  try {
    const leaderboard = UserBalances.getLeaderboard(limit)
      .map((user, index) => ({
        rank: index + 1,
        walletId: user.walletId,
        highScore: user.highScore,
        totalMoves: user.totalMoves
      }));

    res.json({ 
      success: true,
      leaderboard 
    });
  } catch (err) {
    console.error('[Server] Leaderboard error:', err);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

/**
 * GET /api/sphere-status
 * Returns Sphere SDK connection status and wallet info.
 */
app.get('/api/sphere-status', (req, res) => {
  res.json(getSphereStatus());
});

// ─── Startup ──────────────────────────────────────────────────────────────────

/**
 * Boot sequence:
 *   1. Initialize treasury wallet configuration
 *   2. Start the Express server
 *   3. Server is ready for game play
 */
async function startup() {
  try {
    await connectSphere();
  } catch (err) {
    console.error('[Server] Treasury init error (non-fatal):', err.message);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] 2048 Game Server listening on http://0.0.0.0:${PORT}`);
    console.log(`[Server] Treasury Address: ${getServerWalletAddress()}`);
    console.log(`[Server] Ready for deposits → Move cost: 0.1 UCT`);
  });
}

startup();
