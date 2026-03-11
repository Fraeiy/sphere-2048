/**
 * ui.js — Frontend Rendering & Game Controller
 *
 * Responsibilities:
 *   • Manages a stable sessionId (stored in sessionStorage) so the server
 *     remembers which game belongs to this browser tab.
 *   • Fetches the game state from the Express API after each action.
 *   • Renders the 4×4 board into the DOM.
 *   • Handles keyboard (arrow keys) and on-screen button input.
 *   • Submits the score to the Unicity chain via the /api/submit-score endpoint.
 *   • Polls the Sphere SDK status and shows it in the status pill.
 *
 * All server communication is done with fetch() using the X-Session-Id header.
 */

// ─── Session ID ───────────────────────────────────────────────────────────────

/**
 * A stable, per-tab identifier.
 * Stored in sessionStorage so it survives a page refresh but not a new tab.
 */
let sessionId = sessionStorage.getItem('sphere2048-session') ?? '';

/** Updates the stored session ID when the server returns one. */
function setSessionId(id) {
  sessionId = id;
  sessionStorage.setItem('sphere2048-session', id);
}

// ─── API Helpers ──────────────────────────────────────────────────────────────

/** Base fetch wrapper that always sends the X-Session-Id header. */
async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Session-Id': sessionId,
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`API ${path} → ${res.status}`);
  return res.json();
}

/** GET /api/state — returns current game state */
const fetchState = () => api('/api/state');

/** POST /api/new — resets the game */
const fetchNew   = () => api('/api/new', { method: 'POST' });

/** POST /api/move — applies a directional move */
const fetchMove  = dir =>
  api('/api/move', { method: 'POST', body: JSON.stringify({ direction: dir }) });

/** POST /api/submit-score — publishes score to blockchain */
const fetchSubmit = () => api('/api/submit-score', { method: 'POST' });

/** GET /api/sphere-status — connection info */
const fetchSphereStatus = () => api('/api/sphere-status');

// ─── DOM References ───────────────────────────────────────────────────────────

const boardEl        = document.getElementById('board');
const scoreEl        = document.getElementById('score');
const bestEl         = document.getElementById('best');
const messageEl      = document.getElementById('message');
const messageTextEl  = document.getElementById('messageText');
const spherePillEl   = document.getElementById('spherePill');
const overlayEl      = document.getElementById('overlay');
const overlayTitleEl = document.getElementById('overlayTitle');
const overlayMsgEl   = document.getElementById('overlayMsg');
const btnNew         = document.getElementById('btnNew');
const btnSubmit      = document.getElementById('btnSubmit');
const btnNewOverlay  = document.getElementById('btnNewOverlay');

// ─── Board Rendering ──────────────────────────────────────────────────────────

/**
 * Renders (or updates) the 4×4 board in the DOM.
 *
 * Uses 16 stable <div class="cell"> elements.
 * On first call they are created; on subsequent calls only data attributes and
 * text are updated so the CSS transitions can animate colour changes.
 *
 * @param {number[][]} board  4×4 grid of tile values (0 = empty)
 */
function renderBoard(board) {
  // Create cells once; update them on every subsequent call
  if (boardEl.children.length === 0) {
    for (let i = 0; i < 16; i++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      boardEl.appendChild(cell);
    }
  }

  const cells = boardEl.children;
  let idx = 0;

  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const v    = board[r][c];
      const cell = cells[idx++];

      if (v === 0) {
        cell.removeAttribute('data-v');
        cell.textContent = '';
      } else {
        cell.dataset.v   = v;
        cell.textContent = v;
      }
    }
  }
}

// ─── State Application ────────────────────────────────────────────────────────

/** Whether the player has already submitted this game's score */
let scoreSubmitted = false;

/**
 * Applies a full game state snapshot returned by the API:
 *   • Updates the board, score, and best-score display
 *   • Shows/hides the game-over / win overlay
 *   • Enables or disables the Submit button
 *
 * @param {object} state  API response body
 */
function applyState(state) {
  if (state.sessionId) setSessionId(state.sessionId);

  renderBoard(state.board);
  scoreEl.textContent = state.score;
  bestEl.textContent  = state.best;

  // Enable Submit whenever there are points and the game is over
  btnSubmit.disabled = state.score === 0 || scoreSubmitted;

  // Show overlay on game-over or win
  if (state.gameOver || (state.won && !overlayEl.classList.contains('active'))) {
    if (!overlayEl.classList.contains('active')) {
      overlayTitleEl.textContent = state.won ? '🎉 You Win!' : 'Game Over';
      overlayMsgEl.textContent   = state.won
        ? 'You reached 2048! Keep going or submit your score.'
        : `Final score: ${state.score}. Submit it to the chain!`;
      overlayEl.classList.add('active');
    }
  } else {
    overlayEl.classList.remove('active');
  }
}

