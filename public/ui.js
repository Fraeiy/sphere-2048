/**
 * ui.js — Frontend Rendering & Game Controller with Sphere Wallet
 *
 * Responsibilities:
 *   • Connect to Sphere wallet via ConnectClient + PostMessageTransport
 *   • Check UTC token balance before allowing play
 *   • Handle deposits: send UTC tokens to game treasury
 *   • Manages a stable sessionId (stored in sessionStorage)
 *   • Fetches game state from Express API after each action
 *   • Renders the 4×4 board into the DOM
 *   • Handles keyboard (arrow keys) and on-screen button input
 *   • Charges UTC per move or in batches
 *   • Submits final score to blockchain via /api/submit-score
 *   • Polls Sphere SDK status and shows it in status pill
 */

// ─── Sphere Wallet Integration ────────────────────────────────────────────────

const WALLET_URL = 'https://sphere.unicity.network';
const GAME_TREASURY_ADDRESS = 'sphere1treasury2048'; // Replace with actual treasury address
const MOVE_COST_UTC = 1; // Cost per move in UTC
const DEPOSIT_AMOUNT = 100; // Initial deposit amount in UTC

/** @type {any} */
let sphereClient = null;

/** @type {object | null} */
let walletIdentity = null;

/** @type {number} */
let utcBalance = 0;

/** @type {boolean} */
let isConnected = false;

/**
 * Connects to Sphere wallet via popup + postMessage.
 * @returns {Promise<boolean>}
 */
async function connectWallet() {
  try {
    showMessage('Opening Sphere wallet…', 'warn');

    const popup = window.open(
      WALLET_URL + '/connect?origin=' + encodeURIComponent(location.origin),
      'sphere-wallet',
      'width=420,height=650'
    );

    if (!popup) {
      showMessage('⚠️  Popup blocked. Please allow popups for sphere.unicity.network', 'err');
      return false;
    }

    // Wait for wallet to send back connection data via postMessage
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        showMessage('⏱️  Wallet connection timeout', 'err');
        popup.close();
        resolve(false);
      }, 30000); // 30 second timeout

      const handleMessage = (event) => {
        // Verify origin for security
        if (event.origin !== WALLET_URL) {
          console.warn('[Wallet] Ignoring message from untrusted origin:', event.origin);
          return;
        }

        if (event.data.type === 'sphere:connect') {
          clearTimeout(timeout);
          window.removeEventListener('message', handleMessage);

          if (event.data.success) {
            walletIdentity = event.data.identity;
            isConnected = true;
            popup.close();

            showMessage(`✅ Connected to ${walletIdentity.address?.slice(0, 20) || 'Sphere Wallet'}…`, 'ok');
            checkBalance().catch(err => console.error('Balance check failed:', err));
            resolve(true);
          } else {
            showMessage(`❌ Wallet connection rejected: ${event.data.error || 'Unknown error'}`, 'err');
            popup.close();
            resolve(false);
          }
        }
      };

      window.addEventListener('message', handleMessage);
    });
  } catch (err) {
    console.error('[Wallet] Connection error:', err);
    showMessage(`❌ Wallet connection failed: ${err.message}`, 'err');
    return false;
  }
}

/**
 * Checks UTC balance from the wallet.
 * For now, returns a mock balance. In production, this would query the wallet.
 * @returns {Promise<void>}
 */
async function checkBalance() {
  if (!isConnected) {
    utcBalance = 0;
    return;
  }

  try {
    // Mock balance for demo - in production, query the actual wallet
    utcBalance = DEPOSIT_AMOUNT;
    updateBalanceDisplay();
  } catch (err) {
    console.error('Balance check failed:', err);
  }
}

/**
 * Deposits UTC tokens to play the game.
 * @returns {Promise<boolean>}
 */
async function depositToPlay() {
  if (!isConnected) {
    showMessage('❌ Wallet not connected', 'err');
    return false;
  }

  try {
    showMessage(`Requesting deposit of ${DEPOSIT_AMOUNT} UTC…`, 'warn');

    // Send intent to wallet via postMessage
    const popup = window.open(
      WALLET_URL + `/intent/send?amount=${DEPOSIT_AMOUNT}&recipient=${GAME_TREASURY_ADDRESS}&coinId=UTC`,
      'sphere-intent',
      'width=420,height=650'
    );

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        popup?.close();
        resolve(false);
      }, 60000); // 60 second timeout

      const handleMessage = (event) => {
        if (event.origin !== WALLET_URL) return;

        if (event.data.type === 'sphere:intent-result') {
          clearTimeout(timeout);
          window.removeEventListener('message', handleMessage);
          popup?.close();

          if (event.data.success) {
            showMessage(`✅ Deposited ${DEPOSIT_AMOUNT} UTC!`, 'ok');
            checkBalance().catch(err => console.error('Balance check failed:', err));
            resolve(true);
          } else {
            showMessage(`❌ Deposit failed: ${event.data.error || 'User rejected'}`, 'err');
            resolve(false);
          }
        }
      };

      window.addEventListener('message', handleMessage);
    });
  } catch (err) {
    showMessage(`❌ Deposit failed: ${err.message}`, 'err');
    return false;
  }
}

/**
 * Charges one move to the player's wallet.
 * @returns {Promise<boolean>}
 */
async function chargeMoveToWallet() {
  if (!isConnected) return false;
  if (utcBalance < MOVE_COST_UTC) {
    showMessage(`❌ Insufficient balance. Need ${MOVE_COST_UTC} UTC, have ${utcBalance}`, 'err');
    return false;
  }

  try {
    // For now, just deduct locally without wallet interaction
    // In production, this would send an intent to the wallet
    utcBalance -= MOVE_COST_UTC;
    updateBalanceDisplay();
    return true;
  } catch (err) {
    console.error('Move charge failed:', err);
    return false;
  }
}

/** Updates balance display in the UI */
function updateBalanceDisplay() {
  const balanceEl = document.getElementById('walletBalance');
  if (balanceEl) {
    balanceEl.textContent = `${utcBalance} UTC`;
  }
}

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
  // If wallet not connected, try to connect (or skip if in demo mode)
  if (!isConnected) {
    const tryConnect = await connectWallet();
    if (!tryConnect) {
      // Allow demo mode without wallet for testing
      const proceed = confirm('Wallet connection failed. Play in demo mode? (No wallet charges)');
      if (!proceed) return;
    }
  }

  // Check balance and prompt for deposit if needed (only if connected)
  if (isConnected) {
    await checkBalance();
    if (utcBalance < DEPOSIT_AMOUNT) {
      showMessage(`Need ${DEPOSIT_AMOUNT} UTC to play. Requesting deposit…`, 'warn');
      const deposited = await depositToPlay();
      if (!deposited) return;
    }
  }

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
  // Charge for the move only if wallet is connected
  if (isConnected) {
    const charged = await chargeMoveToWallet();
    if (!charged) return;
  }

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

/** Wallet connection button */
document.getElementById('btnConnectWallet').addEventListener('click', async () => {
  if (isConnected) {
    showMessage('Already connected!', 'ok');
    return;
  }
  await connectWallet();
  const walletInfoEl = document.getElementById('walletInfo');
  if (isConnected) {
    walletInfoEl.classList.add('active');
  }
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
