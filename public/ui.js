/**
 * ui.js — Frontend Rendering & Game Controller with Sphere Wallet
 *
 * Responsibilities:
 *   • Connect to Sphere wallet via ConnectClient + PostMessageTransport
 *   • Check UCT token balance before allowing play
 *   • Handle deposits: send UCT tokens to game treasury
 *   • Manages a stable sessionId (stored in sessionStorage)
 *   • Fetches game state from Express API after each action
 *   • Renders the 4×4 board into the DOM
 *   • Handles keyboard (arrow keys), swipe, and drag input on the board
 *   • Charges UCT per move or in batches
 *   • Submits final score to blockchain via /api/submit-score
 *   • Polls Sphere SDK status and shows it in status pill
 */

// ─── Sphere Wallet Integration ────────────────────────────────────────────────

// Based on Boxy-Run implementation: https://unicitynetwork.github.io/Boxy-Run/
// Uses https://sphere.unicity.network (not unicity-connect:// protocol)
const WALLET_URL = 'https://sphere.unicity.network';
let userId = null; // User ID for game state tracking
let GAME_HANDLE = null; // Player's game wallet display (e.g., "fraey_2048")
let DEPOSIT_ADDRESS = null; // Actual server wallet address to send deposits to
const MOVE_COST_UCT = 0.1; // Cost per move in UCT
const MIN_DEPOSIT_UCT = 1; // Deposit must be strictly greater than this amount
const DEFAULT_DEPOSIT_UCT = 10;
const COIN_ID = 'UCT';
const UCT_COIN_ID_HEX = '455ad8720656b08e8dbd5bac1f3c73eeea5431565f6c1c3af742b1aa12d41d89';
const UCT_DECIMALS = 18;
const SESSION_KEY = 'sphere2048-session';
const DEPOSIT_KEY = 'sphere2048-deposit-paid';
const HOST_READY_TYPE = 'sphere-connect:host-ready';
const HOST_READY_TIMEOUT = 30000;
const POPUP_FEATURES = 'width=420,height=650';

/** @type {any} */
let sphereClient = null;
let transport = null;
let popupWindow = null;
let uctCoinId = null;
let uctDecimals = UCT_DECIMALS;

/** @type {object | null} */
let walletIdentity = null;

/** @type {number} */
let uctBalance = 0; // Wallet balance

/** @type {number} */
let gameDepositBalance = 0; // In-game deposit balance (deducted per move)

/** @type {number} */
let moveCount = 0; // Track moves for auto-submit

/** @type {number} */
const AUTO_SUBMIT_MOVE_COUNT = 5; // Auto-submit after this many moves (helps persist scores)

/** @type {boolean} */
let isConnected = false;

/** @type {boolean} - Wallet is ready for deposits after identity is published */
let walletReady = false;

/** @type {boolean} - Prevents spam clicks on move button */
let moveRequestInFlight = false;

/** @type {number} - Current game moves left (from server) */
let currentMovesLeft = 0;

/** @type {number} - Current game score (from server) */
let currentScore = 0;

/** @type {object|null} - Cached balance from last state */
let lastBalanceState = null;

/** @type {number} - Timestamp of last balance sync */
let lastBalanceSyncTime = 0;

/**
 * Resolve the canonical wallet address from Sphere Connect identity.
 * @param {object|null} identity
 * @returns {string|null}
 */
function getWalletAddress(identity) {
  if (!identity) return null;
  return identity.l1Address || identity.directAddress || identity.address || null;
}

/**
 * Resolve the canonical game user id (nametag preferred, then wallet address).
 * @param {object|null} identity
 * @returns {string|null}
 */
function getCanonicalUserId(identity) {
  if (!identity) return null;
  return identity.nametag || getWalletAddress(identity);
}

/**
 * Syncs displayed in-game balance from server-provided UCT value.
 * @param {number|string} currentUct
 */
function syncGameDepositFromServer(currentUct) {
  const parsed = Number(currentUct);
  if (!Number.isFinite(parsed)) return;
  gameDepositBalance = Math.max(0, Math.round(parsed * 100) / 100);
}

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
 * Reset wallet state to prevent pollution from previous connections
 */
function resetWalletState() {
  sphereClient = null;
  transport = null;
  uctCoinId = null;
  uctDecimals = UCT_DECIMALS;
  walletIdentity = null;
  uctBalance = 0;
  moveCount = 0;
  isConnected = false;
  walletReady = false;
  
  // Clean up stale popup
  if (popupWindow && !popupWindow.closed) {
    try {
      popupWindow.close();
    } catch (err) {
      console.warn('[Wallet] Error closing popup:', err.message);
    }
  }
  popupWindow = null;
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
      const type = event.data?.type;
      if (type === HOST_READY_TYPE || type === 'host-ready') {
        clearTimeout(timeout);
        window.removeEventListener('message', handler);
        resolve();
      }
    }
    window.addEventListener('message', handler);
  });
}

/**
 * Opens or reuses a wallet popup while preserving dApp opener context.
 * @param {string} targetUrl
 * @param {Window|null} existingPopup
 * @returns {Window|null}
 */
function openWalletPopup(targetUrl, existingPopup = null) {
  if (existingPopup && !existingPopup.closed) {
    try {
      existingPopup.location.replace(targetUrl);
      existingPopup.focus();
      return existingPopup;
    } catch {
      // If cross-origin navigation is blocked unexpectedly, fall back to a fresh popup.
    }
  }

  const popup = window.open('about:blank', `sphere-wallet-${Date.now()}`, POPUP_FEATURES);
  if (!popup) return null;

  try {
    popup.location.replace(targetUrl);
    popup.focus();
  } catch (err) {
    console.error('[Wallet] Failed to navigate popup:', err);
    return null;
  }

  return popup;
}

