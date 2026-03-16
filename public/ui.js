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

// Based on Boxy-Run implementation: https://unicitynetwork.github.io/Boxy-Run/
// Uses https://sphere.unicity.network (not unicity-connect:// protocol)
const WALLET_URL = 'https://sphere.unicity.network';
const GAME_TREASURY_ADDRESS = '@sphere2048'; // Use @nametag format like Boxy-Run uses @boxyrun
const MOVE_COST_UTC = 1; // Cost per move in UTC
const DEPOSIT_AMOUNT = 100; // Initial deposit amount in UTC
const COIN_ID = 'UCT';
const UCT_COIN_ID_HEX = '455ad8720656b08e8dbd5bac1f3c73eeea5431565f6c1c3af742b1aa12d41d89';
const UCT_DECIMALS = 18;
const SESSION_KEY = 'sphere2048-session';
const DEPOSIT_KEY = 'sphere2048-deposit-paid';
const HOST_READY_TYPE = 'sphere-connect:host-ready';
const HOST_READY_TIMEOUT = 30000;

/** @type {any} */
let sphereClient = null;
let transport = null;
let popupWindow = null;
let uctCoinId = null;
let uctDecimals = UCT_DECIMALS;

/** @type {object | null} */
let walletIdentity = null;

/** @type {number} */
let utcBalance = 0; // Wallet balance

/** @type {number} */
let gameDepositBalance = 0; // In-game deposit balance (deducted per move)

/** @type {number} */
let moveCount = 0; // Track moves for auto-submit

/** @type {number} */
const AUTO_SUBMIT_MOVE_COUNT = 10; // Auto-submit after this many moves

/** @type {boolean} */
let isConnected = false;

/**
 * Check if running in iframe (based on Boxy-Run and SDK example)
 */
function isInIframe() {
  try {
    return window.parent !== window && window.self !== window.top;
  } catch {
    return true;
  }
}

/**
 * Check if Sphere extension is installed (based on Boxy-Run and SDK example)
 */
function hasExtension() {
  try {
    const sphere = window.sphere;
    if (!sphere || typeof sphere !== 'object') return false;
    const isInstalled = sphere.isInstalled;
    if (typeof isInstalled !== 'function') return false;
    return isInstalled() === true;
  } catch {
    return false;
  }
}

/**
 * Wait for wallet host to be ready (based on Boxy-Run implementation)
 */
function waitForHostReady() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(new Error('Wallet did not respond in time'));
    }, HOST_READY_TIMEOUT);
    
    function handler(event) {
      if (event.origin !== WALLET_URL) return;
      if (event.data?.type === HOST_READY_TYPE) {
        clearTimeout(timeout);
        window.removeEventListener('message', handler);
        resolve();
      }
    }
    window.addEventListener('message', handler);
  });
}

/**
 * Connects to Sphere wallet via popup/iframe/extension (based on Boxy-Run and SDK example).
 * Uses https://sphere.unicity.network (not unicity-connect:// protocol)
 * Supports iframe mode, extension mode, and popup mode
 * @returns {Promise<boolean>}
 */
