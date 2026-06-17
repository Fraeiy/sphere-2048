/**
 * db-redis.js — Redis Database Module
 *
 * Mirrors db.js API exactly so production (Vercel + Redis) behaves like local SQLite.
 */

import { createClient } from 'redis';

const REDIS_URL = process.env.REDIS_URL || '';
const MOVE_COST_ATOMIC = 100000000000000000; // 0.1 UCT
const LEADERBOARD_KEY = 'leaderboard:highscores';

const inMemoryStore = new Map();
let redisClient = null;
let storageMode = REDIS_URL ? 'redis' : 'memory';

function useMemory() {
  return storageMode === 'memory';
}

function now() {
  return Date.now();
}

function createUserRecord(userId, walletId = null) {
  const ts = now();
  return {
    user_id: userId,
    wallet_id: walletId || userId,
    balance: 0,
    total_deposited: 0,
    moves_left: 0,
    total_moves: 0,
    high_score: 0,
    last_move: null,
    created_at: ts,
    updated_at: ts,
  };
}

async function readUser(userId) {
  const key = `user:${userId}`;
  if (useMemory()) {
    return inMemoryStore.get(key) || null;
  }
  const raw = await redisClient.get(key);
  return raw ? JSON.parse(raw) : null;
}

async function writeUser(user) {
  const key = `user:${user.user_id}`;
  user.updated_at = now();
  if (useMemory()) {
    inMemoryStore.set(key, user);
    return user;
  }
  await redisClient.set(key, JSON.stringify(user));
  return user;
}

async function updateLeaderboardIndex(userId, highScore) {
  if (useMemory() || !redisClient || highScore <= 0) return;
  await redisClient.zAdd(LEADERBOARD_KEY, { score: highScore, value: userId });
}

async function rebuildLeaderboardIndex() {
  if (useMemory() || !redisClient) return;

  let cursor = 0;
  do {
    const result = await redisClient.scan(cursor, { MATCH: 'user:*', COUNT: 100 });
    cursor = Number(result.cursor);
    for (const key of result.keys) {
      const raw = await redisClient.get(key);
      if (!raw) continue;
      const user = JSON.parse(raw);
      if (user.high_score > 0) {
        await redisClient.zAdd(LEADERBOARD_KEY, {
          score: user.high_score,
          value: user.user_id,
        });
      }
    }
  } while (cursor !== 0);
}

export async function initDatabase() {
  if (REDIS_URL) {
    try {
      redisClient = createClient({ url: REDIS_URL });
      redisClient.on('error', (err) => console.error('[DB] Redis error:', err));
      await redisClient.connect();
      await redisClient.ping();
      storageMode = 'redis';
      console.log('[DB] ✅ Connected to Redis');
      return true;
    } catch (err) {
      console.warn('[DB] ⚠️  Redis connection failed:', err.message);
      redisClient = null;
      storageMode = 'memory';
    }
  } else {
    storageMode = 'memory';
  }
  console.log('[DB] Using in-memory storage (local fallback)');
}

export async function closeDatabase() {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}

export async function getOrCreateUser(userId, walletId = null) {
  let user = await readUser(userId);
  if (!user) {
    user = createUserRecord(userId, walletId);
    await writeUser(user);
  } else if (walletId && user.wallet_id !== walletId) {
    user.wallet_id = walletId;
    await writeUser(user);
  }
  return user;
}

export async function getUserStats(userId) {
  const user = await readUser(userId);
  if (!user) {
    return null;
  }

  return {
    user_id: user.user_id,
    wallet_id: user.wallet_id,
    balance: user.balance || 0,
    moves_left: user.moves_left || 0,
    high_score: user.high_score || 0,
    total_moves: user.total_moves || 0,
    total_deposited: user.total_deposited || 0,
    created_at: user.created_at,
    updated_at: user.updated_at,
  };
}

