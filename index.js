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
import { randomUUID, createHash } from 'crypto';

import { GameState }    from './game.js';
import { connectSphere, submitScore, submitMoveBatch, getSphereStatus, publishGameWallet, getServerWalletAddress, simulateDeposit, getUserDeposits } from './sphere.js';
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
 * Per-user move buffer used for 5-move batching to chain.
 * userId -> Array<{ moveNo, direction, moved, score }>
 */
const userMoveBuffers = new Map();

/**
 * Per-user queued move batches waiting for chain submission.
 * userId -> Array<{ payload: object, attempts: number }>
 */
const userBatchQueues = new Map();

/** Users currently being processed by batch worker. */
const userBatchProcessing = new Set();

/** Leaderboard cache for performance optimization */
const leaderboardCache = {
  data: null,
  timestamp: 0,
  ttl: 30000 // 30 seconds
};

const MOVE_BATCH_SIZE = 5;

function pushMoveForBatch(userId, moveData) {
  const buffer = userMoveBuffers.get(userId) ?? [];
  buffer.push(moveData);
  userMoveBuffers.set(userId, buffer);
  return buffer;
}

function hashMoveBatch(moves) {
  const canonical = moves.map((m) => ({
    moveNo: m.moveNo,
    direction: m.direction,
    moved: m.moved,
    score: m.score,
  }));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function enqueueMoveBatch(userId, payload) {
  const queue = userBatchQueues.get(userId) ?? [];
  queue.push({ payload, attempts: 0 });
  userBatchQueues.set(userId, queue);
  processMoveBatchQueue(userId).catch((err) => {
    console.error(`[Chain] Queue worker crashed for ${userId}:`, err);
  });
}

async function processMoveBatchQueue(userId) {
  if (userBatchProcessing.has(userId)) {
    return;
  }

  userBatchProcessing.add(userId);

  try {
    while (true) {
      const queue = userBatchQueues.get(userId);
      if (!queue || queue.length === 0) {
        break;
      }

      const job = queue[0];
      const chainResult = await submitMoveBatch(job.payload);

      if (chainResult.success) {
        const session = sessions.get(userId);
        if (session) {
          session.lastBatchTxHash = chainResult.txHash;
        }
        queue.shift();
        continue;
      }

      job.attempts += 1;
      const retryDelayMs = Math.min(15000, 1000 * job.attempts);
      console.warn(
        `[Chain] Batch queued retry for ${userId} in ${retryDelayMs}ms (attempt ${job.attempts}, reason: ${chainResult.error || 'unknown'})`
      );

      setTimeout(() => {
        processMoveBatchQueue(userId).catch((err) => {
          console.error(`[Chain] Queue worker retry crashed for ${userId}:`, err);
        });
      }, retryDelayMs);

      break;
    }
  } finally {
    userBatchProcessing.delete(userId);
  }
}

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
      createdAt: Date.now(),
      lastBatchTxHash: null,
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
    console.log(`[Balance] Checking balance for ${userId}`);
    const user = UserBalances.getBalance(userId);
    
    if (!user) {
      console.log(`[Balance] User ${userId} not found. Available users: ${Array.from(UserBalances.getAllUsers().map(u => u.walletId)).join(', ')}`);
      return res.status(404).json({ 
        success: false, 
        error: 'User not found' 
      });
    }

    console.log(`[Balance] Found user: movesLeft=${user.movesLeft}, balance=${user.balance}`);

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
 * POST /api/test-deposit
 * Quick test deposit endpoint for development.
 * Simulates a deposit without blockchain verification.
 *
 * Body:
 *   { userId: string, uct: number }
 *
 * Response:
 *   { success: boolean, balance?: object }
 */
app.post('/api/test-deposit', (req, res) => {
  const { userId, uct } = req.body;

  if (!userId || uct === undefined) {
    return res.status(400).json({ 
      success: false, 
      error: 'userId and uct required' 
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

    // Add deposit directly without blockchain verification
    const amountAtomic = Math.round(uct * 1e18);
    const user = UserBalances.addDeposit(userId, amountAtomic);

    console.log(`[TestDeposit] Credited ${uct} UCT to ${userId}`);

    res.json({ 
      success: true,
      balance: {
        current: UserBalances.formatBalance(user.balance),
        totalDeposited: UserBalances.formatBalance(user.totalDeposited),
        movesLeft: user.movesLeft,
        totalMoves: user.totalMoves
      }
    });
  } catch (err) {
    console.error('[Server] Test deposit error:', err);
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
    const session = sessions.get(userId);
    const user = UserBalances.getBalance(userId);

    res.json({ 
      userId,
      canPlay: user ? UserBalances.canMove(userId) : false,
      lastBatchTxHash: session?.lastBatchTxHash || null,
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
  // Check query first, then body
  let userId = req.query?.userId || req.body?.userId;

  if (!userId) {
    console.error('[Server] /api/new missing userId. Query:', req.query, 'Body:', req.body);
    return res.status(400).json({ 
      success: false, 
      error: 'userId required' 
    });
  }

  try {
    console.log(`[Server] Starting new game for ${userId}`);
    const best = userBestScores.get(userId) ?? 0;
    const state = new GameState(best);
    
    const existing = sessions.get(userId);
    sessions.set(userId, { 
      userId, 
      gameState: state,
      createdAt: Date.now(),
      lastBatchTxHash: existing?.lastBatchTxHash || null,
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
app.post('/api/move', async (req, res) => {
  const { userId, direction } = req.body;

  if (!userId) {
    console.error('[Server] /api/move missing userId. Body:', req.body);
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
    console.log(`[Server] Move: ${userId} → ${direction}`);
    
    // Check user balance FIRST (server-side validation)
    if (!UserBalances.canMove(userId)) {
      const user = UserBalances.getBalance(userId);
      console.log(`[Server] Insufficient balance: ${userId} has ${user?.balance ?? 0} balance, needs ${0.1 * 1e18}`);
      return res.status(402).json({ 
        success: false,
        error: 'NO_MOVES',
        errorMessage: 'Insufficient moves. Please deposit more tokens to continue.',
        canPlay: false
      });
    }

    // CRITICAL SAFETY CHECK: Verify moves left before proceeding
    const preCheckUser = UserBalances.getBalance(userId);
    if (!preCheckUser || preCheckUser.movesLeft <= 0) {
      console.error(`[Server] SAFETY: Prevented move with moves=${preCheckUser?.movesLeft ?? 'unknown'} for ${userId}`);
      return res.status(402).json({ 
        success: false,
        error: 'NO_MOVES',
        errorMessage: 'No moves available',
        canPlay: false
      });
    }

    // Deduct balance before moving
    const deducted = UserBalances.deductMove(userId);
    
    if (!deducted) {
      return res.status(402).json({ 
        success: false,
        error: 'NO_MOVES',
        errorMessage: 'Failed to deduct move cost',
        canPlay: false
      });
    }

    // Apply move to game
    const state = getSession(userId);
    const moved = state.move(direction);
    const userAfterMoveCharge = UserBalances.getBalance(userId);

    // Update high score if needed
    if (state.score > (userBestScores.get(userId) ?? 0)) {
      userBestScores.set(userId, state.score);
    }
    UserBalances.updateHighScore(userId, state.score);

    // Track this move for 5-move on-chain batching.
    const moveBuffer = pushMoveForBatch(userId, {
      moveNo: userAfterMoveCharge?.totalMoves ?? Date.now(),
      direction,
      moved,
      score: state.score,
    });

    let batchTx = null;
    if (moveBuffer.length >= MOVE_BATCH_SIZE) {
      const batchMoves = moveBuffer.slice(0, MOVE_BATCH_SIZE);
      const moveHash = hashMoveBatch(batchMoves);

      const payload = {
        userId,
        moves: batchMoves,
        moveHash,
        finalState: {
          score: state.score,
          board: state.board,
          gameOver: state.gameOver,
          won: state.won,
        },
      };

      // Queue chain submission in the background to keep move latency low.
      userMoveBuffers.set(userId, moveBuffer.slice(MOVE_BATCH_SIZE));
      enqueueMoveBatch(userId, payload);

      batchTx = {
        queued: true,
        moveHash,
        count: batchMoves.length,
      };
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
      moveBatch: batchTx,
      ...state.toJSON() 
    });
  } catch (err) {
    console.error('[Server] Move error:', err);
    // CRITICAL: Return error without modifying state further
    // Ensure state is NOT reset or corrupted
    res.status(500).json({ 
      success: false, 
      error: 'MOVE_ERROR',
      errorMessage: 'Failed to process move',
      details: err.message 
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
    
    // CRITICAL: Always save the score to prevent loss
    if (state && state.score > 0) {
      UserBalances.updateHighScore(userId, state.score);
      console.log(`[Score] Submitted score ${state.score} for ${userId}`);
    }

    res.json({ 
      success: true,
      userId,
      score: state?.score || 0,
      highScore: UserBalances.getBalance(userId)?.highScore || 0
    });
  } catch (err) {
    console.error('[Server] Score submission error:', err);
    // CRITICAL: Return error but don't lose the score
    res.status(500).json({ 
      success: false, 
      error: 'SCORE_SUBMISSION_ERROR',
      errorMessage: 'Failed to submit score, but score has been saved locally',
      details: err.message 
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
  const limit = parseInt(req.query.limit, 10) || 10;

  try {
    // Check cache first (performance optimization)
    const now = Date.now();
    if (leaderboardCache.data && (now - leaderboardCache.timestamp) < leaderboardCache.ttl) {
      return res.json({ 
        success: true,
        leaderboard: leaderboardCache.data.slice(0, limit),
        cached: true
      });
    }

    // Compute and cache leaderboard
    const leaderboard = UserBalances.getLeaderboard(limit)
      .map((user, index) => ({
        rank: index + 1,
        walletId: user.walletId || user.userId || 'Unknown',
        highScore: user.highScore,
        totalMoves: user.totalMoves
      }));

    leaderboardCache.data = leaderboard;
    leaderboardCache.timestamp = now;

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
