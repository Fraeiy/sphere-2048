/**
 * db-redis.js — Redis Database Module
 *
 * Provides persistent data storage using Redis (for production/Vercel)
 * Falls back to in-memory Map when Redis is unavailable (local development)
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ PRODUCTION: Redis (persistent across requests/restarts)         │
 * │ DEVELOPMENT: In-memory Map (SQLite db.js preferred instead)     │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * API matches db.js exactly for seamless import switching.
 */

import { createClient } from 'redis';

// ─── Configuration ────────────────────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL || '';
const USE_REDIS = !!REDIS_URL;
const IN_MEMORY = !USE_REDIS;

// In-memory fallback storage (Map format for fast lookups)
const inMemoryStore = new Map();

// Redis client (initialized on demand)
let redisClient = null;

// ─── Initialization ───────────────────────────────────────────────────────────

export async function initDatabase() {
  if (USE_REDIS) {
    try {
      redisClient = createClient({ url: REDIS_URL });
      redisClient.on('error', (err) => console.error('[DB] Redis error:', err));
      
      await redisClient.connect();
      await redisClient.ping();
      
      console.log('[DB] ✅ Connected to Redis');
      return true;
    } catch (err) {
      console.warn('[DB] ⚠️  Redis connection failed, using in-memory storage:', err.message);
      redisClient = null;
    }
  }
  
  if (IN_MEMORY) {
    console.log('[DB] Using in-memory storage (NOT PERSISTENT - local dev only)');
  }
}

export async function closeDatabase() {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}

// ─── User Data ────────────────────────────────────────────────────────────────

/**
 * Get or create a user record.
 * @param {string} userId - User identifier (wallet address, account ID, etc.)
 * @param {string} walletId - Optional wallet identifier
 * @returns {Object} User data {userId, walletId, balance, moves_left, high_score}
 */
export async function getOrCreateUser(userId, walletId = null) {
  const key = `user:${userId}`;
  
  if (IN_MEMORY) {
    if (!inMemoryStore.has(key)) {
      inMemoryStore.set(key, {
        userId,
        walletId: walletId || userId,
        balance: 0,
        moves_left: 0,
        high_score: 0,
        created_at: Date.now(),
        last_updated: Date.now(),
      });
    }
    return inMemoryStore.get(key);
  }
  
  // Redis mode
  try {
    const existing = await redisClient.get(key);
    
    if (existing) {
      return JSON.parse(existing);
    }
    
    const userData = {
      userId,
      walletId: walletId || userId,
      balance: 0,
      moves_left: 0,
      high_score: 0,
      created_at: Date.now(),
      last_updated: Date.now(),
    };
    
    await redisClient.set(key, JSON.stringify(userData));
    return userData;
  } catch (err) {
    console.error('[DB] Error in getOrCreateUser:', err.message);
    throw err;
  }
}

/**
 * Get user balance and stats.
 * @param {string} userId - User identifier
 * @returns {Object} User stats {userId, balance, moves_left, high_score}
 */
export async function getUserStats(userId) {
  const key = `user:${userId}`;
  
  if (IN_MEMORY) {
    const user = inMemoryStore.get(key);
    return user || { userId, balance: 0, moves_left: 0, high_score: 0 };
  }
  
  try {
    const userJson = await redisClient.get(key);
    if (!userJson) {
      return { userId, balance: 0, moves_left: 0, high_score: 0 };
    }
    return JSON.parse(userJson);
  } catch (err) {
    console.error('[DB] Error in getUserStats:', err.message);
    throw err;
  }
}

/**
 * Add a deposit and update user balance.
 * @param {string} userId - User identifier
 * @param {number} amountAtomic - Deposit amount in atomic units (e.g., satoshis)
 * @param {string} txHash - Transaction hash
 * @returns {Object} Updated user data
 */
export async function addDeposit(userId, amountAtomic, txHash) {
  const userKey = `user:${userId}`;
  const depositKey = `deposit:${userId}:${txHash}`;
  
  if (IN_MEMORY) {
    let user = inMemoryStore.get(userKey);
    if (!user) {
      user = await getOrCreateUser(userId);
    }
    
    // Add moves: 1 move per 0.1 tokens (or 1 move minimum)
    const movesAdded = Math.max(1, Math.floor(amountAtomic / 100000)); // Assuming 1 atomic = 0.00001 units
    user.balance += amountAtomic;
    user.moves_left += movesAdded;
    user.last_updated = Date.now();
    
    inMemoryStore.set(userKey, user);
    inMemoryStore.set(depositKey, {
      userId,
      amount: amountAtomic,
      moves: movesAdded,
      tx_hash: txHash,
      timestamp: Date.now(),
    });
    
    return user;
  }
  
  // Redis mode
  try {
    let userJson = await redisClient.get(userKey);
    let user = userJson ? JSON.parse(userJson) : await getOrCreateUser(userId);
    
    const movesAdded = Math.max(1, Math.floor(amountAtomic / 100000));
    user.balance += amountAtomic;
    user.moves_left += movesAdded;
    user.last_updated = Date.now();
    
    await redisClient.set(userKey, JSON.stringify(user));
    await redisClient.set(depositKey, JSON.stringify({
      userId,
      amount: amountAtomic,
      moves: movesAdded,
      tx_hash: txHash,
      timestamp: Date.now(),
    }));
    
    return user;
  } catch (err) {
    console.error('[DB] Error in addDeposit:', err.message);
    throw err;
  }
}