/**
 * Open the deposit modal for embedded form input.
 */
function openDepositModal() {
  const overlay = document.getElementById('depositOverlay');
  const input = document.getElementById('depositAmount');
  const error = document.getElementById('depositError');
  
  if (overlay) {
    overlay.classList.add('active');
    if (input) {
      input.value = String(DEFAULT_DEPOSIT_UCT);
      input.focus();
      updateMovesDisplay();
    }
    if (error) {
      error.textContent = '';
      error.style.display = 'none';
    }
  }
}

/**
 * Close the deposit modal.
 */
function closeDepositModal() {
  const overlay = document.getElementById('depositOverlay');
  if (overlay) {
    overlay.classList.remove('active');
  }
}

/**
 * Update the moves display based on current input value.
 */
function updateMovesDisplay() {
  const input = document.getElementById('depositAmount');
  const movesDisplay = document.getElementById('movesDisplay');
  
  if (!input || !movesDisplay) return;
  
  const amount = Number(input.value);
  if (!Number.isFinite(amount) || amount <= 0) {
    movesDisplay.textContent = 'Enter an amount';
    return;
  }
  
  const moves = Math.floor(amount / MOVE_COST_UCT);
  movesDisplay.textContent = moves > 0 ? `${moves} moves` : 'Need ≥ ' + MOVE_COST_UCT;
}

/**
 * Validate deposit amount from modal input.
 * @returns {number|null} Valid amount in UCT or null if invalid
 */
function validateDepositAmount() {
  const input = document.getElementById('depositAmount');
  const error = document.getElementById('depositError');
  
  if (!input || !error) return null;
  
  const amount = Number(input.value.trim());
  
  if (!Number.isFinite(amount)) {
    error.textContent = '❌ Invalid amount. Please enter a number.';
    error.style.display = 'block';
    return null;
  }
  
  if (amount <= MIN_DEPOSIT_UCT) {
    const minimumMoves = Math.floor(MIN_DEPOSIT_UCT / MOVE_COST_UCT);
    error.textContent = `❌ Deposit must be > ${MIN_DEPOSIT_UCT} ${COIN_ID} (${minimumMoves}+ moves)`;
    error.style.display = 'block';
    return null;
  }
  
  error.style.display = 'none';
  return Math.round(amount * 1e8) / 1e8;
}

/**
 * Registers the player with the game server.
 * Simply stores their wallet identity for balance tracking.
 * @param {object} identity - User's wallet identity { nametag, address }
 * @returns {Promise<boolean>}
 */
async function createPlayerGameWallet(playerAddress) {
  const response = await fetch('/api/create-wallet', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Session-Id': sessionId,
    },
    body: JSON.stringify({ playerAddress }),
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result?.success) {
    throw new Error(result?.error || `Server error: ${response.status}`);
  }

  DEPOSIT_ADDRESS = result.depositAddress;
  GAME_HANDLE = result.handle || result.gameHandle || playerAddress;
  return result;
}

async function syncPlayerBalanceFromServer() {
  if (!userId) return null;

  const balanceResponse = await fetch(`/api/balance?userId=${encodeURIComponent(userId)}`);
  if (!balanceResponse.ok) {
    throw new Error(`Balance check failed: ${balanceResponse.status}`);
  }

  const balanceData = await balanceResponse.json();
  if (balanceData.balance) {
    const { current, movesLeft, totalDeposited, highScore } = balanceData.balance;
    syncGameDepositFromServer(current);
    currentMovesLeft = movesLeft || 0;
    if (highScore && bestEl && Number(highScore) > (parseInt(bestEl.textContent || '0', 10) || 0)) {
      bestEl.textContent = highScore;
    }
    updateBalanceDisplay();
    console.log(`[Balance] Current: ${current} UCT, Moves left: ${movesLeft}, Total deposited: ${totalDeposited} UCT`);
  }

  return balanceData;
}

