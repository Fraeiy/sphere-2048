/**
 * db-kv.js — Vercel KV Database Module (Serverless Alternative to SQLite)
 *
 * Uses Vercel KV (Redis) for serverless-friendly persistence
 * Automatically falls back to in-memory storage during local development
 *
 * Features:
 *   • Persistent across deployments on Vercel
 *   • In-memory fallback for local development
 *   • Same API as db.js for easy migration
 */

import { kv } from '@vercel/kv';

const USE_KV = process.env.VERCEL === '1' || (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
const IN_MEMORY = !USE_KV;

// In-memory fallback for local development
const memoryStore = {
  users: new Map(),
  scores: new Map(),
  deposits: new Map(),
  moves: new Map(),
};

console.log(`[DB] Using storage: ${USE_KV ? 'Vercel KV' : 'In-Memory (Development)'}`);

/**
 * Initialize database (no-op for KV, called for compatibility)
 */
export async function initDatabase() {
  if (USE_KV) {
    try {
      await kv.ping();
      console.log('[DB] ✅ Connected to Vercel KV');
    } catch (err) {
      console.warn('[DB] ⚠️  KV not available, using in-memory storage:', err.message);
    }
  } else {
    console.log('[DB] ✅ Using in-memory storage');
  }
}

/**
 * Get or create a user record
 */
export async function getOrCreateUser(userId, walletId = null) {
  const key = `user:${userId}`;
  
  if (IN_MEMORY) {
    let user = memoryStore.users.get(userId);
    if (!user) {
      const now = Date.now();
      user = {
        user_id: userId,
        wallet_id: walletId,
        balance: 0,
        total_deposited: 0,
        moves_left: 0,
        total_moves: 0,
        high_score: 0,
        last_move: null,
        created_at: now,
        updated_at: now
      };
      memoryStore.users.set(userId, user);
    } else if (walletId && user.wallet_id !== walletId) {
      user.wallet_id = walletId;
      user.updated_at = Date.now();
    }
    return user;
  }
  
  // KV mode
  let user = await kv.get(key);
  
  if (!user) {
    const now = Date.now();
    user = {
      user_id: userId,
      wallet_id: walletId,
      balance: 0,
      total_deposited: 0,
      moves_left: 0,
      total_moves: 0,
      high_score: 0,
      last_move: null,
      created_at: now,
      updated_at: now
    };
    await kv.set(key, user);
  } else if (walletId && user.wallet_id !== walletId) {
    user.wallet_id = walletId;
    user.updated_at = Date.now();
    await kv.set(key, user);
  }
  
  return user;
}

/**
 * Add a deposit to user account
 */
export async function addDeposit(userId, amount, txHash = null) {
  const userKey = `user:${userId}`;
  const user = await getOrCreateUser(userId);
  const now = Date.now();

  // Update user balance
  const newBalance = user.balance + amount;
  const newMovesLeft = user.moves_left + Math.floor(amount / (0.1 * 1e18));

  if (IN_MEMORY) {
    user.balance = newBalance;
    user.total_deposited = user.total_deposited + amount;
    user.moves_left = newMovesLeft;
    user.updated_at = now;
    memoryStore.users.set(userId, user);
    
    // Log deposit
    const deposit = { user_id: userId, amount, tx_hash: txHash, created_at: now };
    if (!memoryStore.deposits.has(userId)) memoryStore.deposits.set(userId, []);
    memoryStore.deposits.get(userId).push(deposit);
  } else {
    // KV mode
    user.balance = newBalance;
    user.total_deposited = user.total_deposited + amount;
    user.moves_left = newMovesLeft;
    user.updated_at = now;
    await kv.set(userKey, user);
    
    // Log deposit
    const depositKey = `deposit:${userId}:${now}`;
    await kv.set(depositKey, {
      user_id: userId,
      amount,
      tx_hash: txHash,
      created_at: now
    });
    
    // Add to user's deposit list
    const depositsKey = `deposits:${userId}`;
    const deposits = (await kv.lrange(depositsKey, 0, -1)) || [];
    await kv.rpush(depositsKey, depositKey);
  }

  console.log(`[DB] Deposit: ${userId} +${amount} (${newMovesLeft} moves)`);
  return user;
}

/**
 * Deduct move cost from user balance
 */
export async function deductMove(userId) {
  const userKey = `user:${userId}`;
  const user = await getOrCreateUser(userId);

  if (user.moves_left <= 0) {
    return false;
  }

  const now = Date.now();
  
  if (IN_MEMORY) {
    user.moves_left -= 1;
    user.total_moves += 1;
    user.last_move = now;
    user.updated_at = now;
    memoryStore.users.set(userId, user);
  } else {
    user.moves_left -= 1;
    user.total_moves += 1;
    user.last_move = now;
    user.updated_at = now;
    await kv.set(userKey, user);
  }

  console.log(`[DB] Move deducted: ${userId} (moves_left: ${user.moves_left})`);
  return true;
}

/**
 * Submit a score to the database
 */
export async function submitScore(userId, score, movesUsed = 0) {
  const userKey = `user:${userId}`;
  const user = await getOrCreateUser(userId);
  const now = Date.now();

  // Update high score if applicable
  if (score > user.high_score) {
    user.high_score = score;
    user.updated_at = now;
    
    if (IN_MEMORY) {
      memoryStore.users.set(userId, user);
    } else {
      await kv.set(userKey, user);
    }
  }

  // Insert score record
  if (IN_MEMORY) {
    if (!memoryStore.scores.has(userId)) memoryStore.scores.set(userId, []);
    memoryStore.scores.get(userId).push({
      user_id: userId,
      score,
      moves_used: movesUsed,
      timestamp: now
    });
  } else {
    const scoreKey = `score:${userId}:${now}`;
    await kv.set(scoreKey, {
      user_id: userId,
      score,
      moves_used: movesUsed,
      timestamp: now
    });
    
    const scoresKey = `scores:${userId}`;
    await kv.rpush(scoresKey, scoreKey);
  }

  console.log(`[DB] Score submitted: ${userId} → ${score}`);
  return { user_id: userId, score, moves_used: movesUsed, timestamp: now };
}

/**
 * Get user's stats
 */
export async function getUserStats(userId) {
  const user = await getOrCreateUser(userId);

  if (!user) {
    return null;
  }

  if (IN_MEMORY) {
    const scores = (memoryStore.scores.get(userId) || []).slice(-10);
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

  // KV mode
  const scoresKey = `scores:${userId}`;
  const scoreKeys = (await kv.lrange(scoresKey, -10, -1)) || [];
  const scores = [];
  for (const key of scoreKeys) {
    const score = await kv.get(key);
    if (score) scores.push(score);
  }

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
 */
export async function getLeaderboard(limit = 10) {
  if (IN_MEMORY) {
    // In-memory: sort users by high_score
    const users = Array.from(memoryStore.users.values())
      .sort((a, b) => b.high_score - a.high_score)
      .slice(0, limit);
    
    return users.map((user, index) => ({
      rank: index + 1,
      wallet_id: user.wallet_id || user.user_id,
      high_score: user.high_score,
      total_moves: user.total_moves
    }));
  }

  // KV mode: get all users and sort
  const userKeys = await kv.keys('user:*');
  const users = [];
  
  for (const key of userKeys) {
    const user = await kv.get(key);
    if (user) users.push(user);
  }
  
  const sorted = users
    .sort((a, b) => b.high_score - a.high_score)
    .slice(0, limit);
  
  return sorted.map((user, index) => ({
    rank: index + 1,
    wallet_id: user.wallet_id || user.user_id,
    high_score: user.high_score,
    total_moves: user.total_moves
  }));
}

/**
 * Record a move transaction
 */
export async function recordMove(userId, moveNumber, direction, scoreAfter, gameId = null) {
  const now = Date.now();
  
  if (IN_MEMORY) {
    if (!memoryStore.moves.has(userId)) memoryStore.moves.set(userId, []);
    memoryStore.moves.get(userId).push({
      user_id: userId,
      move_number: moveNumber,
      direction,
      score_after: scoreAfter,
      game_id: gameId,
      created_at: now
    });
  } else {
    const moveKey = `move:${userId}:${now}`;
    await kv.set(moveKey, {
      user_id: userId,
      move_number: moveNumber,
      direction,
      score_after: scoreAfter,
      game_id: gameId,
      created_at: now
    });
    
    const movesKey = `moves:${userId}`;
    await kv.rpush(movesKey, moveKey);
  }

  return { user_id: userId, move_number: moveNumber, direction, score_after: scoreAfter };
}

/**
 * Get user's deposit history
 */
export async function getDepositHistory(userId, limit = 50) {
  if (IN_MEMORY) {
    return (memoryStore.deposits.get(userId) || []).slice(-limit);
  }

  const depositsKey = `deposits:${userId}`;
  const depositKeys = (await kv.lrange(depositsKey, -limit, -1)) || [];
  const deposits = [];
  
  for (const key of depositKeys) {
    const deposit = await kv.get(key);
    if (deposit) deposits.push(deposit);
  }
  
  return deposits;
}

/**
 * Get recent scores for a user
 */
export async function getRecentScores(userId, limit = 10) {
  if (IN_MEMORY) {
    return (memoryStore.scores.get(userId) || []).slice(-limit);
  }

  const scoresKey = `scores:${userId}`;
  const scoreKeys = (await kv.lrange(scoresKey, -limit, -1)) || [];
  const scores = [];
  
  for (const key of scoreKeys) {
    const score = await kv.get(key);
    if (score) scores.push(score);
  }
  
  return scores;
}

/**
 * Close database connection (no-op for KV)
 */
export async function closeDatabase() {
  if (USE_KV) {
    console.log('[DB] KV connection closed');
  }
}

/**
 * Get database statistics
 */
export async function getDatabaseStats() {
  if (IN_MEMORY) {
    return {
      total_users: memoryStore.users.size,
      total_scores: Array.from(memoryStore.scores.values()).reduce((sum, arr) => sum + arr.length, 0),
      total_deposits: Array.from(memoryStore.deposits.values()).reduce((sum, arr) => sum + arr.length, 0),
      storage: 'in-memory'
    };
  }

  // KV mode
  const userKeys = await kv.keys('user:*');
  return {
    total_users: userKeys.length,
    storage: 'Vercel KV'
  };
}