/**
 * Deduct a move from user's moves_left.
 * @param {string} userId - User identifier
 * @returns {Object} Updated user data
 */
export async function deductMove(userId) {
  const userKey = `user:${userId}`;
  
  if (IN_MEMORY) {
    let user = inMemoryStore.get(userKey);
    if (!user) {
      user = await getOrCreateUser(userId);
    }
    
    if (user.moves_left > 0) {
      user.moves_left -= 1;
      user.last_updated = Date.now();
      inMemoryStore.set(userKey, user);
    }
    
    return user;
  }
  
  // Redis mode
  try {
    let userJson = await redisClient.get(userKey);
    let user = userJson ? JSON.parse(userJson) : await getOrCreateUser(userId);
    
    if (user.moves_left > 0) {
      user.moves_left -= 1;
      user.last_updated = Date.now();
      await redisClient.set(userKey, JSON.stringify(user));
    }
    
    return user;
  } catch (err) {
    console.error('[DB] Error in deductMove:', err.message);
    throw err;
  }
}

/**
 * Submit a game score.
 * @param {string} userId - User identifier
 * @param {number} score - Final score
 * @param {number} movesUsed - Number of moves used
 * @returns {Object} Score record
 */
export async function submitScore(userId, score, movesUsed = 0) {
  const scoreKey = `score:${userId}:${Date.now()}`;
  const userKey = `user:${userId}`;
  
  const scoreData = {
    userId,
    score,
    moves_used: movesUsed,
    timestamp: Date.now(),
  };
  
  if (IN_MEMORY) {
    inMemoryStore.set(scoreKey, scoreData);
    
    // Update high score if applicable
    let user = inMemoryStore.get(userKey);
    if (!user) {
      user = await getOrCreateUser(userId);
    }
    if (score > user.high_score) {
      user.high_score = score;
      user.last_updated = Date.now();
      inMemoryStore.set(userKey, user);
    }
    
    return scoreData;
  }
  
  // Redis mode
  try {
    await redisClient.set(scoreKey, JSON.stringify(scoreData));
    
    // Update high score
    let userJson = await redisClient.get(userKey);
    let user = userJson ? JSON.parse(userJson) : await getOrCreateUser(userId);
    
    if (score > user.high_score) {
      user.high_score = score;
      user.last_updated = Date.now();
      await redisClient.set(userKey, JSON.stringify(user));
    }
    
    return scoreData;
  } catch (err) {
    console.error('[DB] Error in submitScore:', err.message);
    throw err;
  }
}

/**
 * Get leaderboard (top scores).
 * @param {number} limit - Number of top scores to return
 * @returns {Array} Array of top scores [{userId, score, moves_used, timestamp}, ...]
 */
export async function getLeaderboard(limit = 10) {
  if (IN_MEMORY) {
    const scores = [];
    for (const [key, value] of inMemoryStore.entries()) {
      if (key.startsWith('score:')) {
        scores.push(value);
      }
    }
    return scores
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
  
  // Redis mode (simplified - returns recent scores)
  try {
    const keys = await redisClient.keys('score:*');
    const scores = [];
    
    for (const key of keys.slice(0, limit * 2)) {
      const scoreJson = await redisClient.get(key);
      if (scoreJson) {
        scores.push(JSON.parse(scoreJson));
      }
    }
    
    return scores
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  } catch (err) {
    console.error('[DB] Error in getLeaderboard:', err.message);
    return [];
  }
}

/**
 * Get database statistics.
 * @returns {Object} Database stats {total_users, total_deposits, total_moves, total_scores}
 */
export async function getDatabaseStats() {
  if (IN_MEMORY) {
    let totalUsers = 0;
    let totalDeposits = 0;
    let totalScores = 0;
    
    for (const key of inMemoryStore.keys()) {
      if (key.startsWith('user:')) totalUsers++;
      if (key.startsWith('deposit:')) totalDeposits++;
      if (key.startsWith('score:')) totalScores++;
    }
    
    return {
      storage_type: 'in-memory',
      total_users: totalUsers,
      total_deposits: totalDeposits,
      total_scores: totalScores,
      records_in_memory: inMemoryStore.size,
      connected: true,
    };
  }
  
  // Redis mode
  try {
    const userKeys = await redisClient.keys('user:*');
    const depositKeys = await redisClient.keys('deposit:*');
    const scoreKeys = await redisClient.keys('score:*');
    
    return {
      storage_type: 'Redis',
      total_users: userKeys.length,
      total_deposits: depositKeys.length,
      total_scores: scoreKeys.length,
      redis_url: REDIS_URL.replace(/:[^:]*@/, ':***@'), // Mask password
      connected: redisClient && redisClient.isOpen,
    };
  } catch (err) {
    console.error('[DB] Error in getDatabaseStats:', err.message);
    return { error: err.message };
  }
}