async function connectWallet() {
  try {
    showMessage('Opening Sphere wallet…', 'warn');

    // dApp metadata for Sphere Connect protocol
    const dappMeta = {
      name: '2048 × Sphere',
      description: '2048 game with Unicity blockchain integration',
      url: location.origin
    };

    // Check for iframe mode first (like Boxy-Run and SDK example)
    if (isInIframe()) {
      // In iframe mode, use window.parent for communication
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          showMessage('❌ Wallet connection timeout in iframe mode.', 'err');
          resolve(false);
        }, 30000);

        const handleMessage = (event) => {
          if (event.origin !== WALLET_URL) return;

          const msg = event.data;
          if (msg && msg.ns === 'sphere-connect' && msg.v === '1.0') {
            if (msg.type === 'handshake' && msg.direction === 'response') {
              clearTimeout(timeout);
              window.removeEventListener('message', handleMessage);

              if (msg.sessionId && msg.identity) {
                walletIdentity = msg.identity;
                isConnected = true;
                if (msg.sessionId) {
                  sessionStorage.setItem(SESSION_KEY, msg.sessionId);
                }
                const displayName = walletIdentity.nametag || walletIdentity.address?.slice(0, 20) || 'Sphere Wallet';
                showMessage(`✅ Connected to ${displayName}…`, 'ok');
                updateWalletUI();
                checkBalance().catch(err => console.error('Balance check failed:', err));
                resolve(true);
              } else {
                showMessage('❌ Wallet connection rejected', 'err');
                resolve(false);
              }
            }
          }
        };

        window.addEventListener('message', handleMessage);

        // Send handshake to parent window
        const resumeSessionId = sessionStorage.getItem(SESSION_KEY) ?? undefined;
        window.parent.postMessage({
          ns: 'sphere-connect',
          v: '1.0',
          type: 'handshake',
          direction: 'request',
          permissions: ['identity:read', 'balance:read', 'tokens:read', 'transfer:request'],
          dapp: dappMeta,
          ...(resumeSessionId ? { sessionId: resumeSessionId } : {})
        }, WALLET_URL);
      });
    }

    // Check for extension mode (like Boxy-Run and SDK example)
    if (hasExtension()) {
      // Extension mode would use ExtensionTransport, but for now we'll fall through to popup
      console.log('[Wallet] Extension detected but using popup mode');
    }

    // Popup mode (default)
    // Close existing popup if any
    if (popupWindow && !popupWindow.closed) {
      popupWindow.close();
    }

    // Open wallet popup using https:// (not unicity-connect://)
    const connectUrl = WALLET_URL + '/connect?origin=' + encodeURIComponent(location.origin);
    popupWindow = window.open(
      connectUrl,
      'sphere-wallet',
      'width=420,height=650'
    );

    if (!popupWindow) {
      showMessage('⚠️  Popup blocked. Please allow popups for ' + WALLET_URL, 'err');
      return false;
    }

    // Wait for wallet host to be ready (like Boxy-Run does)
    try {
      await waitForHostReady();
    } catch (err) {
      showMessage('❌ Wallet connection timeout. Please check if the wallet service is accessible.', 'err');
      if (!popupWindow.closed) popupWindow.close();
      return false;
    }

    // Now send handshake using Sphere Connect protocol
    const resumeSessionId = sessionStorage.getItem(SESSION_KEY) ?? undefined;

    return new Promise((resolve) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          showMessage('❌ Wallet connection timeout.', 'err');
          if (!popupWindow.closed) popupWindow.close();
          resolve(false);
        }
      }, 30000);

      const handleMessage = (event) => {
        // Verify origin for security
        if (event.origin !== WALLET_URL) {
          console.warn('[Wallet] Ignoring message from untrusted origin:', event.origin);
          return;
        }

        // Check for Sphere Connect protocol messages
        const msg = event.data;
        if (msg && msg.ns === 'sphere-connect' && msg.v === '1.0') {
          if (msg.type === 'handshake' && msg.direction === 'response') {
            if (!resolved) {
              resolved = true;
              clearTimeout(timeout);
              window.removeEventListener('message', handleMessage);

              if (msg.sessionId && msg.identity) {
                walletIdentity = msg.identity;
                isConnected = true;
                if (msg.sessionId) {
                  sessionStorage.setItem(SESSION_KEY, msg.sessionId);
                }

                const displayName = walletIdentity.nametag || walletIdentity.address?.slice(0, 20) || 'Sphere Wallet';
                showMessage(`✅ Connected to ${displayName}…`, 'ok');
                updateWalletUI();
                checkBalance().catch(err => console.error('Balance check failed:', err));
                resolve(true);
              } else {
                showMessage('❌ Wallet connection rejected', 'err');
                if (!popupWindow.closed) popupWindow.close();
                resolve(false);
              }
            }
          } else if (msg.type === 'response' && msg.error) {
            if (!resolved) {
              resolved = true;
              clearTimeout(timeout);
              window.removeEventListener('message', handleMessage);
              showMessage(`❌ Wallet error: ${msg.error.message || 'Unknown error'}`, 'err');
              if (!popupWindow.closed) popupWindow.close();
              resolve(false);
            }
          }
        }
      };

      window.addEventListener('message', handleMessage);

      // Send handshake request
      popupWindow.postMessage({
        ns: 'sphere-connect',
        v: '1.0',
        type: 'handshake',
        direction: 'request',
        permissions: ['identity:read', 'balance:read', 'tokens:read', 'transfer:request'],
        dapp: dappMeta,
        ...(resumeSessionId ? { sessionId: resumeSessionId } : {})
      }, WALLET_URL);

      // Monitor popup for closure
      const checkInterval = setInterval(() => {
        if (popupWindow.closed && !resolved) {
          clearInterval(checkInterval);
          resolved = true;
          clearTimeout(timeout);
          window.removeEventListener('message', handleMessage);
          showMessage('❌ Wallet popup was closed', 'err');
          resolve(false);
        }
      }, 1000);
    });
  } catch (err) {
    console.error('[Wallet] Connection error:', err);
    showMessage(`❌ Wallet connection failed: ${err.message}`, 'err');
    return false;
  }
}

