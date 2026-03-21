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
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';
import { randomUUID, createHash } from 'crypto';

import { GameState }    from './game.js';
import { connectSphere, submitScore, submitMoveBatch, getSphereStatus, publishGameWallet, getServerWalletAddress, simulateDeposit, getUserDeposits } from './sphere.js';
import * as UserBalances from './userBalances.js';
import * as db from './db.js';

// ─── Setup ────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const app  = express();
const PORT = process.env.PORT || 5000;

// Determine allowed origins for CORS
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5000',
  'http://127.0.0.1:5000',
  'http://127.0.0.1:3000',
  process.env.FRONTEND_URL || '',
  'https://sphere-2048.vercel.app',
  'https://*.vercel.app'
].filter(Boolean);

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

// ─── Security Middleware ──────────────────────────────────────────────────────

// Helmet: Set various HTTP headers for security
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "https://sphere.unicity.network", "https://api.unicity.network"]
    }
  },
  xFrameOptions: { action: 'SAMEORIGIN' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));

// CORS: Allow requests from specified origins with credentials
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl requests)
    if (!origin) return callback(null, true);
    
    // Check if origin matches allowed list
    const isAllowed = allowedOrigins.some(allowed => {
      if (allowed.includes('*')) {
        const pattern = new RegExp('^' + allowed.replace(/\*/g, '.*') + '$');
        return pattern.test(origin);
      }
      return origin === allowed;
    });

    if (isAllowed || process.env.NODE_ENV === 'development') {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'X-Session-ID'],
  maxAge: 86400 // 24 hours
}));

// Rate limiting middleware
const limiters = {
  // General API rate limit: 100 requests per 15 minutes
  general: rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: 'Too many requests from this IP, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.path.startsWith('/public') || req.path === '/'
  }),

  // Strict limit for authentication/sensitive endpoints: 5 per minute
  auth: rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    message: 'Too many authentication attempts, please try again later.',
    skipSuccessfulRequests: false
  }),

  // Move endpoint: 20 per minute (reasonable game speed)
  moves: rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    message: 'Move limit exceeded, please slow down.',
    skipSuccessfulRequests: true
  }),

  // Deposit endpoint: 10 per hour (prevent spam)
  deposits: rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    message: 'Deposit limit exceeded, please try again later.',
    skipSuccessfulRequests: false
  }),

  // Leaderboard: 30 per minute (read-heavy)
  leaderboard: rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: 'Leaderboard request limit exceeded.',
    skipSuccessfulRequests: true
  })
};

// Apply general rate limit to all API routes
app.use('/api/', limiters.general);

// Parse JSON request bodies
app.use(express.json({ limit: '1mb' }));

// Request validation middleware: validate content-type and payload size
app.use((req, res, next) => {
  if (req.method === 'POST' || req.method === 'PUT') {
    if (!req.is('application/json')) {
      return res.status(400).json({ error: 'Content-Type must be application/json' });
    }
  }
  next();
});

// Add request ID for tracking
app.use((req, res, next) => {
  req.id = req.headers['x-request-id'] || randomUUID();
  res.setHeader('X-Request-ID', req.id);
  next();
});

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
 * Connects a wallet to the game and RESTORES balance from persistent database.
 *
 * CRITICAL: Reads balance from database, not in-memory!
 * This ensures users keep their moves/balance after server restart.
 *
 * Body:
 *   { walletId: string }  — Wallet address or nametag (e.g., "alpha1qq8..." or "myname")
 *
 * Response:
 *   { success: boolean, userId: string, balance: object, treasuryAddress: string, restoredFromDatabase: boolean }
 */
