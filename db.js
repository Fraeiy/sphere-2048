/**
 * db.js — SQLite Database Module
 *
 * Manages all persistent data storage:
 *   • User balances and wallets
 *   • Game scores and leaderboards
 *   • Deposit history for audit trails
 *   • Move transactions for blockchain batching
 *
 * Database schema includes:
 *   1. users — User accounts, wallet mappings, balance tracking
 *   2. scores — Historical game scores with timestamps
 *   3. deposits — Deposit transaction log with verification status
 *   4. moves — Move transactions for blockchain submission batching
 */

import sqlite3 from 'sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, 'sphere-data', 'game.db');

let db = null;

/**
 * Initialize database connection and create tables if needed
 * @returns {Promise<void>}
 */
export async function initDatabase() {
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        console.error('[DB] Connection error:', err);
        reject(err);
        return;
      }
      console.log(`[DB] Connected to SQLite at ${DB_PATH}`);
      createTables()
        .then(() => resolve())
        .catch(reject);
    });
  });
}

/**
 * Execute a database query (no return value)
 * @param {string} sql - SQL statement
 * @param {any[]} params - Query parameters
 * @returns {Promise<void>}
 */
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (!db) {
      reject(new Error('Database not initialized'));
      return;
    }
    db.run(sql, params, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Execute a query and return a single row
 * @param {string} sql - SQL statement
 * @param {any[]} params - Query parameters
 * @returns {Promise<object|undefined>}
 */
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (!db) {
      reject(new Error('Database not initialized'));
      return;
    }
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

/**
 * Execute a query and return all rows
 * @param {string} sql - SQL statement
 * @param {any[]} params - Query parameters
 * @returns {Promise<object[]>}
 */
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (!db) {
      reject(new Error('Database not initialized'));
      return;
    }
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

/**
 * Create database tables if they don't exist
 * @returns {Promise<void>}
 */
async function createTables() {
  // Users table: wallet identity and balance tracking
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT UNIQUE NOT NULL,
      wallet_id TEXT,
      balance INTEGER DEFAULT 0,
      total_deposited INTEGER DEFAULT 0,
      moves_left INTEGER DEFAULT 0,
      total_moves INTEGER DEFAULT 0,
      high_score INTEGER DEFAULT 0,
      last_move INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Scores table: game score history with player stats
  await run(`
    CREATE TABLE IF NOT EXISTS scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      wallet_id TEXT,
      score INTEGER NOT NULL,
      moves_used INTEGER,
      game_duration INTEGER,
      timestamp INTEGER NOT NULL,
      submitted_to_chain INTEGER DEFAULT 0,
      tx_hash TEXT,
      FOREIGN KEY (user_id) REFERENCES users(user_id)
    )
  `);

  // Deposits table: audit trail for all deposits
  await run(`
    CREATE TABLE IF NOT EXISTS deposits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      wallet_id TEXT,
      amount INTEGER NOT NULL,
      coin_id TEXT DEFAULT 'UCT',
      tx_hash TEXT,
      verified INTEGER DEFAULT 0,
      deposit_date INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(user_id)
    )
  `);

  // Moves table: transaction history for blockchain batching
  await run(`
    CREATE TABLE IF NOT EXISTS moves (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      move_number INTEGER,
      direction TEXT,
      score_after INTEGER,
      game_id TEXT,
      batch_hash TEXT,
      submitted_to_chain INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(user_id)
    )
  `);

  // Create indexes for common queries
  await run(`CREATE INDEX IF NOT EXISTS idx_users_wallet ON users(wallet_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_scores_user ON scores(user_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_scores_timestamp ON scores(timestamp DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_deposits_user ON deposits(user_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_moves_user ON moves(user_id)`);

  console.log('[DB] Tables initialized');
}

/**
 * Get or create a user record
 * @param {string} userId - User identifier
 * @param {string} walletId - Wallet address or nametag
 * @returns {Promise<object>}
 */
export async function getOrCreateUser(userId, walletId = null) {
  let user = await get('SELECT * FROM users WHERE user_id = ?', [userId]);

  if (!user) {
    const now = Date.now();
    await run(
      `INSERT INTO users (user_id, wallet_id, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
      [userId, walletId, now, now]
    );
    user = await get('SELECT * FROM users WHERE user_id = ?', [userId]);
  } else if (walletId && user.wallet_id !== walletId) {
    // Update wallet_id if provided and different
    await run(
      'UPDATE users SET wallet_id = ?, updated_at = ? WHERE user_id = ?',
      [walletId, Date.now(), userId]
    );
    user.wallet_id = walletId;
  }

  return user;
}

/**
 * Add a deposit to user account
 * @param {string} userId - User identifier
 * @param {number} amount - Amount in atomic units
 * @param {string} txHash - Transaction hash
 * @returns {Promise<object>} Updated user record
 */
export async function addDeposit(userId, amount, txHash = null) {
  const user = await getOrCreateUser(userId);
  const now = Date.now();

  // Update user balance
  const newBalance = user.balance + amount;
  const newMovesLeft = user.moves_left + Math.floor(amount / (0.1 * 1e18)); // 0.1 UCT per move

  await run(
    `UPDATE users 
     SET balance = ?, total_deposited = ?, moves_left = ?, updated_at = ?
     WHERE user_id = ?`,
    [newBalance, user.total_deposited + amount, newMovesLeft, now, userId]
  );

  // Log deposit transaction
  await run(
    `INSERT INTO deposits (user_id, wallet_id, amount, tx_hash, deposit_date, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, user.wallet_id, amount, txHash, now, now]
  );

  console.log(`[DB] Deposit: ${userId} +${amount} (${newMovesLeft} moves)`);

  return getOrCreateUser(userId);
}

/**
 * Deduct move cost from user balance
 * @param {string} userId - User identifier
 * @returns {Promise<boolean>} true if successful, false if insufficient balance
 */
export async function deductMove(userId) {
  const user = await getOrCreateUser(userId);
  const MOVE_COST_ATOMIC = Math.round(0.1 * 1e18); // 0.1 UCT

  if (user.moves_left <= 0) {
    return false;
  }

  const now = Date.now();
  await run(
    `UPDATE users 
     SET moves_left = moves_left - 1, total_moves = total_moves + 1, last_move = ?, updated_at = ?
     WHERE user_id = ?`,
    [now, now, userId]
  );

  console.log(`[DB] Move deducted: ${userId} (moves_left: ${user.moves_left - 1})`);
  return true;
}

/**
 * Submit a score to the database
 * @param {string} userId - User identifier
 * @param {number} score - Game score
 * @param {number} movesUsed - Number of moves made
 * @returns {Promise<object>} Score record
 */
export async function submitScore(userId, score, movesUsed = 0) {
  const user = await getOrCreateUser(userId);
  const now = Date.now();

  // Update high score if applicable
  if (score > user.high_score) {
    await run(
      'UPDATE users SET high_score = ?, updated_at = ? WHERE user_id = ?',
      [score, now, userId]
    );
  }

  // Insert score record
  await run(
    `INSERT INTO scores (user_id, wallet_id, score, moves_used, timestamp)
     VALUES (?, ?, ?, ?, ?)`,
    [userId, user.wallet_id, score, movesUsed, now]
  );

  console.log(`[DB] Score submitted: ${userId} → ${score}`);

  return { user_id: userId, score, moves_used: movesUsed, timestamp: now };
}

/**
 * Get user's high score and stats
 * @param {string} userId - User identifier
 * @returns {Promise<object|null>}
 */
export async function getUserStats(userId) {
  const user = await get('SELECT * FROM users WHERE user_id = ?', [userId]);

  if (!user) {
    return null;
  }

  const scores = await all(
    'SELECT score, timestamp FROM scores WHERE user_id = ? ORDER BY timestamp DESC LIMIT 10',
    [userId]
  );

  return {
    user_id: user.user_id,
    wallet_id: user.wallet_id,
    balance: user.balance,
    moves_left: user.moves_left,
    high_score: user.high_score,
    total_moves: user.total_moves,
    total_deposited: user.total_deposited,
    recent_scores: scores,
    created_at: user.created_at,
    updated_at: user.updated_at
  };
}

/**
 * Get leaderboard (top scores)
 * @param {number} limit - Number of results
 * @returns {Promise<object[]>}
 */
export async function getLeaderboard(limit = 10) {
  const leaderboard = await all(
    `SELECT 
       users.user_id,
       users.wallet_id,
       users.high_score,
       users.total_moves,
       COUNT(scores.id) as game_count,
       AVG(scores.score) as avg_score
     FROM users
     LEFT JOIN scores ON users.user_id = scores.user_id
     ORDER BY users.high_score DESC, users.total_moves DESC
     LIMIT ?`,
    [limit]
  );

  return leaderboard.map((row, index) => ({
    rank: index + 1,
    wallet_id: row.wallet_id || row.user_id,
    high_score: row.high_score,
    total_moves: row.total_moves,
    game_count: row.game_count || 0,
    avg_score: row.avg_score ? Math.round(row.avg_score) : 0
  }));
}

/**
 * Record a move transaction for blockchain batching
 * @param {string} userId - User identifier
 * @param {number} moveNumber - Move sequence number
 * @param {string} direction - Move direction (up, down, left, right)
 * @param {number} scoreAfter - Score after move
 * @param {string} gameId - Game identifier
 * @returns {Promise<object>}
 */
export async function recordMove(userId, moveNumber, direction, scoreAfter, gameId = null) {
  const now = Date.now();

  await run(
    `INSERT INTO moves (user_id, move_number, direction, score_after, game_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, moveNumber, direction, scoreAfter, gameId, now]
  );

  return { user_id: userId, move_number: moveNumber, direction, score_after: scoreAfter };
}

/**
 * Get user's deposit history
 * @param {string} userId - User identifier
 * @returns {Promise<object[]>}
 */
export async function getDepositHistory(userId, limit = 50) {
  return all(
    `SELECT * FROM deposits WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    [userId, limit]
  );
}

/**
 * Get recent scores for a user
 * @param {string} userId - User identifier
 * @param {number} limit - Number of results
 * @returns {Promise<object[]>}
 */
export async function getRecentScores(userId, limit = 10) {
  return all(
    `SELECT * FROM scores WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?`,
    [userId, limit]
  );
}

/**
 * Close database connection
 * @returns {Promise<void>}
 */
export async function closeDatabase() {
  return new Promise((resolve, reject) => {
    if (db) {
      db.close((err) => {
        if (err) reject(err);
        else {
          console.log('[DB] Connection closed');
          resolve();
        }
      });
    } else {
      resolve();
    }
  });
}

/**
 * Get database statistics
 * @returns {Promise<object>}
 */
export async function getDatabaseStats() {
  const [userCount, scoreCount, depositCount] = await Promise.all([
    get('SELECT COUNT(*) as count FROM users'),
    get('SELECT COUNT(*) as count FROM scores'),
    get('SELECT COUNT(*) as count FROM deposits')
  ]);

  return {
    total_users: userCount?.count || 0,
    total_scores: scoreCount?.count || 0,
    total_deposits: depositCount?.count || 0,
    db_path: DB_PATH
  };
}