/**
 * Checks UTC balance from the wallet (based on Boxy-Run implementation).
 * Works in iframe, extension, and popup modes.
 * @returns {Promise<void>}
 */
async function checkBalance() {
  if (!isConnected) {
    utcBalance = 0;
    updateBalanceDisplay();
    return;
  }

  try {
    return new Promise((resolve) => {
      // Generate request ID first
      const balanceRequestId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
      
      const timeout = setTimeout(() => {
        window.removeEventListener('message', handleMessage);
        console.error('Balance query timeout');
        utcBalance = null;
        updateBalanceDisplay();
        resolve();
      }, 30000);

      const handleMessage = (event) => {
        if (event.origin !== WALLET_URL) return;

        const msg = event.data;
        if (msg && msg.ns === 'sphere-connect' && msg.v === '1.0') {
          if (msg.type === 'response' && msg.id === balanceRequestId) {
            clearTimeout(timeout);
            window.removeEventListener('message', handleMessage);

            if (msg.error) {
              console.error('Balance query failed:', msg.error);
              utcBalance = null;
            } else if (Array.isArray(msg.result)) {
              // Find UCT in assets array
              const uct = msg.result.find(a => a.symbol === COIN_ID);
              if (uct) {
                uctCoinId = uct.coinId;
                uctDecimals = uct.decimals || UCT_DECIMALS;
                utcBalance = Number(uct.totalAmount) / Math.pow(10, uctDecimals);
              } else {
                uctCoinId = UCT_COIN_ID_HEX;
                uctDecimals = UCT_DECIMALS;
                utcBalance = 0;
              }
            } else {
              utcBalance = 0;
            }
            updateBalanceDisplay();
            resolve();
          }
        }
      };

      window.addEventListener('message', handleMessage);

      // Determine target window based on connection mode
      let targetWindow;
      if (isInIframe()) {
        targetWindow = window.parent;
      } else if (popupWindow && !popupWindow.closed) {
        targetWindow = popupWindow;
      } else {
        console.error('No valid target window for balance query');
        clearTimeout(timeout);
        window.removeEventListener('message', handleMessage);
        utcBalance = null;
        updateBalanceDisplay();
        resolve();
        return;
      }

      // Send balance query using Sphere Connect protocol
      targetWindow.postMessage({
        ns: 'sphere-connect',
        v: '1.0',
        type: 'request',
        id: balanceRequestId,
        method: 'sphere_getBalance',
        params: {}
      }, WALLET_URL);
    });
  } catch (err) {
    console.error('Balance check failed:', err);
    utcBalance = null;
    updateBalanceDisplay();
  }
}

/**
 * Deposits UTC tokens to play the game (based on Boxy-Run implementation).
 * Uses Sphere Connect intent protocol.
 * @returns {Promise<boolean>}
 */
