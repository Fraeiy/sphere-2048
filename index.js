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

import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';
import { randomUUID }     from 'crypto';

import { GameState }    from './game.js';
import { connectSphere, submitScore, getSphereStatus } from './sphere.js';

// ─── Setup ────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const app  = express();
const PORT = 5000;

// Parse JSON request bodies
app.use(express.json());

// Serve static files (HTML, CSS, JS) from the /public directory
app.use(express.static(join(__dirname, 'public')));

// ─── In-Memory Session Store ──────────────────────────────────────────────────

/**
 * Sessions map: sessionId → GameState
 * In a production app this would be a proper session store (Redis, etc.).
 * For simplicity, each browser tab gets a unique session via a cookie-style header.
 */
const sessions = new Map();

/** Best score carried across new games within the same session */
const bestScores = new Map();

/**
 * Retrieves or creates a GameState for the given session ID.
 * @param {string} sessionId
 * @returns {GameState}
 */
function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    const best = bestScores.get(sessionId) ?? 0;
    sessions.set(sessionId, new GameState(best));
  }
  return sessions.get(sessionId);
}

// ─── API Routes ───────────────────────────────────────────────────────────────

/**
 * GET /api/state
 * Returns the current game state for the given session.
 * If no session exists yet, creates a fresh game.
 *
 * Headers:
 *   X-Session-Id  — opaque session identifier issued by the client
 */
app.get('/api/state', (req, res) => {
  const sid   = req.headers['x-session-id'] || randomUUID();
  const state = getSession(sid);
  res.json({ sessionId: sid, ...state.toJSON() });
});

/**
 * POST /api/new
 * Resets the board and starts a fresh game.
 * Preserves the all-time best score across resets.
 *
 * Headers:
 *   X-Session-Id  — opaque session identifier
 */
app.post('/api/new', (req, res) => {
  const sid  = req.headers['x-session-id'] || randomUUID();
  const best = bestScores.get(sid) ?? 0;

  // Create a new game, preserving the best score
  const state = new GameState(best);
  sessions.set(sid, state);

  res.json({ sessionId: sid, ...state.toJSON() });
});

/**
 * POST /api/move
 * Applies a directional move to the current game.
 *
 * Body:
 *   { direction: 'left' | 'right' | 'up' | 'down' }
 *
 * Headers:
 *   X-Session-Id
 *
 * Response:
 *   { moved: boolean, ...gameState }
 */
app.post('/api/move', (req, res) => {
  const sid  = req.headers['x-session-id'] || randomUUID();
  const { direction } = req.body;

  // Validate direction
  const valid = ['left', 'right', 'up', 'down'];
  if (!valid.includes(direction)) {
    return res.status(400).json({ error: `Invalid direction. Must be one of: ${valid.join(', ')}` });
  }

  const state = getSession(sid);
  const moved = state.move(direction);

  // Persist best score
  if (state.score > (bestScores.get(sid) ?? 0)) {
    bestScores.set(sid, state.score);
  }

  res.json({ sessionId: sid, moved, ...state.toJSON() });
});

/**
 * POST /api/submit-score
 * Submits the current (or final) score to the Unicity blockchain via Sphere SDK.
 *
 * Headers:
 *   X-Session-Id
 *
 * Response:
 *   { success: boolean, eventId?: string, error?: string, score: number }
 */
app.post('/api/submit-score', async (req, res) => {
  const sid   = req.headers['x-session-id'] || randomUUID();
  const state = getSession(sid);

  const result = await submitScore(state.score, state.board);
  res.json({ score: state.score, ...result });
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
 *   1. Start the Express server
 *   2. Connect to the Sphere chain in the background
 *      (non-blocking so the game is playable even if the SDK is slow to connect)
 */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] 2048 + Sphere listening on http://0.0.0.0:${PORT}`);
  // Initiate Sphere connection asynchronously — game is playable immediately
  connectSphere().catch(err =>
    console.error('[Server] Sphere init error (non-fatal):', err.message)
  );
});