export async function addDeposit(userId, amountAtomic, txHash = null) {
  const user = await getOrCreateUser(userId);
  const ts = now();

  user.balance = (user.balance || 0) + amountAtomic;
  user.total_deposited = (user.total_deposited || 0) + amountAtomic;
  user.moves_left = Math.floor(user.balance / MOVE_COST_ATOMIC);
  await writeUser(user);

  const depositRecord = {
    user_id: userId,
    wallet_id: user.wallet_id,
    amount: amountAtomic,
    tx_hash: txHash || 'manual',
    verified: 1,
    deposit_date: ts,
    created_at: ts,
  };

  const depositKey = `deposit:${userId}:${ts}`;
  if (useMemory()) {
    inMemoryStore.set(depositKey, depositRecord);
  } else {
    await redisClient.set(depositKey, JSON.stringify(depositRecord));
    await redisClient.rPush(`deposits:${userId}`, depositKey);
  }

  console.log(`[DB] Deposit: ${userId} +${(amountAtomic / 1e18).toFixed(2)} UCT`);
  return getOrCreateUser(userId);
}

export async function deductMove(userId, direction = 'unknown', score = 0) {
  const user = await getOrCreateUser(userId);

  if ((user.balance || 0) < MOVE_COST_ATOMIC) {
    console.log(`[DB] Insufficient balance for move: ${userId}`);
    return null;
  }

  const ts = now();
  user.balance -= MOVE_COST_ATOMIC;
  user.total_moves = (user.total_moves || 0) + 1;
  user.moves_left = Math.floor(user.balance / MOVE_COST_ATOMIC);
  user.last_move = ts;
  await writeUser(user);

  const moveRecord = {
    user_id: userId,
    move_number: user.total_moves,
    direction,
    score_after: score,
    created_at: ts,
  };

  const moveKey = `move:${userId}:${ts}`;
  if (useMemory()) {
    inMemoryStore.set(moveKey, moveRecord);
  } else {
    await redisClient.set(moveKey, JSON.stringify(moveRecord));
    await redisClient.rPush(`moves:${userId}`, moveKey);
  }

  console.log(`[DB] Move: ${userId} dir=${direction} balance=${user.balance}`);
  return readUser(userId);
}

export async function submitScore(userId, score, movesUsed = 0) {
  const user = await getOrCreateUser(userId);
  const ts = now();

  if (score > (user.high_score || 0)) {
    user.high_score = score;
    await writeUser(user);
    await updateLeaderboardIndex(userId, score);
  }

  const scoreRecord = {
    user_id: userId,
    wallet_id: user.wallet_id,
    score,
    moves_used: movesUsed,
    timestamp: ts,
  };

  const scoreKey = `score:${userId}:${ts}`;
  if (useMemory()) {
    inMemoryStore.set(scoreKey, scoreRecord);
  } else {
    await redisClient.set(scoreKey, JSON.stringify(scoreRecord));
    await redisClient.rPush(`scores:${userId}`, scoreKey);
  }

  return scoreRecord;
}

function formatLeaderboardRows(users, limit) {
  return users
    .filter((user) => user?.high_score > 0)
    .sort((a, b) => {
      if (b.high_score !== a.high_score) return b.high_score - a.high_score;
      return (b.total_moves || 0) - (a.total_moves || 0);
    })
    .slice(0, limit)
    .map((user, index) => ({
      rank: index + 1,
      userId: user.user_id,
      walletId: user.wallet_id || user.user_id,
      highScore: user.high_score || 0,
      totalMoves: user.total_moves || 0,
      totalDeposited: user.total_deposited || 0,
      gameCount: user.game_count || 1,
      avgScore: user.high_score || 0,
    }));
}