async function depositToPlay() {
  if (!isConnected) {
    showMessage('❌ Wallet not connected', 'err');
    return false;
  }

  if (!walletIdentity?.nametag) {
    showMessage('❌ Unicity ID required. Please register a Unicity ID in Sphere to play.', 'err');
    return false;
  }

  if (utcBalance !== null && utcBalance < DEPOSIT_AMOUNT) {
    showMessage(`❌ Insufficient wallet balance. You need at least ${DEPOSIT_AMOUNT} ${COIN_ID} in your wallet.`, 'err');
    return false;
  }

  // Determine target window for deposit
  let targetWindow;
  if (isInIframe()) {
    targetWindow = window.parent;
  } else if (popupWindow && !popupWindow.closed) {
    targetWindow = popupWindow;
  } else {
    // Open new popup for deposit if not already open
    const depositUrl = WALLET_URL + '/connect?origin=' + encodeURIComponent(location.origin);
    popupWindow = window.open(
      depositUrl,
      'sphere-wallet',
      'width=420,height=650'
    );
    if (!popupWindow) {
      showMessage('⚠️  Popup blocked. Please allow popups for ' + WALLET_URL, 'err');
      return false;
    }
    // Wait for wallet to be ready
    try {
      await waitForHostReady();
    } catch (err) {
      showMessage('❌ Wallet connection timeout.', 'err');
      if (!popupWindow.closed) popupWindow.close();
      return false;
    }
    targetWindow = popupWindow;
  }

  try {
    showMessage(`Opening wallet to deposit ${DEPOSIT_AMOUNT} ${COIN_ID}… Please sign the transaction.`, 'warn');

    if (!uctCoinId) {
      uctCoinId = UCT_COIN_ID_HEX;
      uctDecimals = UCT_DECIMALS;
    }

    return new Promise((resolve) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          showMessage('❌ Deposit timeout', 'err');
          resolve(false);
        }
      }, 120000); // 120 second timeout for intents

      const handleMessage = (event) => {
        if (event.origin !== WALLET_URL) return;

        const msg = event.data;
        if (msg && msg.ns === 'sphere-connect' && msg.v === '1.0') {
          if (msg.type === 'intent_result') {
            if (!resolved) {
              resolved = true;
              clearTimeout(timeout);
              window.removeEventListener('message', handleMessage);

              if (msg.error) {
                showMessage(`❌ Deposit failed: ${msg.error.message || 'User rejected'}`, 'err');
                resolve(false);
              } else {
                // Add to in-game deposit balance
                gameDepositBalance += DEPOSIT_AMOUNT;
                moveCount = 0; // Reset move count on new deposit
                showMessage(`✅ Deposited ${DEPOSIT_AMOUNT} ${COIN_ID}! In-game balance: ${gameDepositBalance} UTC`, 'ok');
                sessionStorage.setItem(DEPOSIT_KEY, 'true');
                updateBalanceDisplay();
                checkBalance().catch(err => console.error('Balance check failed:', err));
                resolve(true);
              }
            }
          }
        }
      };

      window.addEventListener('message', handleMessage);

      // Send intent using Sphere Connect protocol (like Boxy-Run)
      const intentId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
      targetWindow.postMessage({
        ns: 'sphere-connect',
        v: '1.0',
        type: 'intent',
        id: intentId,
        action: 'send',
        params: {
          to: GAME_TREASURY_ADDRESS,
          amount: DEPOSIT_AMOUNT,
          coinId: uctCoinId,
          memo: '2048 game deposit'
        }
      }, WALLET_URL);
    });
  } catch (err) {
    showMessage(`❌ Deposit failed: ${err.message}`, 'err');
    return false;
  }
}

/**
 * Charges one move from the in-game deposit balance.
 * @returns {Promise<boolean>}
 */