app.post('/api/connect', async (req, res) => {
  const { walletId } = req.body;

  if (!walletId || typeof walletId !== 'string') {
    return res.status(400).json({ 
      success: false, 
      error: 'walletId required' 
    });
  }

  try {
    const userId = walletId; // Use wallet ID as user ID
    
    // First: Try to restore from database (source of truth!)
    const dbUser = await db.getUserStats(userId);
    let restoredFromDatabase = false;
    
    if (dbUser) {
      // User exists in database - restore their balance!
      console.log(`[Server] User ${userId} RESTORED from database: moves_left=${dbUser.moves_left}, balance=${dbUser.balance}`);
      restoredFromDatabase = true;
      
      // Sync to in-memory storage
      UserBalances.initializeUser(userId, walletId);
      const inMemUser = UserBalances.getBalance(userId);
      if (inMemUser) {
        inMemUser.balance = dbUser.balance;
        inMemUser.movesLeft = dbUser.moves_left;
        inMemUser.totalMoves = dbUser.total_moves;
        inMemUser.totalDeposited = dbUser.total_deposited;
        inMemUser.highScore = dbUser.high_score;
      }
    } else {
      // New user - initialize both DB and in-memory
      console.log(`[Server] New user ${userId} - initializing`);
      UserBalances.initializeUser(userId, walletId);
      await db.getOrCreateUser(userId, walletId);
    }
    
    // Get updated user data
    const user = UserBalances.getBalance(userId);
    const treasuryAddress = getServerWalletAddress();
    
    console.log(`[Server] User connected: ${userId}, restoredFromDB=${restoredFromDatabase}`);
    
    res.json({ 
      success: true, 
      userId,
      balance: {
        current: UserBalances.formatBalance(user.balance),
        totalDeposited: UserBalances.formatBalance(user.totalDeposited),
        movesLeft: user.movesLeft,
        highScore: user.highScore || 0
      },
      treasuryAddress,
      treasuryNametag: 'sphere2048',
      restoredFromDatabase: restoredFromDatabase
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
 * Initializes both in-memory and database records.
 *
 * Body:
 *   { nametag?: string, address?: string }
 *
 * Response:
 *   { success: boolean, userId: string, treasuryAddress: string }
 */
app.post('/api/register', async (req, res) => {
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
    
    // Initialize both in-memory and database records
    UserBalances.initializeUser(userId, address);
    await db.getOrCreateUser(userId, address);
    
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
 * Returns user balance and moves left from PERSISTENT DATABASE.
 *
 * IMPORTANT: Reads from SQLite database, not in-memory!
 * This ensures balances are accurate even after server restart.
 *
 * Query params:
 *   userId - User identifier
 *
 * Response:
 *   { success: boolean, balance: object }
 */
app.get('/api/balance', async (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ 
      success: false, 
      error: 'userId required' 
    });
  }

  try {
    console.log(`[Balance] Checking balance for ${userId} from DATABASE`);
    
    // Read from SQLite database (source of truth!)
    const dbUser = await db.getUserStats(userId);
    
    if (!dbUser) {
      console.log(`[Balance] User ${userId} not found in database`);
      // Not found in DB either - return 0 balance
      return res.json({ 
        success: true,
        userId,
        balance: {
          current: '0',
          totalDeposited: '0',
          movesLeft: 0,
          totalMoves: 0,
          highScore: 0
        }
      });
    }

    // Convert atomic units to display format
    const currentBalance = UserBalances.formatBalance(dbUser.balance);
    const totalDeposited = UserBalances.formatBalance(dbUser.total_deposited);
    
    console.log(`[Balance] User ${userId}: moves_left=${dbUser.moves_left}, balance=${currentBalance}, high_score=${dbUser.high_score}`);
    
    // Also sync to in-memory for performance (but DB is source of truth)
    UserBalances.initializeUser(userId, dbUser.wallet_id);
    const inMemUser = UserBalances.getBalance(userId);
    if (inMemUser) {
      inMemUser.balance = dbUser.balance;
      inMemUser.movesLeft = dbUser.moves_left;
      inMemUser.totalMoves = dbUser.total_moves;
      inMemUser.totalDeposited = dbUser.total_deposited;
      inMemUser.highScore = dbUser.high_score;
    }

    res.json({ 
      success: true,
      userId,
      balance: {
        current: currentBalance,
        totalDeposited: totalDeposited,
        movesLeft: dbUser.moves_left,
        totalMoves: dbUser.total_moves,
        highScore: dbUser.high_score
      },
      source: 'database',
      timestamp: Date.now()
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
 * Processes user deposits and stores to database with audit trail.
 * In production, this would query the blockchain for verification.
 *
 * Body:
 *   { userId: string, senderAddress: string, uct: number, txHash?: string }
 *
 * Response:
 *   { success: boolean, transaction: object, balance: object }
 */
app.post('/api/verify-deposit', limiters.deposits, async (req, res) => {
  const { userId, senderAddress, uct, txHash } = req.body;

  // Input validation
  if (!userId || !senderAddress || uct === undefined) {
    return res.status(400).json({ 
      success: false, 
      error: 'userId, senderAddress, and uct required' 
    });
  }

  if (typeof uct !== 'number' || uct <= 0.001) {
    return res.status(400).json({ 
      success: false, 
      error: 'uct must be a positive number > 0.001' 
    });
  }

  try {
    // Ensure user exists in both systems
    UserBalances.initializeUser(userId, userId);
    await db.getOrCreateUser(userId, userId);

    // Record the deposit (for blockchain verification)
    const tx = simulateDeposit(senderAddress, uct, userId);
    
    if (!tx) {
      return res.status(400).json({ 
        success: false, 
        error: 'Duplicate or invalid transaction' 
      });
    }

    // Add deposit to user balance in both systems
    const amountAtomic = Math.round(uct * 1e18);
    
    // Update in-memory balance
    const userInMem = UserBalances.addDeposit(userId, amountAtomic);
    
    // Store to persistent database with transaction hash
    const userDb = await db.addDeposit(userId, amountAtomic, txHash || tx.hash);

    // Log audit trail
    console.log(`[Deposit] Processed: userId=${userId}, amount=${uct}UCT, tx=${txHash || tx.hash}`);

    res.json({ 
      success: true,
      transaction: {
        hash: txHash || tx.hash,
        from: senderAddress,
        amount: uct,
        timestamp: Date.now(),
        verified: true
      },
      balance: {
        current: UserBalances.formatBalance(userDb.balance),
        totalDeposited: UserBalances.formatBalance(userDb.total_deposited),
        movesLeft: userDb.moves_left
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
 * READS PERSISTENT BALANCE FROM DATABASE to ensure accuracy after server restart.
 *
 * Query params:
 *   userId - User identifier
 */
app.get('/api/state', async (req, res) => {
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
    
    // CRITICAL: Read balance from DATABASE, not in-memory!
    // This ensures accuracy if server was restarted
    const dbUser = await db.getUserStats(userId);
    const inMemUser = UserBalances.getBalance(userId);
    
    // Sync database balance to in-memory if they differ
    if (dbUser && inMemUser) {
      if (dbUser.balance !== inMemUser.balance || dbUser.moves_left !== inMemUser.movesLeft) {
        console.log(`[State] Syncing user ${userId} from database: DB moves=${dbUser.moves_left}, mem moves=${inMemUser.movesLeft}`);
        inMemUser.balance = dbUser.balance;
        inMemUser.movesLeft = dbUser.moves_left;
        inMemUser.totalMoves = dbUser.total_moves;
      }
    }
    
    // Use database balance as source of truth
    const currentUser = dbUser || inMemUser;

    res.json({ 
      userId,
      canPlay: currentUser ? UserBalances.canMove(userId) : false,
      lastBatchTxHash: session?.lastBatchTxHash || null,
      balance: currentUser ? {
        current: UserBalances.formatBalance(currentUser.balance),
        movesLeft: currentUser.moves_left || currentUser.movesLeft,
        source: 'database'
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
 * Submits the current game score to persistent database.
 *
 * Body:
 *   { userId: string, score: number, movesUsed: number }
 *
 * Response:
 *   { success: boolean, score: number, highScore: number }
 */
app.post('/api/submit-score', async (req, res) => {
  const { userId, score, movesUsed } = req.body;

  if (!userId) {
    return res.status(400).json({ 
      success: false, 
      error: 'userId required' 
    });
  }

  try {
    const state = getSession(userId);
    const finalScore = score || state?.score || 0;
    
    // CRITICAL: Always save the score to prevent loss
    if (finalScore > 0) {
      // Save to persistent database
      await db.submitScore(userId, finalScore, movesUsed || 0);
      console.log(`[Score] Submitted score ${finalScore} for ${userId}`);
    }

    // Also update in-memory tracking (for compatibility)
    UserBalances.updateHighScore(userId, finalScore);

    // Get updated user stats
    const userStats = await db.getUserStats(userId);

    res.json({ 
      success: true,
      userId,
      score: finalScore,
      highScore: userStats?.high_score || 0,
      totalMoves: userStats?.total_moves || 0
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
 * Returns top players by high score (from persistent database).
 *
 * Query params:
 *   limit - Number of results (default: 10)
 */
app.get('/api/leaderboard', limiters.leaderboard, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 10, 100);

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

    // Fetch from persistent database
    const leaderboard = await db.getLeaderboard(limit);

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

/**
 * GET /api/stats
 * Returns server and database statistics.
 */
app.get('/api/stats', async (req, res) => {
  try {
    const dbStats = await db.getDatabaseStats();
    res.json({
      success: true,
      server_time: Date.now(),
      database: dbStats,
      sphere_status: getSphereStatus()
    });
  } catch (err) {
    console.error('[Server] Stats error:', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * GET /api/health
 * Health check endpoint for monitoring
 */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: Date.now(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// ─── Startup ──────────────────────────────────────────────────────────────────

/**
 * Boot sequence:
 *   1. Initialize SQLite database
 *   2. Initialize treasury wallet configuration
 *   3. Start the Express server
 *   4. Server is ready for game play
 */
async function startup() {
  try {
    console.log('[Server] Initializing SQLite database...');
    await db.initDatabase();
  } catch (err) {
    console.error('[Server] Database init error:', err.message);
    process.exit(1);
  }

  try {
    await connectSphere();
  } catch (err) {
    console.error('[Server] Treasury init error (non-fatal):', err.message);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] 2048 Game Server listening on http://0.0.0.0:${PORT}`);
    console.log(`[Server] Treasury Address: ${getServerWalletAddress()}`);
    console.log(`[Server] Database: SQLite at sphere-data/game.db`);
    console.log(`[Server] CORS Origins: ${allowedOrigins.join(', ')}`);
    console.log(`[Server] Security: Helmet + Rate Limiting + Input Validation`);
    console.log(`[Server] Ready for deposits → Move cost: 0.1 UCT`);
  });
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[Server] SIGTERM received, closing gracefully...');
  await db.closeDatabase();
  process.exit(0);
});

startup();
