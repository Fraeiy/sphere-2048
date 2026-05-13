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

// Conditional import: use Redis in production (if REDIS_URL set), SQLite locally
const dbPath = process.env.REDIS_URL ? './db-redis.js' : './db.js';
const db = await import(dbPath);

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
  // Sphere wallet popup flow requires opener relationship to remain intact.
  // COOP/COEP defaults can isolate browsing context and break popup detection.
  crossOriginOpenerPolicy: false,
  crossOriginEmbedderPolicy: false,
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

// Keep wallet popups in the same browsing context group so Sphere can detect opener.
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
  res.removeHeader('Cross-Origin-Embedder-Policy');
  next();
});

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

// Input validation helper
function validateInput(obj, schema) {
  for (const [key, type] of Object.entries(schema)) {
    if (!(key in obj)) {
      throw new Error(`Missing required field: ${key}`);
    }
    if (typeof obj[key] !== type && (type !== 'optional' || obj[key] !== undefined)) {
      throw new Error(`Invalid type for ${key}: expected ${type}, got ${typeof obj[key]}`);
    }
  }
  return true;
}

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

/** Session cleanup: 24 hours timeout */
const SESSION_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Cleanup stale sessions periodically to prevent memory leaks
 */
function startSessionCleanup() {
  setInterval(() => {
    const now = Date.now();
    let purgedCount = 0;
    
    for (const [userId, session] of sessions.entries()) {
      if (now - session.createdAt > SESSION_TIMEOUT_MS) {
        sessions.delete(userId);
        userMoveBuffers.delete(userId);
        userBatchQueues.delete(userId);
        purgedCount++;
      }
    }
    
    if (purgedCount > 0) {
      console.log(`[Cleanup] Purged ${purgedCount} stale sessions. Active: ${sessions.size}`);
    }
  }, SESSION_CLEANUP_INTERVAL_MS);
}

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
      // Restore from database (source of truth)
      console.log(`[Server] User ${userId} RESTORED from database`);
      restoredFromDatabase = true;
      UserBalances.syncFromDatabase(userId, dbUser);
    } else {
      // New user
      console.log(`[Server] New user ${userId} - initializing`);
      UserBalances.initializeUser(userId, walletId);
      await db.getOrCreateUser(userId, walletId);
    }
    
    // Get updated user data
    const user = UserBalances.getBalance(userId);
    const moves = UserBalances.calculateMoves(user.balanceCents);
    const treasuryAddress = getServerWalletAddress();
    
    console.log(`[Server] User connected: ${userId}, balance=${UserBalances.centsToUCT(user.balanceCents)} UCT, moves=${moves}`);
    
    res.json({ 
      success: true, 
      userId,
      balance: {
        current: UserBalances.centsToUCT(user.balanceCents),
        totalDeposited: UserBalances.centsToUCT(user.totalDepositedCents),
        movesLeft: moves,
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
 * Deduplicates user initialization by checking DB first.
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
    const userId = nametag || address;
    
    // Check if user already exists in DB (deduplication)
    let existingUser = await db.getUserStats(userId);
    
    if (!existingUser) {
      // Only create if not found
      await db.getOrCreateUser(userId, address);
    }
    
    // Initialize in-memory (idempotent)
    UserBalances.initializeUser(userId, address);
    
    // Sync existing DB data to memory if they diverge
    if (existingUser) {
      const inMem = UserBalances.getBalance(userId);
      if (inMem) {
        inMem.balance = existingUser.balance;
        inMem.movesLeft = existingUser.moves_left;
        inMem.totalDeposited = existingUser.total_deposited;
      }
    }
    
    const treasuryAddress = getServerWalletAddress();
    
    console.log(`[Server] Player registered: ${userId} (existing=${!!existingUser})`);
    
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

    // Sync from DB to in-memory
    const user = UserBalances.syncFromDatabase(userId, dbUser);
    const moves = UserBalances.calculateMoves(user.balanceCents);
    
    console.log(`[Balance] User ${userId}: ${UserBalances.centsToUCT(user.balanceCents)} UCT, ${moves} moves, high_score=${user.highScore}`);

    res.json({ 
      success: true,
      userId,
      balance: {
        current: UserBalances.centsToUCT(user.balanceCents),
        totalDeposited: UserBalances.centsToUCT(user.totalDepositedCents),
        movesLeft: moves,
        totalMoves: user.totalMovesMade,
        highScore: user.highScore
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

    // Add deposit to user balance
    const amountAtomic = Math.round(uct * 1e18);
    const moveCredits = Math.max(0, Math.floor(uct * 10));
    
    // Update in-memory first
    const userInMem = UserBalances.addDepositAtomic(userId, amountAtomic);
    
    // Persist to database
    const userDb = await db.addDeposit(userId, amountAtomic, txHash || tx.hash, moveCredits);

    // Log audit trail
    const moves = UserBalances.calculateMoves(userInMem.balanceCents);
    console.log(`[Deposit] Processed: userId=${userId}, +${uct} UCT, tx=${txHash || tx.hash}, moves=${moves}`);

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
        current: UserBalances.centsToUCT(userInMem.balanceCents),
        totalDeposited: UserBalances.centsToUCT(userInMem.totalDepositedCents),
        movesLeft: moves
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
app.post('/api/test-deposit', async (req, res) => {
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
    await db.getOrCreateUser(userId, userId);
    UserBalances.initializeUser(userId, userId);

    // Add test deposit
    const amountAtomic = Math.round(uct * 1e18);
    const moveCredits = Math.max(0, Math.floor(uct * 10));
    const user = UserBalances.addDepositAtomic(userId, amountAtomic);

    // Persist to database
    await db.addDeposit(userId, amountAtomic, `test-deposit-${Date.now()}`, moveCredits);

    const moves = UserBalances.calculateMoves(user.balanceCents);
    console.log(`[TestDeposit] Credited ${uct} UCT to ${userId}, now has ${moves} moves`);

    res.json({ 
      success: true,
      balance: {
        current: UserBalances.centsToUCT(user.balanceCents),
        totalDeposited: UserBalances.centsToUCT(user.totalDepositedCents),
        movesLeft: moves,
        totalMoves: user.totalMovesMade
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
    
    // Read from database (source of truth)
    const dbUser = await db.getUserStats(userId);
    
    if (dbUser) {
      // Sync DB state to in-memory
      UserBalances.syncFromDatabase(userId, dbUser);
    } else {
      // User has no DB record yet, use in-memory
      UserBalances.initializeUser(userId, userId);
    }
    
    const user = UserBalances.getBalance(userId);
    const moves = UserBalances.calculateMoves(user.balanceCents);

    res.json({ 
      userId,
      canPlay: moves > 0,
      lastBatchTxHash: session?.lastBatchTxHash || null,
      balance: {
        current: UserBalances.centsToUCT(user.balanceCents),
        movesLeft: moves,
        source: 'database'
      },
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
 * ATOMIC: DB update MUST succeed before response is sent.
 *
 * Body:
 *   { userId: string, direction: 'left' | 'right' | 'up' | 'down' }
 *
 * Response:
 *   { success: boolean, moved: boolean, balance?: object, ...gameState }
 */
app.post('/api/move', limiters.moves, async (req, res) => {
  const { userId, direction } = req.body;

  if (!userId || typeof userId !== 'string') {
    return res.status(400).json({ 
      success: false, 
      error: 'Invalid userId' 
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
    // ATOMIC TRANSACTION: All-or-nothing move processing
    // 1. Check balance
    if (!UserBalances.canMove(userId)) {
      const user = UserBalances.getBalance(userId);
      return res.status(402).json({ 
        success: false,
        error: 'NO_MOVES',
        errorMessage: 'Insufficient moves. Please deposit more tokens to continue.',
        canPlay: false
      });
    }

    // 2. Pre-validate: Ensure DB is accessible before proceeding
    const preCheckDb = await db.getUserStats(userId);
    if (!preCheckDb || preCheckDb.balance < 100000000000000000) { // < 0.1 UCT
      return res.status(402).json({ 
        success: false,
        error: 'NO_MOVES',
        errorMessage: 'No moves available',
        canPlay: false
      });
    }

    // 3. CRITICAL: Update DB FIRST (DB is source of truth)
    let dbMoveResult;
    try {
      // Pass direction for audit trail, score will be logged after game logic executes
      dbMoveResult = await db.deductMove(userId, direction, 0);
    } catch (dbErr) {
      console.error(`[Move] DB deduction failed for ${userId}:`, dbErr.message);
      // DB failed - abort before touching in-memory state
      return res.status(503).json({
        success: false,
        error: 'MOVE_SYNC_ERROR',
        errorMessage: 'Temporary sync issue. Please retry your move.',
        canPlay: true
      });
    }

    if (!dbMoveResult || dbMoveResult.balance < 0) {
      console.error(`[Move] DB returned invalid state for ${userId}`);
      return res.status(503).json({
        success: false,
        error: 'MOVE_INTEGRITY_ERROR',
        errorMessage: 'Invalid game state. Please refresh.',
        canPlay: false
      });
    }

    // 4. NOW sync in-memory to match DB
    UserBalances.syncFromDatabase(userId, dbMoveResult);

    // 5. Apply move to game logic
    const state = getSession(userId);
    const moved = state.move(direction);

    // Update high score
    if (state.score > (userBestScores.get(userId) ?? 0)) {
      userBestScores.set(userId, state.score);
    }
    UserBalances.updateHighScore(userId, state.score);

    // Get updated user record for batch tracking
    const userAfterMove = UserBalances.getBalance(userId);

    // Track move for batch submission
    const moveBuffer = pushMoveForBatch(userId, {
      moveNo: userAfterMove?.totalMovesMade ?? Date.now(),
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

      userMoveBuffers.set(userId, moveBuffer.slice(MOVE_BATCH_SIZE));
      enqueueMoveBatch(userId, payload);

      batchTx = {
        queued: true,
        moveHash,
        count: batchMoves.length,
      };
    }

    const user = UserBalances.getBalance(userId);
    const movesRemaining = UserBalances.calculateMoves(user?.balanceCents || 0);

    res.json({ 
      success: true,
      userId,
      moved,
      canPlay: movesRemaining > 0,
      balance: {
        current: UserBalances.centsToUCT(user?.balanceCents || 0),
        movesLeft: movesRemaining
      },
      moveBatch: batchTx,
      ...state.toJSON() 
    });
  } catch (err) {
    console.error('[Move] Unhandled error:', err);
    res.status(500).json({ 
      success: false, 
      error: 'MOVE_ERROR',
      errorMessage: 'Failed to process move'
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
    if (
      leaderboardCache.data 
      && Array.isArray(leaderboardCache.data)
      && leaderboardCache.data.length > 0
      && (now - leaderboardCache.timestamp) < leaderboardCache.ttl
    ) {
      return res.json({ 
        success: true,
        leaderboard: leaderboardCache.data.slice(0, limit),
        cached: true,
        timestamp: leaderboardCache.timestamp
      });
    }

    // Fetch from persistent database
    const leaderboard = await db.getLeaderboard(limit);
    
    // Validate leaderboard data is an array
    if (!Array.isArray(leaderboard)) {
      console.error('[Leaderboard] DB returned non-array:', typeof leaderboard);
      return res.status(500).json({ 
        success: false, 
        error: 'Invalid leaderboard data from database'
      });
    }

    leaderboardCache.data = leaderboard;
    leaderboardCache.timestamp = now;

    res.json({ 
      success: true,
      leaderboard,
      cached: false,
      timestamp: now
    });
  } catch (err) {
    console.error('[Server] Leaderboard error:', err);
    // Return stale cache on error if available
    if (Array.isArray(leaderboardCache.data) && leaderboardCache.data.length > 0) {
      console.log('[Leaderboard] Returning stale cache due to error');
      return res.json({
        success: true,
        leaderboard: leaderboardCache.data.slice(0, limit),
        cached: true,
        stale: true
      });
    }
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

/**
 * GET /api/balance-audit
 * Verifies user balance by recalculating from deposit and move history
 * Ensures balance hasn't been corrupted or tampered with
 *
 * Query: userId (required)
 * Response: {
 *   isValid: boolean,
 *   storedBalance: number (atomic units),
 *   calculatedBalance: number (atomic units),
 *   discrepancy: number,
 *   deposits: { count, total, totalUCT },
 *   moves: { count, totalSpent, totalSpentUCT },
 *   audit: { passes all checks } | { has discrepancy }
 * }
 */
app.get('/api/balance-audit', async (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({
      success: false,
      error: 'userId required'
    });
  }

  try {
    const audit = await db.verifyBalanceFromHistory(userId);
    const balanceStatus = audit.isValid ? 'VALID' : 'MISMATCH';
    
    res.json({
      success: true,
      userId,
      audit: balanceStatus,
      stored: {
        balance: audit.storedBalance,
        balanceUCT: (audit.storedBalance / 1e18).toFixed(6),
        balanceCents: Math.round(audit.storedBalance / 1e16)
      },
      calculated: {
        balance: audit.calculatedBalance,
        balanceUCT: (audit.calculatedBalance / 1e18).toFixed(6),
        balanceCents: Math.round(audit.calculatedBalance / 1e16)
      },
      discrepancy: audit.discrepancy,
      deposits: {
        count: audit.depositRecords,
        total: audit.totalDeposited,
        totalUCT: audit.totalDepositsUCT
      },
      moves: {
        count: audit.moveCount,
        totalSpent: audit.totalSpent,
        totalSpentUCT: audit.totalSpentUCT
      }
    });
  } catch (err) {
    console.error('[Audit] Balance check error:', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * GET /api/deposit-history
 * Returns full deposit and move transaction history for audit purposes
 *
 * Query: userId (required), includePayload (optional, default: false)
 * Response: {
 *   deposits: [ { id, amount, amountUCT, txHash, verified, date } ],
 *   moves: [ { moveNumber, direction, scoreAfter, date } ]
 * }
 */
app.get('/api/deposit-history', async (req, res) => {
  const { userId, includePayload } = req.query;

  if (!userId) {
    return res.status(400).json({
      success: false,
      error: 'userId required'
    });
  }

  try {
    const deposits = await db.getDepositHistory(userId);
    const moves = await db.getMoveHistory(userId, includePayload ? 500 : 50);

    const depositSummary = {
      count: deposits.length,
      totalUCT: deposits.reduce((sum, d) => sum + parseFloat(d.amountUCT), 0).toFixed(6),
      verifiedCount: deposits.filter(d => d.verified).length
    };

    res.json({
      success: true,
      userId,
      summary: {
        deposits: depositSummary,
        moves: {
          count: moves.length,
          avgScorePerMove: moves.length > 0 
            ? (moves.reduce((sum, m) => sum + m.scoreAfter, 0) / moves.length).toFixed(2)
            : 0
        }
      },
      data: includePayload ? { deposits, moves } : undefined,
      depositsCount: deposits.length,
      movesCount: moves.length
    });
  } catch (err) {
    console.error('[History] Fetch error:', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// ─── Startup ──────────────────────────────────────────────────────────────────

/**
 * Boot sequence:
 *   1. Start session cleanup loop
 *   2. Initialize SQLite database
 *   3. Initialize treasury wallet configuration
 *   4. Start the Express server
 *   5. Server is ready for game play
 */
async function startup() {
  startSessionCleanup();
  try {
    console.log('[Server] Initializing SQLite database...');
    await db.initDatabase();
    console.log('[Server] Database initialized successfully');
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
    const dbType = process.env.REDIS_URL ? 'Redis' : 'SQLite';
    const dbLocation = process.env.REDIS_URL ? 'Remote' : 'sphere-data/game.db';
    console.log(`[Server] Database: ${dbType} at ${dbLocation}`);
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