export async function getLeaderboard(limit = 10) {
  const users = [];

  if (useMemory()) {
    for (const [key, value] of inMemoryStore.entries()) {
      if (key.startsWith('user:') && value?.high_score > 0) {
        users.push(value);
      }
    }
    return formatLeaderboardRows(users, limit);
  }

  let rankedUserIds = await redisClient.zRange(LEADERBOARD_KEY, 0, Math.max(limit * 2, limit) - 1, { REV: true });

  if (!rankedUserIds.length) {
    await rebuildLeaderboardIndex();
    rankedUserIds = await redisClient.zRange(LEADERBOARD_KEY, 0, Math.max(limit * 2, limit) - 1, { REV: true });
  }

  for (const rankedUserId of rankedUserIds) {
    const user = await readUser(rankedUserId);
    if (user?.high_score > 0) {
      users.push(user);
    }
    if (users.length >= limit) break;
  }

  return formatLeaderboardRows(users, limit);
}

export async function getDepositHistory(userId) {
  const deposits = [];

  if (useMemory()) {
    for (const [key, value] of inMemoryStore.entries()) {
      if (key.startsWith(`deposit:${userId}:`)) deposits.push(value);
    }
  } else {
    const keys = await redisClient.lRange(`deposits:${userId}`, 0, -1);
    for (const key of keys) {
      const raw = await redisClient.get(key);
      if (raw) deposits.push(JSON.parse(raw));
    }
  }

  return deposits
    .sort((a, b) => b.created_at - a.created_at)
    .map((d) => ({
      id: d.created_at,
      amountAtomic: d.amount,
      amountUCT: (d.amount / 1e18).toFixed(6),
      txHash: d.tx_hash,
      verified: Boolean(d.verified),
      depositDate: new Date(d.deposit_date || d.created_at).toISOString(),
      timestamp: d.created_at,
    }));
}

export async function getMoveHistory(userId, limit = 50) {
  const moves = [];

  if (useMemory()) {
    for (const [key, value] of inMemoryStore.entries()) {
      if (key.startsWith(`move:${userId}:`)) moves.push(value);
    }
  } else {
    const keys = await redisClient.lRange(`moves:${userId}`, 0, -1);
    for (const key of keys.slice(-limit)) {
      const raw = await redisClient.get(key);
      if (raw) moves.push(JSON.parse(raw));
    }
  }

  return moves
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, limit)
    .map((m) => ({
      id: m.created_at,
      moveNumber: m.move_number,
      direction: m.direction,
      scoreAfter: m.score_after,
      timestamp: m.created_at,
      date: new Date(m.created_at).toISOString(),
    }));
}

export async function verifyBalanceFromHistory(userId) {
  const user = await getOrCreateUser(userId);
  const deposits = await getDepositHistory(userId);
  const moves = await getMoveHistory(userId, 10000);

  const totalDeposited = deposits.reduce((sum, d) => sum + d.amountAtomic, 0);
  const moveCount = moves.length;
  const totalSpent = moveCount * MOVE_COST_ATOMIC;
  const calculatedBalance = totalDeposited - totalSpent;
  const storedBalance = user.balance || 0;

  return {
    storedBalance,
    calculatedBalance,
    isValid: storedBalance === calculatedBalance,
    discrepancy: storedBalance - calculatedBalance,
    totalDeposited,
    totalDepositsUCT: (totalDeposited / 1e18).toFixed(6),
    moveCount,
    totalSpent,
    totalSpentUCT: (totalSpent / 1e18).toFixed(6),
    depositRecords: deposits.length,
    moveRecords: moveCount,
  };
}

export async function getDatabaseStats() {
  if (useMemory()) {
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
      connected: true,
    };
  }

  const [userKeys, depositKeys, scoreKeys] = await Promise.all([
    redisClient.keys('user:*'),
    redisClient.keys('deposit:*'),
    redisClient.keys('score:*'),
  ]);

  return {
    storage_type: 'Redis',
    total_users: userKeys.length,
    total_deposits: depositKeys.length,
    total_scores: scoreKeys.length,
    connected: Boolean(redisClient?.isOpen),
  };
}