async function chargeMoveToWallet() {
  if (!isConnected) return false;
  
  // Check in-game deposit balance, not wallet balance
  if (gameDepositBalance < MOVE_COST_UTC) {
    showMessage(`❌ Insufficient in-game balance. Need ${MOVE_COST_UTC} UTC, have ${gameDepositBalance}. Please deposit more.`, 'err');
    return false;
  }

  try {
    // Deduct from in-game deposit balance
    gameDepositBalance -= MOVE_COST_UTC;
    moveCount++;
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
  const depositEl = document.getElementById('gameDeposit');
  if (balanceEl) {
    balanceEl.textContent = `${utcBalance !== null ? utcBalance.toFixed(2) : '0.00'} UTC`;
  }
  if (depositEl) {
    depositEl.textContent = `${gameDepositBalance} UTC`;
  }
}

/** Updates UI after wallet connection */
function updateWalletUI() {
  const connectBtn = document.getElementById('btnConnectWallet');
  const depositBtn = document.getElementById('btnDeposit');
  const walletInfoEl = document.getElementById('walletInfo');
  
  if (isConnected) {
    // Hide connect button
    if (connectBtn) {
      connectBtn.style.display = 'none';
    }
    // Show deposit button (always available after connection)
    if (depositBtn) {
      depositBtn.style.display = 'block';
      depositBtn.disabled = false;
      depositBtn.textContent = `💰 Deposit (${DEPOSIT_AMOUNT} UTC)`;
    }
    // Show wallet info
    if (walletInfoEl) {
      walletInfoEl.style.display = 'block';
      walletInfoEl.classList.add('active');
    }
  } else {
    // Show connect button
    if (connectBtn) {
      connectBtn.style.display = 'block';
    }
    // Hide deposit button
    if (depositBtn) {
      depositBtn.style.display = 'none';
    }
    // Hide wallet info
    if (walletInfoEl) {
      walletInfoEl.style.display = 'none';
      walletInfoEl.classList.remove('active');
    }
  }
  updateBalanceDisplay();
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

  // Auto-submit on game over if not already submitted
  if (state.gameOver && !scoreSubmitted && state.score > 0) {
    autoSubmitScore(state.score, state.board).catch(err => 
      console.error('Auto-submit on game over failed:', err)
    );
  }

  // Show overlay on game-over or win
  if (state.gameOver || (state.won && !overlayEl.classList.contains('active'))) {
    if (!overlayEl.classList.contains('active')) {
      overlayTitleEl.textContent = state.won ? '🎉 You Win!' : 'Game Over';
      overlayMsgEl.textContent   = state.won
        ? `You reached 2048! Score: ${state.score}. ${scoreSubmitted ? 'Score submitted!' : 'Score will auto-submit.'}`
        : `Final score: ${state.score}. ${scoreSubmitted ? 'Score submitted!' : 'Score will auto-submit.'}`;
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
    setTimeout(pollSphereStatus, status.connected ? 30_000 : 5_000);
  } catch {
    setTimeout(pollSphereStatus, 10_000);
  }
}

// ─── Actions ──────────────────────────────────────────────────────────────────

/** Starts a fresh game. */
async function newGame() {
  // Reset move count for new game
  moveCount = 0;
  scoreSubmitted = false;
  overlayEl.classList.remove('active');
  showMessage('Starting new game…');
  try {
    const state = await fetchNew();
    applyState(state);
    const walletHint = isConnected
      ? `In-game balance: ${gameDepositBalance} UTC`
      : 'Connect wallet to submit scores on-chain.';
    showMessage(`Use arrow keys or buttons to move tiles. ${walletHint}`);
  } catch (err) {
    showMessage(`Error: ${err.message}`, 'err');
  }
}

/** Applies a directional move, then updates the board. */
async function doMove(direction) {
  // If wallet is connected and has deposit, charge for the move
  let moveWasCharged = false;
  if (isConnected && gameDepositBalance > 0) {
    const charged = await chargeMoveToWallet();
    if (!charged) {
      return; // Error message already shown in chargeMoveToWallet
    }
    moveWasCharged = true;
  }

  try {
    const state = await fetchMove(direction);
    applyState(state);
    if (!state.moved) {
      showMessage('No tiles moved — try another direction.', 'warn');
      // Refund the move cost only if it was actually charged
      if (moveWasCharged) {
        gameDepositBalance += MOVE_COST_UTC;
        moveCount--;
        updateBalanceDisplay();
      }
    } else {
      moveCount++;
      const balanceMsg = isConnected && gameDepositBalance > 0 ? ` Balance: ${gameDepositBalance} UTC` : '';
      showMessage(
        state.gameOver
          ? `Game over! Final score: ${state.score}.${balanceMsg}`
          : state.won
            ? `🎉 You reached 2048! Score: ${state.score}.${balanceMsg}`
            : `Score: ${state.score}.${balanceMsg}`,
        state.gameOver ? 'err' : state.won ? 'ok' : ''
      );

      // Auto-submit after X moves
      if (moveCount >= AUTO_SUBMIT_MOVE_COUNT && !scoreSubmitted) {
        await autoSubmitScore(state.score, state.board);
      }
    }
  } catch (err) {
    showMessage(`Move error: ${err.message}`, 'err');
    // Refund on error only if the move was actually charged
    if (moveWasCharged) {
      gameDepositBalance += MOVE_COST_UTC;
      moveCount--;
      updateBalanceDisplay();
    }
  }
}

/** Automatically submits score to blockchain after X moves */
async function autoSubmitScore(score, board) {
  if (scoreSubmitted || score === 0) return;
  
  showMessage(`Auto-submitting score after ${moveCount} moves… ⛓`, 'warn');
  try {
    const result = await fetchSubmit();
    if (result.success) {
      scoreSubmitted = true;
      showMessage(`✅ Score ${score} auto-submitted! Event ID: ${result.eventId}`, 'ok');
    } else {
      showMessage(`⚠️  Auto-submit failed: ${result.error}. Will retry later.`, 'warn');
    }
  } catch (err) {
    showMessage(`⚠️  Auto-submit error: ${err.message}. Will retry later.`, 'warn');
  }
}

/** Submits the current score to the Unicity blockchain (used by auto-submit). */
async function submitToChain() {
  // This function is kept for compatibility but auto-submit is used instead
  // Manual submission removed - scores auto-submit after X moves or on game over
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
  if (btn) {
    doMove(btn.dataset.dir);
  }
});

/** Wallet connection button */
document.getElementById('btnConnectWallet').addEventListener('click', async () => {
  if (isConnected) {
    showMessage('Already connected!', 'ok');
    return;
  }
  await connectWallet();
  updateWalletUI(); // Update UI after connection attempt
});

/** Deposit button */
const btnDeposit = document.getElementById('btnDeposit');
if (btnDeposit) {
  btnDeposit.addEventListener('click', async () => {
    if (!isConnected) {
      showMessage('❌ Please connect your wallet first', 'err');
      return;
    }
    btnDeposit.disabled = true;
    btnDeposit.textContent = 'Processing...';
    const success = await depositToPlay();
    btnDeposit.textContent = `💰 Deposit (${DEPOSIT_AMOUNT} UTC)`;
    btnDeposit.disabled = false;
    updateWalletUI();
  });
}

/** New game buttons */
btnNew.addEventListener('click', newGame);
btnNewOverlay.addEventListener('click', newGame);

// Submit button removed - auto-submit is used instead

// ─── Boot ─────────────────────────────────────────────────────────────────────

(async () => {
  showMessage('Loading game…');

  try {
    // Load (or create) a game on the server
    const state = await fetchState();
    applyState(state);
    
    // Show message based on wallet connection status
    if (!isConnected) {
      showMessage('Use arrow keys or buttons to move tiles. Connect wallet to submit scores on-chain.');
    } else {
      showMessage('Use arrow keys or buttons to move tiles.');
    }
  } catch (err) {
    showMessage(`Failed to load game: ${err.message}`, 'err');
  }

  // Start Sphere status polling in the background
  pollSphereStatus();
})();