// ─── Message Display ──────────────────────────────────────────────────────────

/**
 * Shows a status message below the board.
 * @param {string} text
 * @param {'ok'|'err'|'warn'|''} type
 */
function showMessage(text, type = '') {
  messageEl.className  = `message ${type}`.trim();
  messageTextEl.textContent = text;
}

// ─── Sphere Status Pill ───────────────────────────────────────────────────────

/** Renders the Sphere SDK connection status into the bottom pill. */
function renderSphereStatus(status) {
  const { connected, wallet } = status;

  if (!connected) {
    spherePillEl.innerHTML = `<strong>⛓ Sphere:</strong> Not connected — score submission disabled.`;
    return;
  }

  const parts = [`<strong>⛓ Sphere:</strong> Connected to Unicity (${wallet.network})`];
  if (wallet.nametag) parts.push(`· @${wallet.nametag}`);
  if (wallet.address) parts.push(`· ${wallet.address.slice(0, 20)}…`);

  spherePillEl.innerHTML = parts.join(' ');
}

/** Polls Sphere status every 5 seconds until connected, then every 30 seconds. */
async function pollSphereStatus() {
  try {
    const status = await fetchSphereStatus();
    renderSphereStatus(status);

    // Update Submit button if sphere just connected
    if (!status.connected) btnSubmit.disabled = true;

    setTimeout(pollSphereStatus, status.connected ? 30_000 : 5_000);
  } catch {
    setTimeout(pollSphereStatus, 10_000);
  }
}

// ─── Actions ──────────────────────────────────────────────────────────────────

/** Starts a fresh game. */
async function newGame() {
  scoreSubmitted = false;
  overlayEl.classList.remove('active');
  showMessage('Starting new game…');
  try {
    const state = await fetchNew();
    applyState(state);
    showMessage('Use arrow keys or buttons to move tiles.');
  } catch (err) {
    showMessage(`Error: ${err.message}`, 'err');
  }
}

/** Applies a directional move, then updates the board. */
async function doMove(direction) {
  try {
    const state = await fetchMove(direction);
    applyState(state);
    if (!state.moved) {
      showMessage('No tiles moved — try another direction.', 'warn');
    } else {
      showMessage(
        state.gameOver
          ? `Game over! Final score: ${state.score}`
          : state.won
            ? `🎉 You reached 2048! Score: ${state.score}`
            : `Score: ${state.score}`,
        state.gameOver ? 'err' : state.won ? 'ok' : ''
      );
    }
  } catch (err) {
    showMessage(`Move error: ${err.message}`, 'err');
  }
}

/** Submits the current score to the Unicity blockchain. */
async function submitToChain() {
  btnSubmit.disabled = true;
  showMessage('Submitting score to the Unicity chain… ⛓', 'warn');

  try {
    const result = await fetchSubmit();

    if (result.success) {
      scoreSubmitted = true;
      showMessage(
        `✅ Score ${result.score} submitted! Sphere event ID: ${result.eventId}`,
        'ok'
      );
    } else {
      showMessage(`❌ Submission failed: ${result.error}`, 'err');
      btnSubmit.disabled = false; // allow retry
    }
  } catch (err) {
    showMessage(`❌ Network error: ${err.message}`, 'err');
    btnSubmit.disabled = false;
  }
}

// ─── Event Listeners ──────────────────────────────────────────────────────────

/** Keyboard: arrow keys map to move directions. */
document.addEventListener('keydown', e => {
  const map = {
    ArrowLeft: 'left', ArrowRight: 'right',
    ArrowUp:   'up',   ArrowDown:  'down',
  };
  if (map[e.key]) {
    e.preventDefault(); // stop page scroll
    doMove(map[e.key]);
  }
});

/** Mobile arrow pad buttons */
document.querySelector('.arrow-pad').addEventListener('click', e => {
  const btn = e.target.closest('[data-dir]');
  if (btn) doMove(btn.dataset.dir);
});

/** New game buttons */
btnNew.addEventListener('click', newGame);
btnNewOverlay.addEventListener('click', newGame);

/** Submit score to chain */
btnSubmit.addEventListener('click', submitToChain);

// ─── Boot ─────────────────────────────────────────────────────────────────────

(async () => {
  showMessage('Loading game…');

  try {
    // Load (or create) a game on the server
    const state = await fetchState();
    applyState(state);
    showMessage('Use arrow keys or buttons to move tiles.');
  } catch (err) {
    showMessage(`Failed to load game: ${err.message}`, 'err');
  }

  // Start Sphere status polling in the background
  pollSphereStatus();
})();