async function registerPlayerWithGame(identity) {
  try {
    showMessage('🔧 Registering with game…', 'warn');

    const walletAddress = getWalletAddress(identity);
    const canonicalUserId = getCanonicalUserId(identity);
    if (!canonicalUserId) {
      throw new Error('Wallet identity is missing nametag and address');
    }

    const response = await fetch('/api/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Id': sessionId,
      },
      body: JSON.stringify({
        nametag: identity.nametag,
        address: walletAddress,
      }),
    });

    if (!response.ok) {
      throw new Error(`Server error: ${response.status}`);
    }

    const result = await response.json();
    if (!result.success) {
      throw new Error(result.error || 'Failed to register player');
    }

    userId = canonicalUserId;
    GAME_HANDLE = identity.nametag || walletAddress?.slice(0, 12) || 'Player';

    await createPlayerGameWallet(walletAddress || userId);
    walletReady = true;

    const connectResponse = await fetch('/api/connect', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Id': sessionId,
      },
      body: JSON.stringify({ walletId: userId }),
    });
    const connectData = await connectResponse.json().catch(() => ({}));
    if (connectResponse.ok && connectData?.success && connectData.balance) {
      syncGameDepositFromServer(connectData.balance.current);
      currentMovesLeft = connectData.balance.movesLeft || 0;
      const hs = connectData.balance.highScore;
      if (hs && bestEl && Number(hs) > (parseInt(bestEl.textContent || '0', 10) || 0)) {
        bestEl.textContent = hs;
      }
      updateBalanceDisplay();
    } else {
      await syncPlayerBalanceFromServer();
    }

    console.log('[Wallet] ✅ Player registered:', GAME_HANDLE);
    console.log('[Wallet] 📮 Treasury address:', DEPOSIT_ADDRESS);
    console.log('[Wallet] 🎮 userId:', userId);
    showMessage(`💰 Deposit UCT to treasury for ${GAME_HANDLE}`, 'ok');
    updateWalletUI();

    if (currentMovesLeft > 0) {
      showMessage(`💰 Welcome back! You have ${currentMovesLeft} moves`, 'ok');
      try {
        const state = await fetchState();
        applyState(state);
      } catch (stateErr) {
        console.warn('[Game] Could not load existing board:', stateErr.message);
      }
    } else {
      showMessage('💰 Make a deposit to start playing.', 'warn');
    }

    return true;
  } catch (err) {
    console.error('[Wallet] ❌ Failed to register player:', err);
    showMessage(`❌ Wallet setup failed: ${err.message}`, 'err');
    walletReady = false;
    updateWalletUI();
    return false;
  }
}

/**
 * Connects to Sphere wallet via popup/iframe/extension (based on Boxy-Run and SDK example).
 * Uses https://sphere.unicity.network (not unicity-connect:// protocol)
 * Supports iframe mode, extension mode, and popup mode
 * @returns {Promise<boolean>}
 */
async function connectWallet(preOpenedPopup = null) {
  // Reset wallet state to prevent pollution from previous connections
  resetWalletState();
  
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
                const displayName = walletIdentity.nametag || getWalletAddress(walletIdentity)?.slice(0, 20) || 'Sphere Wallet';
                showMessage(`✅ Connected to ${displayName}…`, 'ok');
                updateWalletUI();
                
                if (getCanonicalUserId(walletIdentity)) {
                  registerPlayerWithGame(walletIdentity)
                    .catch(err => console.error('Failed to register with game:', err));
                }
                
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
    const connectUrl = WALLET_URL + '/connect?origin=' + encodeURIComponent(location.origin);
    popupWindow = openWalletPopup(connectUrl, preOpenedPopup);

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

                const displayName = walletIdentity.nametag || getWalletAddress(walletIdentity)?.slice(0, 20) || 'Sphere Wallet';
                showMessage(`✅ Connected to ${displayName}…`, 'ok');
                updateWalletUI();
                
                if (getCanonicalUserId(walletIdentity)) {
                  registerPlayerWithGame(walletIdentity)
                    .catch(err => console.error('Failed to register with game:', err));
                }
                
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
 * Checks UCT balance from the wallet (based on Boxy-Run implementation).
 * Works in iframe, extension, and popup modes.
 * @returns {Promise<void>}
 */
async function checkBalance() {
  if (!isConnected) {
    uctBalance = 0;
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
        uctBalance = null;
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
              uctBalance = null;
            } else if (Array.isArray(msg.result)) {
              // Find UCT in assets array
              const uct = msg.result.find(a => a.symbol === COIN_ID);
              if (uct) {
                uctCoinId = uct.coinId;
                uctDecimals = uct.decimals || UCT_DECIMALS;
                uctBalance = Number(uct.totalAmount) / Math.pow(10, uctDecimals);
              } else {
                uctCoinId = UCT_COIN_ID_HEX;
                uctDecimals = UCT_DECIMALS;
                uctBalance = 0;
              }
            } else {
              uctBalance = 0;
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
        uctBalance = null;
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
    uctBalance = null;
    updateBalanceDisplay();
  }
}

/**
 * Deposits UCT tokens to play the game (based on Boxy-Run implementation).
 * Uses Sphere Connect intent protocol.
 * @returns {Promise<boolean>}
 */
async function depositToPlay(depositAmount) {
  if (!isConnected) {
    showMessage('❌ Wallet not connected', 'err');
    return false;
  }

  if (!walletReady) {
    showMessage('⏳ Game wallet still initializing… Please wait.', 'warn');
    return false;
  }

  if (!getCanonicalUserId(walletIdentity)) {
    showMessage('❌ Wallet identity unavailable. Reconnect your Sphere wallet.', 'err');
    return false;
  }

  if (!GAME_HANDLE) {
    showMessage('❌ Game wallet not ready. Please refresh the page.', 'err');
    return false;
  }

  if (typeof depositAmount !== 'number' || !Number.isFinite(depositAmount)) {
    showMessage('❌ Invalid deposit amount.', 'err');
    return false;
  }

  if (depositAmount <= MIN_DEPOSIT_UCT) {
    const minimumMoves = Math.floor(MIN_DEPOSIT_UCT / MOVE_COST_UCT);
    showMessage(`❌ Deposit must be greater than ${MIN_DEPOSIT_UCT} ${COIN_ID} (more than ${minimumMoves} moves).`, 'err');
    return false;
  }

  if (uctBalance !== null && uctBalance < depositAmount) {
    showMessage(`❌ Insufficient wallet balance. You need at least ${depositAmount} ${COIN_ID} in your wallet.`, 'err');
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
    popupWindow = openWalletPopup(depositUrl, null);
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
    const creditedMoves = Math.floor(depositAmount / MOVE_COST_UCT);
    showMessage(`Opening wallet to deposit ${depositAmount} ${COIN_ID} (${creditedMoves} moves)… Please sign the transaction.`, 'warn');

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
                // Record deposit in backend balance tracking before enabling moves.
                fetch('/api/verify-deposit', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'X-Session-Id': sessionId,
                  },
                  body: JSON.stringify({
                    userId,
                    senderAddress: getWalletAddress(walletIdentity) || userId,
                    uct: depositAmount,
                    txHash: msg.result?.txHash || msg.result?.hash || undefined,
                  }),
                })
                  .then(async (response) => {
                    const data = await response.json().catch(() => ({}));
                    if (!response.ok || !data?.success) {
                      throw new Error(data?.error || `Server error ${response.status}`);
                    }

                    // Sync with backend-tracked balance after credit.
                    if (data?.balance?.current !== undefined) {
                      syncGameDepositFromServer(data.balance.current);
                      currentMovesLeft = data.balance?.movesLeft || 0;
                    }
                    moveCount = 0; // Reset move count on new deposit
                    showMessage(`✅ Deposit received! Sent from your wallet. +${depositAmount} UCT to game. Moves: ${currentMovesLeft}`, 'ok');
                    sessionStorage.setItem(DEPOSIT_KEY, 'true');
                    updateBalanceDisplay();
                    // Force authoritative refresh from server game balance (not personal wallet)
                    fetch(`/api/balance?userId=${encodeURIComponent(userId)}`)
                      .then(r => r.json())
                      .then(b => {
                        if (b?.balance) {
                          if (b.balance.current !== undefined) syncGameDepositFromServer(b.balance.current);
                          if (b.balance.movesLeft !== undefined) currentMovesLeft = b.balance.movesLeft;
                          updateBalanceDisplay();
                        }
                      })
                      .catch(() => {});
                    // Also query personal wallet (will show reduced after spend)
                    checkBalance().catch(err => console.error('Personal wallet balance check failed:', err));
                    resolve(true);
                  })
                  .catch((err) => {
                    console.error('[Deposit] Backend credit failed:', err);
                    showMessage(`❌ Tx sent from wallet but game credit failed: ${err.message}. Try refresh or contact support.`, 'err');
                    // Still attempt to pull latest game balance in case partial success
                    fetch(`/api/balance?userId=${encodeURIComponent(userId)}`).then(r=>r.json()).then(b=>{
                      if (b?.balance?.current) { syncGameDepositFromServer(b.balance.current); currentMovesLeft = b.balance.movesLeft||0; updateBalanceDisplay(); }
                    }).catch(()=>{});
                    resolve(false);
                  });
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
          to: DEPOSIT_ADDRESS,
          amount: depositAmount,
          coinId: uctCoinId,
          memo: `2048:${userId}`
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
  if (gameDepositBalance < MOVE_COST_UCT) {
    showMessage(`❌ Insufficient in-game balance. Need ${MOVE_COST_UCT} UCT, have ${gameDepositBalance}. Please deposit more.`, 'err');
    return false;
  }

  try {
    // Deduct from in-game deposit balance
    gameDepositBalance -= MOVE_COST_UCT;
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
  const movesEl = document.getElementById('gameMoves');
  if (balanceEl) {
    balanceEl.textContent = `${uctBalance !== null ? uctBalance.toFixed(2) : '0.00'} UCT`;
  }
  if (depositEl) {
    depositEl.textContent = `${gameDepositBalance.toFixed(2)} UCT`;
  }
  if (movesEl) {
    movesEl.textContent = String(Math.max(0, currentMovesLeft));
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
    // Show deposit button (disabled until wallet is ready)
    if (depositBtn) {
      depositBtn.style.display = 'block';
      depositBtn.disabled = !walletReady; // Disabled until wallet is ready
      depositBtn.textContent = walletReady 
        ? '💰 Deposit' 
        : '⏳ Initializing wallet…';
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

// ── Session ID ────────────────────────────────────────────────────────────────

/**
 * A stable, per-tab identifier.
 * Stored in sessionStorage so it survives a page refresh but not a new tab.
 * Generates a new one if not found (instead of using empty string).
 */
function initializeSessionId() {
  let id = sessionStorage.getItem('sphere2048-session');
  if (!id || id.trim() === '') {
    // Generate new session ID if not found or empty
    id = `session-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    try {
      sessionStorage.setItem('sphere2048-session', id);
    } catch (err) {
      console.error('[Session] QuotaExceededError:', err.message);
      // Fallback if storage quota exceeded
      id = `session-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    }
  }
  return id;
}

let sessionId = initializeSessionId();

/** Updates the stored session ID when the server returns one. */
function setSessionId(id) {
  if (!id || id.trim() === '') {
    console.warn('[Session] Attempt to set empty session ID, ignoring');
    return;
  }
  sessionId = id;
  try {
    sessionStorage.setItem('sphere2048-session', id);
  } catch (err) {
    console.error('[Session] Failed to persist session ID:', err.message);
  }
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

  const rawBody = await res.text();
  let data = null;
  if (rawBody) {
    try {
      data = JSON.parse(rawBody);
    } catch (err) {
      console.error('[API] Failed to parse response:', err, { path, status: res.status, rawBody });
      throw new Error(rawBody.slice(0, 120) || `API ${path} → ${res.status} (invalid JSON)`);
    }
  }

  if (!res.ok) {
    console.error('[API] Server error:', { path, status: res.status, data, rawBody });
    const msg = data?.errorMessage || data?.error || rawBody || `API ${path} → ${res.status}`;
    if (res.status === 429 || data?.error === 'RATE_LIMITED') {
      throw new Error('Too many requests — slow down and try again in a moment.');
    }
    throw new Error(msg);
  }

  if (data && typeof data.success === 'boolean' && !data.success) {
    console.error('[API] Request failed according to success flag:', { path, data });
    throw new Error(data?.errorMessage || data?.error || `API request failed: ${path}`);
  }

  return data ?? {};
}

/** GET /api/state — returns current game state */
const fetchState = () => api(`/api/state?userId=${userId}`);

/** POST /api/new — resets the game */
const fetchNew   = () => api('/api/new', { method: 'POST', body: JSON.stringify({ userId }) });

/** POST /api/move — applies a directional move */
const fetchMove  = dir =>
  api('/api/move', { method: 'POST', body: JSON.stringify({ userId, direction: dir }) });

/** POST /api/submit-score — persists score for leaderboard */
const fetchSubmit = (score, movesUsed) => api('/api/submit-score', {
  method: 'POST',
  body: JSON.stringify({ userId, score, movesUsed }),
});

/** GET /api/sphere-status — connection info */
const fetchSphereStatus = () => api('/api/sphere-status');

/** GET /api/leaderboard — top players */
const fetchLeaderboard = (limit = 100) => api(`/api/leaderboard?limit=${limit}`);

// ─── DOM References ───────────────────────────────────────────────────────────

const boardEl        = document.getElementById('board');
const scoreEl        = document.getElementById('score');
const bestEl         = document.getElementById('best');
const statusToastEl  = document.getElementById('statusToast');
const overlayEl      = document.getElementById('overlay');
const overlayTitleEl = document.getElementById('overlayTitle');
const overlayMsgEl   = document.getElementById('overlayMsg');
const leaderboardOverlayEl = document.getElementById('leaderboardOverlay');
const leaderboardBodyEl = document.getElementById('leaderboardBody');
const btnLeaderboard = document.getElementById('btnLeaderboard');
const btnLeaderboardClose = document.getElementById('btnLeaderboardClose');
const btnNew         = document.getElementById('btnNew');
const btnNewOverlay  = document.getElementById('btnNewOverlay');

/** Leaderboard cache to avoid excessive API calls while popup is toggled repeatedly. */
const leaderboardCache = {
  entries: null,
  fetchedAt: 0,
};
const LEADERBOARD_CACHE_TTL_MS = 15_000;

function shortWalletId(value) {
  if (!value) return 'Unknown';
  if (value.length <= 22) return value;
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function normalizeLeaderboardEntry(item, index) {
  return {
    rank: item.rank ?? index + 1,
    walletId: item.walletId ?? item.wallet_id ?? item.userId ?? item.user_id ?? 'Unknown',
    highScore: Number(item.highScore ?? item.high_score ?? item.score ?? 0),
    totalMoves: Number(item.totalMoves ?? item.total_moves ?? item.moves_used ?? 0),
    gameCount: Number(item.gameCount ?? item.game_count ?? 0),
  };
}

function renderLeaderboardRows(entries) {
  if (!leaderboardBodyEl) return;

  const normalized = (Array.isArray(entries) ? entries : [])
    .map(normalizeLeaderboardEntry)
    .filter((item) => item.highScore > 0 && item.walletId !== 'Unknown');

  let html = '<div class="leaderboard-row header"><div>Rank</div><div>Player</div><div style="text-align:right;">High Score</div><div style="text-align:right;">Moves</div><div style="text-align:right;">Games</div></div>';

  if (!normalized.length) {
    html += '<div class="leaderboard-empty">🎮 No games played yet. Start playing to appear on the leaderboard!</div>';
    leaderboardBodyEl.innerHTML = html;
    return;
  }

  normalized.forEach((item, index) => {
    const rank = index + 1;
    const playerName = shortWalletId(item.walletId);
    let rankBadge = `#${rank}`;
    if (rank === 1) rankBadge = '🥇';
    else if (rank === 2) rankBadge = '🥈';
    else if (rank === 3) rankBadge = '🥉';

    html += `<div class="leaderboard-row" data-rank="${rank}"><div class="leaderboard-rank">${rankBadge}</div><div class="leaderboard-player" title="${item.walletId}">${playerName}</div><div class="leaderboard-score">${item.highScore}</div><div class="leaderboard-moves">${item.totalMoves}</div><div style="text-align:right;">${item.gameCount || 1}</div></div>`;
  });

  leaderboardBodyEl.innerHTML = html;
}

async function loadLeaderboard(forceRefresh = false) {
  const now = Date.now();
  const cacheValid = !forceRefresh
    && Array.isArray(leaderboardCache.entries)
    && (now - leaderboardCache.fetchedAt) < LEADERBOARD_CACHE_TTL_MS;

  if (cacheValid) {
    renderLeaderboardRows(leaderboardCache.entries);
    return;
  }

  if (leaderboardBodyEl) {
    leaderboardBodyEl.innerHTML = '<div class="leaderboard-empty">⏳ Loading leaderboard…</div>';
  }

  try {
    const result = await fetchLeaderboard(100);
    const entries = Array.isArray(result?.leaderboard) ? result.leaderboard : [];
    leaderboardCache.entries = entries;
    leaderboardCache.fetchedAt = Date.now();
    console.log('[Leaderboard] Loaded', entries.length, 'players');
    renderLeaderboardRows(entries);
  } catch (err) {
    console.error('[Leaderboard] Load error:', err);

    if (Array.isArray(leaderboardCache.entries)) {
      renderLeaderboardRows(leaderboardCache.entries);
      showMessage('⚠️ Showing cached leaderboard. Refresh again in a moment.', 'warn');
      return;
    }

    const isRateLimited = /rate limit|too many requests/i.test(err.message || '');
    if (leaderboardBodyEl) {
      leaderboardBodyEl.innerHTML = `<div class="leaderboard-empty">❌ ${isRateLimited
        ? 'Too many requests. Please wait a moment and try again.'
        : 'Failed to load leaderboard. Please try again.'}</div>`;
    }
  }
}

async function openLeaderboard() {
  if (!leaderboardOverlayEl) return;
  leaderboardOverlayEl.classList.add('active');
  // Always refresh when opening to show latest scores
  await loadLeaderboard(true);
  leaderboardOverlayEl.setAttribute('aria-hidden', 'false');
}

function closeLeaderboard() {
  if (!leaderboardOverlayEl) return;
  leaderboardOverlayEl.classList.remove('active');
  leaderboardOverlayEl.setAttribute('aria-hidden', 'true');
}

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
  
  // Track current game state
  currentScore = state.score;
  if (state.balance?.movesLeft !== undefined) {
    currentMovesLeft = state.balance.movesLeft;
    updateBalanceDisplay();
    if (currentMovesLeft === 0 && state.score > 0 && !scoreSubmitted) {
      console.log('[State] Moves reached 0. Auto-saving score...');
      autoSubmitScore(state.score, state.board).catch(err => 
        console.error('Auto-submit when moves=0 failed:', err)
      );
    }
  }
  // Always prefer server authoritative highScore for BEST display if higher (fixes missing high scores on refresh)
  const serverHigh = state.balance?.highScore ?? state.highScore;
  if (serverHigh != null) {
    const serverBest = Number(serverHigh) || 0;
    const currentBest = parseInt(bestEl?.textContent || '0', 10) || 0;
    if (serverBest > currentBest) {
      if (bestEl) bestEl.textContent = serverBest;
    }
  }
  
  // Log balance info from state
  if (state.balance) {
    if (state.balance.current !== undefined) {
      syncGameDepositFromServer(state.balance.current);
      updateBalanceDisplay();
    }
    console.log('[State] Balance info:', state.balance);
  }

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

let statusToastTimer = null;

/**
 * Shows a compact toast above the board for important feedback only.
 * Routine gameplay status (score/moves) is omitted — see header counters.
 * @param {string} text
 * @param {'ok'|'err'|'warn'|''} type
 */
function showMessage(text, type = '') {
  if (!statusToastEl || !text) return;

  const isRoutineGameplay =
    type === '' ||
    (type === 'ok' && (/^Score:/i.test(text) || /^Use arrow keys/i.test(text) || /^Loading game/i.test(text)));

  if (isRoutineGameplay) return;

  statusToastEl.hidden = false;
  statusToastEl.className = `status-toast ${type || 'warn'}`.trim();
  statusToastEl.textContent = text;

  if (statusToastTimer) clearTimeout(statusToastTimer);
  const duration = type === 'err' ? 7000 : 4500;
  statusToastTimer = setTimeout(() => {
    statusToastEl.hidden = true;
    statusToastEl.textContent = '';
  }, duration);
}

// ─── Sphere Status Pill ───────────────────────────────────────────────────────

/** Sphere chain status is polled silently (no on-screen pill). */
async function pollSphereStatus() {
  try {
    await fetchSphereStatus();
    setTimeout(pollSphereStatus, 60_000);
  } catch {
    setTimeout(pollSphereStatus, 60_000);
  }
}

// ─── Actions ──────────────────────────────────────────────────────────────────

/** Starts a fresh game. */
async function newGame() {
  // MANDATORY: userId must be set
  if (!userId) {
    showMessage('❌ Error: userId not set. Please reconnect your wallet.', 'err');
    console.error('newGame: userId is null!');
    return;
  }

  // MANDATORY: Wallet must be connected before game can start
  if (!isConnected) {
    showMessage('⚠️  Wallet connection required. Connecting…', 'warn');
    const tryConnect = await connectWallet();
    if (!tryConnect) {
      showMessage('❌ Wallet connection is required to play. Please connect your wallet first.', 'err');
      return;
    }
  }

  // Check if user has moves available
  try {
    console.log('[Game] Checking moves before starting...');
    const balResponse = await fetch(`/api/balance?userId=${userId}`);
    if (balResponse.ok) {
      const bal = await balResponse.json();
      if (bal.balance?.movesLeft <= 0) {
        showMessage(`❌ No moves available. Make a deposit to play!`, 'err');
        console.log(`[Game] Test deposit: curl -X POST http://localhost:5000/api/test-deposit -H "Content-Type: application/json" -d '{"userId":"${userId}","uct":100}'`);
        return;
      }
    }
  } catch (err) {
    console.error('[Game] Failed to check moves:', err);
  }

  // Reset move count for new game
  moveCount = 0;
  scoreSubmitted = false;
  overlayEl.classList.remove('active');
  try {
    console.log('[Game] Calling fetchNew for userId:', userId);
    const state = await fetchNew();
    console.log('[Game] New game state received:', state);
    currentMovesLeft = state.balance?.movesLeft || 0;
    applyState(state);
  } catch (err) {
    showMessage(`Error: ${err.message}`, 'err');
    console.error('[Game] newGame failed:', err);
  }
}

/** Applies a directional move, then updates the board. */
async function doMove(direction) {
  // MANDATORY: userId must be set
  if (!userId) {
    showMessage('❌ Error: userId not set. Please reconnect your wallet.', 'err');
    console.error('[Move] userId is null! Cannot make move.');
    return;
  }

  // MANDATORY: Wallet must be connected to make moves
  if (!isConnected) {
    showMessage('❌ Wallet not connected. Please connect your wallet first.', 'err');
    return;
  }

  // CRITICAL: Prevent invalid moves when no moves are left
  if (currentMovesLeft <= 0) {
    showMessage('❌ No moves left. Please deposit more tokens to continue.', 'err');
    console.warn('[Move] Attempt to move with 0 moves left. Prevented.');
    return;
  }

  // Validate direction
  if (!['left', 'right', 'up', 'down'].includes(direction)) {
    console.error('[Move] Invalid direction:', direction);
    return;
  }

  // Prevent spam clicks - only allow one move request at a time
  if (moveRequestInFlight) {
    console.warn('[Move] Request already in flight. Ignoring duplicate request.');
    return;
  }

  // Set request lock
  moveRequestInFlight = true;

  try {
    console.log(`[Move] Making move: ${direction}, userId: ${userId}`);
    const state = await fetchMove(direction);
    
    // Check if server rejected the move due to insufficient balance
    if (state.canPlay === false) {
      showMessage(`❌ Insufficient balance. Need 0.1 UCT per move.`, 'err');
      console.warn('[Move] Server returned canPlay=false');
      // Don't apply state on error to preserve game state
      return;
    }
    
    // Only apply state if move was successful (no errors)
    applyState(state);

    // CRITICAL FIX: Update currentMovesLeft immediately from server response
    // This prevents stale state where the UI thinks there are moves but there aren't
    if (state.balance?.movesLeft !== undefined) {
      currentMovesLeft = state.balance.movesLeft;
      lastBalanceState = state.balance;
      lastBalanceSyncTime = Date.now();
      console.log(`[Move] Synced moves: ${currentMovesLeft}`);
    }

    // Force sync game balance display and moves from the authoritative server response
    if (state.balance?.current !== undefined) {
      syncGameDepositFromServer(state.balance.current);
    }
    updateBalanceDisplay();

    if (!state.moved) {
      showMessage('No tiles moved — try another direction.', 'warn');
    } else {
      if (currentMovesLeft === 0 && state.score > 0 && !scoreSubmitted) {
        console.log('[Move] Moves reached 0 after this move. Auto-saving score...');
        autoSubmitScore(state.score, state.board).catch(err => 
          console.error('Auto-submit when moves=0 failed:', err)
        );
      }

      moveCount++;
      if (moveCount >= AUTO_SUBMIT_MOVE_COUNT && !scoreSubmitted) {
        await autoSubmitScore(state.score, state.board);
      }
    }
  } catch (err) {
    console.error('[Move] Error:', err);
    showMessage(`Move error: ${err.message}`, 'err');
    // CRITICAL: Do NOT modify game state on error
    // Fetch fresh state from server to ensure we're in sync
    try {
      console.log('[Move] Fetching fresh state after error to resync...');
      const freshState = await fetchState();
      applyState(freshState);
      console.log('[Move] State resync complete');
    } catch (resyncErr) {
      console.error('[Move] Failed to resync state after error:', resyncErr);
      showMessage('⚠️  State sync failed. Please refresh the page.', 'err');
    }
  } finally {
    // Always release the request lock
    moveRequestInFlight = false;
  }
}

/** Automatically submits score to blockchain after X moves */
async function autoSubmitScore(score, board) {
  if (scoreSubmitted || score === 0) return;
  
  showMessage(`Auto-submitting score after ${moveCount} moves… ⛓`, 'warn');
  try {
    const result = await fetchSubmit(score, moveCount);
    if (result.success) {
      scoreSubmitted = true;
      showMessage(`✅ Score ${score} auto-submitted! Event ID: ${result.eventId}`, 'ok');
      // Refresh leaderboard after successful submission
      setTimeout(() => loadLeaderboard(true).catch(err => console.error('[Leaderboard] Refresh failed:', err)), 1000);
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

const SWIPE_MIN_DISTANCE = 28;
let dragStartX = 0;
let dragStartY = 0;
let dragTracking = false;
let dragOnBoard = false;

/**
 * @param {number} startX
 * @param {number} startY
 * @param {number} endX
 * @param {number} endY
 * @returns {'left'|'right'|'up'|'down'|null}
 */
function directionFromDrag(startX, startY, endX, endY) {
  const dx = endX - startX;
  const dy = endY - startY;
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  if (Math.max(absX, absY) < SWIPE_MIN_DISTANCE) return null;
  return absX > absY
    ? (dx > 0 ? 'right' : 'left')
    : (dy > 0 ? 'down' : 'up');
}

/**
 * @param {number} endX
 * @param {number} endY
 */
function finishDrag(endX, endY) {
  if (!dragTracking) return;
  dragTracking = false;
  const direction = directionFromDrag(dragStartX, dragStartY, endX, endY);
  if (direction) tryMove(direction);
}

/**
 * Shared gate for keyboard, swipe, and drag input.
 * @returns {boolean}
 */
function canAttemptMove() {
  if (!isConnected) {
    showMessage('❌ Please connect your wallet first!', 'err');
    return false;
  }
  if (currentMovesLeft <= 0) {
    showMessage('❌ No moves left. Please deposit more tokens.', 'err');
    return false;
  }
  if (moveRequestInFlight) {
    return false;
  }
  return true;
}

/**
 * @param {'left'|'right'|'up'|'down'} direction
 */
function tryMove(direction) {
  if (!canAttemptMove()) return;
  doMove(direction);
}

/** Keyboard: arrow keys map to move directions. */
document.addEventListener('keydown', e => {
  const map = {
    ArrowLeft: 'left', ArrowRight: 'right',
    ArrowUp:   'up',   ArrowDown:  'down',
  };
  if (map[e.key]) {
    e.preventDefault();
    tryMove(map[e.key]);
  }
});

/** Swipe (touch) and drag (mouse) on board to move */
const boardWrapEl = document.getElementById('boardWrap');
if (boardWrapEl) {
  boardWrapEl.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    dragTracking = true;
    dragStartX = e.touches[0].clientX;
    dragStartY = e.touches[0].clientY;
  }, { passive: true });

  boardWrapEl.addEventListener('touchmove', (e) => {
    if (!dragTracking || e.touches.length !== 1) return;
    const dx = Math.abs(e.touches[0].clientX - dragStartX);
    const dy = Math.abs(e.touches[0].clientY - dragStartY);
    if (dx > 8 || dy > 8) e.preventDefault();
  }, { passive: false });

  boardWrapEl.addEventListener('touchend', (e) => {
    const touch = e.changedTouches[0];
    if (!touch) return;
    finishDrag(touch.clientX, touch.clientY);
  }, { passive: true });

  boardWrapEl.addEventListener('touchcancel', () => {
    dragTracking = false;
  }, { passive: true });

  boardWrapEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragOnBoard = true;
    dragTracking = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
  });

  window.addEventListener('mouseup', (e) => {
    if (!dragOnBoard) return;
    dragOnBoard = false;
    finishDrag(e.clientX, e.clientY);
  });
}

/** Wallet connection button */
document.getElementById('btnConnectWallet').addEventListener('click', async () => {
  if (isConnected) {
    showMessage('Already connected!', 'ok');
    return;
  }
  const popupSeed = window.open('about:blank', `sphere-wallet-seed-${Date.now()}`, POPUP_FEATURES);
  if (!popupSeed) {
    showMessage('⚠️  Popup blocked. Please allow popups for ' + WALLET_URL, 'err');
    return;
  }
  await connectWallet(popupSeed);
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
    openDepositModal();
  });
}

// Deposit modal handlers
const depositOverlay = document.getElementById('depositOverlay');
const depositAmount = document.getElementById('depositAmount');
const btnDepositConfirm = document.getElementById('btnDepositConfirm');
const btnDepositCancel = document.getElementById('btnDepositCancel');
const btnDepositClose = document.getElementById('btnDepositClose');

// Close modal on cancel/X buttons
if (btnDepositCancel) {
  btnDepositCancel.addEventListener('click', closeDepositModal);
}
if (btnDepositClose) {
  btnDepositClose.addEventListener('click', closeDepositModal);
}

// Close modal when clicking overlay background
if (depositOverlay) {
  depositOverlay.addEventListener('click', (e) => {
    if (e.target === depositOverlay) {
      closeDepositModal();
    }
  });
}

// Update moves display when input changes
if (depositAmount) {
  depositAmount.addEventListener('input', updateMovesDisplay);
  depositAmount.addEventListener('change', updateMovesDisplay);
}

// Handle deposit confirmation
if (btnDepositConfirm) {
  btnDepositConfirm.addEventListener('click', async () => {
    const amount = validateDepositAmount();
    if (amount === null) {
      return; // Validation error shown in modal
    }
    
    btnDepositConfirm.disabled = true;
    btnDepositConfirm.textContent = 'Processing...';
    
    closeDepositModal();
    await depositToPlay(amount);
    
    btnDepositConfirm.textContent = '✓ Confirm';
    btnDepositConfirm.disabled = false;
    updateWalletUI();
  });
}

/** New game buttons */
btnNew.addEventListener('click', newGame);
btnNewOverlay.addEventListener('click', newGame);

/** Leaderboard button and popup interactions */
if (btnLeaderboard) {
  btnLeaderboard.addEventListener('click', () => {
    openLeaderboard().catch((err) => {
      console.error('[Leaderboard] Open failed:', err);
      showMessage(`❌ Failed to load leaderboard: ${err.message}`, 'err');
    });
  });
}

if (btnLeaderboardClose) {
  btnLeaderboardClose.addEventListener('click', closeLeaderboard);
}

if (leaderboardOverlayEl) {
  leaderboardOverlayEl.addEventListener('click', (event) => {
    if (event.target === leaderboardOverlayEl) {
      closeLeaderboard();
    }
  });
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && leaderboardOverlayEl?.classList.contains('active')) {
    closeLeaderboard();
  }
});

// Submit button removed - auto-submit is used instead

// ─── Boot ─────────────────────────────────────────────────────────────────────

function renderEmptyBoard() {
  renderBoard([
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  scoreEl.textContent = '0';
  bestEl.textContent = '0';
}

(async () => {
  renderEmptyBoard();

  if (!isConnected) {
    showMessage('Connect your Sphere wallet and deposit UCT to start playing.', 'warn');
  }

  pollSphereStatus();
})();
