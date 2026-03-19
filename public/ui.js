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
let userId = null; // User ID for game state tracking
let GAME_HANDLE = null; // Player's game wallet display (e.g., "fraey_2048")
let DEPOSIT_ADDRESS = null; // Actual server wallet address to send deposits to
const MOVE_COST_UTC = 0.1; // Cost per move in UCT
const MIN_DEPOSIT_UTC = 1; // Deposit must be strictly greater than this amount
const DEFAULT_DEPOSIT_UTC = 10;
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
 * Prompt the player for a deposit amount and validate it.
 * Rules:
 *   - Must be a finite number
 *   - Must be strictly greater than MIN_DEPOSIT_UTC
 * @returns {number|null} Valid amount in UCT or null when cancelled/invalid
 */
function promptDepositAmount() {
  const input = window.prompt(
    `Enter deposit amount in ${COIN_ID} (must be > ${MIN_DEPOSIT_UTC}):`,
    String(DEFAULT_DEPOSIT_UTC)
  );

  if (input === null) {
    return null;
  }

  const amount = Number(input.trim());
  if (!Number.isFinite(amount)) {
    showMessage('❌ Invalid amount. Please enter a number.', 'err');
    return null;
  }

  if (amount <= MIN_DEPOSIT_UTC) {
    const minimumMoves = Math.floor(MIN_DEPOSIT_UTC / MOVE_COST_UTC);
    showMessage(`❌ Deposit must be greater than ${MIN_DEPOSIT_UTC} ${COIN_ID} (more than ${minimumMoves} moves).`, 'err');
    return null;
  }

  return Math.round(amount * 1e8) / 1e8;
}

/**
 * Registers the player with the game server.
 * Simply stores their wallet identity for balance tracking.
 * @param {object} identity - User's wallet identity { nametag, address }
 * @returns {Promise<boolean>}
 */
async function registerPlayerWithGame(identity) {
  try {
    showMessage('🔧 Registering with game…', 'warn');
    
    const response = await fetch('/api/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Id': sessionId,
      },
      body: JSON.stringify({ 
        nametag: identity.nametag,
        address: identity.address 
      }),
    });

    if (!response.ok) {
      throw new Error(`Server error: ${response.status}`);
    }

    const result = await response.json();

    if (result.success) {
      userId = result.userId;
      GAME_HANDLE = identity.nametag || identity.address?.slice(0, 12) || 'Player';
      DEPOSIT_ADDRESS = result.treasuryAddress;
      walletReady = true;
      console.log('[Wallet] ✅ Player registered:', GAME_HANDLE);
      console.log('[Wallet] 📮 Treasury address:', DEPOSIT_ADDRESS);
      console.log('[Wallet] 🎮 userId:', userId);
      showMessage(`💰 Send UCT to: ${GAME_HANDLE}`, 'ok');
      updateWalletUI();
      
      // Check game balance from server
      try {
        console.log('[Balance] Fetching user balance...');
        const balanceResponse = await fetch(`/api/balance?userId=${userId}`);
        if (balanceResponse.ok) {
          const balanceData = await balanceResponse.json();
          console.log('[Balance] User balance:', balanceData);
          if (balanceData.balance) {
            const { current, movesLeft, totalDeposited } = balanceData.balance;
            syncGameDepositFromServer(current);
            updateBalanceDisplay();
            console.log(`[Balance] Current: ${current} UCT, Moves left: ${movesLeft}, Total deposited: ${totalDeposited} UCT`);
            if (movesLeft > 0) {
              showMessage(`💰 Welcome back! You have ${movesLeft} moves (${current} UCT)`, 'ok');
              // FIXED: Don't auto-start game - just update balance and show state
              // User can start game manually if they want
              return true;
            } else {
              // No moves - show test deposit info
              showMessage(`💰 You need to make a deposit! Send UCT to the treasury (2048game) or use test endpoint.`, 'warn');
              console.log('[Balance] No moves available - test deposit with: curl -X POST http://localhost:5000/api/test-deposit -H "Content-Type: application/json" -d \'{"userId":"' + userId + '","uct":100}\'');
              return true;
            }
          }
        }
      } catch (balErr) {
        console.error('[Balance] Failed to check game balance:', balErr);
      }
    } else {
      throw new Error(result.error || 'Failed to register player');
    }
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
                
                // Register with game server
                if (walletIdentity.nametag || walletIdentity.address) {
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
                
                // Register with game server
                if (walletIdentity.nametag || walletIdentity.address) {
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
async function depositToPlay(depositAmount) {
  if (!isConnected) {
    showMessage('❌ Wallet not connected', 'err');
    return false;
  }

  if (!walletReady) {
    showMessage('⏳ Game wallet still initializing… Please wait.', 'warn');
    return false;
  }

  if (!walletIdentity?.nametag) {
    showMessage('❌ Unicity ID required. Please register a Unicity ID in Sphere to play.', 'err');
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

  if (depositAmount <= MIN_DEPOSIT_UTC) {
    const minimumMoves = Math.floor(MIN_DEPOSIT_UTC / MOVE_COST_UTC);
    showMessage(`❌ Deposit must be greater than ${MIN_DEPOSIT_UTC} ${COIN_ID} (more than ${minimumMoves} moves).`, 'err');
    return false;
  }

  if (utcBalance !== null && utcBalance < depositAmount) {
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
    const creditedMoves = Math.floor(depositAmount / MOVE_COST_UTC);
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
                    senderAddress: walletIdentity?.address || userId,
                    uct: depositAmount,
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
                    updateMoveButtonStates(); // Re-enable move buttons
                    showMessage(`✅ Deposited ${depositAmount} ${COIN_ID}! In-game balance: ${gameDepositBalance.toFixed(2)} UTC. Moves available: ${currentMovesLeft}`, 'ok');
                    sessionStorage.setItem(DEPOSIT_KEY, 'true');
                    updateBalanceDisplay();
                    checkBalance().catch(err => console.error('Balance check failed:', err));
                    resolve(true);
                  })
                  .catch((err) => {
                    console.error('[Deposit] Backend credit failed:', err);
                    showMessage(`❌ Deposit recorded in wallet but failed to credit game balance: ${err.message}`, 'err');
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
    depositEl.textContent = `${gameDepositBalance.toFixed(2)} UTC`;
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
  
  const data = await res.json().catch(err => {
    console.error('[API] Failed to parse response:', err);
    throw new Error(`API ${path} → ${res.status} (invalid JSON)`);
  });
  
  // Check for error responses from server
  if (!res.ok) {
    console.error('[API] Server error:', { path, status: res.status, data });
    throw new Error(data?.errorMessage || data?.error || `API ${path} → ${res.status}`);
  }
  
  // Additional safety check: if success flag exists and is false, treat as error
  if (data && typeof data.success === 'boolean' && !data.success) {
    console.error('[API] Request failed according to success flag:', { path, data });
    throw new Error(data?.errorMessage || data?.error || `API request failed: ${path}`);
  }
  
  return data;
}

/** GET /api/state — returns current game state */
const fetchState = () => api(`/api/state?userId=${userId}`);

/** POST /api/new — resets the game */
const fetchNew   = () => api('/api/new', { method: 'POST', body: JSON.stringify({ userId }) });

/** POST /api/move — applies a directional move */
const fetchMove  = dir =>
  api('/api/move', { method: 'POST', body: JSON.stringify({ userId, direction: dir }) });

/** POST /api/submit-score — publishes score to blockchain */
const fetchSubmit = () => api('/api/submit-score', { method: 'POST', body: JSON.stringify({ userId }) });

/** GET /api/sphere-status — connection info */
const fetchSphereStatus = () => api('/api/sphere-status');

/** GET /api/leaderboard — top players */
const fetchLeaderboard = (limit = 100) => api(`/api/leaderboard?limit=${limit}`);

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

function renderLeaderboardRows(entries) {
  if (!leaderboardBodyEl) return;

  // Optimized: Use innerHTML for batch rendering (much faster than DOM manipulation)
  let html = '<div class="leaderboard-row header"><div>Rank</div><div>Player</div><div style="text-align:right;">High Score</div><div style="text-align:right;">Moves</div></div>';

  if (!entries.length) {
    html += '<div class="leaderboard-empty">No players on the board yet. Play a few rounds to populate it.</div>';
    leaderboardBodyEl.innerHTML = html;
    return;
  }

  // Build all HTML at once
  for (const item of entries) {
    const playerName = shortWalletId(item.walletId);
    html += `<div class="leaderboard-row"><div class="leaderboard-rank">#${item.rank}</div><div class="leaderboard-player" title="${item.walletId}">${playerName}</div><div class="leaderboard-score">${item.highScore ?? 0}</div><div class="leaderboard-moves">${item.totalMoves ?? 0}</div></div>`;
  }

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
    leaderboardBodyEl.innerHTML = '<div class="leaderboard-empty">Refreshing leaderboard…</div>';
  }

  try {
    const result = await fetchLeaderboard(100);
    const entries = Array.isArray(result?.leaderboard) ? result.leaderboard : [];
    leaderboardCache.entries = entries;
    leaderboardCache.fetchedAt = Date.now();
    renderLeaderboardRows(entries);
  } catch (err) {
    console.error('[Leaderboard] Load error:', err);
    if (leaderboardBodyEl) {
      leaderboardBodyEl.innerHTML = '<div class="leaderboard-empty">Failed to load leaderboard</div>';
    }
  }
}
}

async function openLeaderboard() {
  if (!leaderboardOverlayEl) return;
  leaderboardOverlayEl.classList.add('active');
  leaderboardOverlayEl.setAttribute('aria-hidden', 'false');
  await loadLeaderboard(false);
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
 * Updates the visual state of all move buttons based on game conditions.
 * Disables buttons when:
 *   - No wallet is connected
 *   - Game is over
 *   - No moves are left
 *   - A move request is in flight
 */
function updateMoveButtonStates() {
  const arrowPad = document.querySelector('.arrow-pad');
  if (!arrowPad) return;
  
  const buttons = arrowPad.querySelectorAll('button[data-dir]');
  const shouldDisable = !isConnected || currentMovesLeft <= 0 || moveRequestInFlight;
  
  buttons.forEach(btn => {
    if (shouldDisable) {
      btn.disabled = true;
      btn.style.opacity = '0.5';
      btn.style.cursor = 'not-allowed';
    } else {
      btn.disabled = false;
      btn.style.opacity = '1';
      btn.style.cursor = 'pointer';
    }
  });
  
  // Also disable keyboard if no moves
  if (currentMovesLeft <= 0 && !moveRequestInFlight) {
    // Show feedback to user
    if (currentMovesLeft === 0) {
      showMessage('❌ No moves left. Please deposit more tokens to continue.', 'err');
    }
  }
}

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
    // CRITICAL: Auto-save score when moves reach 0
    if (currentMovesLeft === 0 && state.score > 0 && !scoreSubmitted) {
      console.log('[State] Moves reached 0. Auto-saving score...');
      autoSubmitScore(state.score, state.board).catch(err => 
        console.error('Auto-submit when moves=0 failed:', err)
      );
    }
  }
  
  // Update button states based on available moves
  updateMoveButtonStates();
  
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

  spherePillEl.textContent = '';

  const label = document.createElement('strong');
  label.textContent = '⛓ Sphere:';
  spherePillEl.appendChild(label);

  if (!connected) {
    spherePillEl.appendChild(document.createTextNode(' Not connected — score submission disabled.'));
    return;
  }

  spherePillEl.appendChild(document.createTextNode(` Connected to Unicity (${wallet.network})`));
  if (wallet.nametag) spherePillEl.appendChild(document.createTextNode(` · @${wallet.nametag}`));
  if (wallet.address) spherePillEl.appendChild(document.createTextNode(` · ${wallet.address.slice(0, 20)}…`));
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
  showMessage('Starting new game…');
  try {
    console.log('[Game] Calling fetchNew for userId:', userId);
    const state = await fetchNew();
    console.log('[Game] New game state received:', state);
    // Update moves tracking
    currentMovesLeft = state.balance?.movesLeft || 0;
    updateMoveButtonStates();
    applyState(state);
    showMessage(`Use arrow keys or buttons to move tiles. Moves left: ${state.balance?.movesLeft ?? '?'}`);
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
  updateMoveButtonStates();

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

    if (state.moveBatch?.txHash) {
      showMessage(
        `⛓ Batched ${state.moveBatch.count} moves on-chain. Tx: ${state.moveBatch.txHash.slice(0, 18)}…`,
        'ok'
      );
      return;
    }
    
    if (!state.moved) {
      showMessage('No tiles moved — try another direction.', 'warn');
    } else {
      const movesLeft = state.balance?.movesLeft ?? '?';
      showMessage(
        state.gameOver
          ? `Game over! Final score: ${state.score}. Moves left: ${movesLeft}`
          : state.won
            ? `🎉 You reached 2048! Score: ${state.score}. Moves left: ${movesLeft}`
            : `Score: ${state.score}. Moves left: ${movesLeft}`,
        state.gameOver ? 'err' : state.won ? 'ok' : ''
      );

      // Check if moves reached 0 after this move
      if (currentMovesLeft === 0 && state.score > 0 && !scoreSubmitted) {
        console.log('[Move] Moves reached 0 after this move. Auto-saving score...');
        autoSubmitScore(state.score, state.board).catch(err => 
          console.error('Auto-submit when moves=0 failed:', err)
        );
      }

      // Auto-submit after X moves
      if (moveCount >= AUTO_SUBMIT_MOVE_COUNT && !scoreSubmitted) {
        moveCount++;
        await autoSubmitScore(state.score, state.board);
      } else {
        moveCount++;
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
    updateMoveButtonStates();
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
    // Only allow moves if wallet is connected, has moves, and no request is pending
    if (!isConnected) {
      showMessage('❌ Please connect your wallet first!', 'err');
      return;
    }
    if (currentMovesLeft <= 0) {
      showMessage('❌ No moves left. Please deposit more tokens.', 'err');
      return;
    }
    if (moveRequestInFlight) {
      console.warn('[Keyboard] Move request already in flight, ignoring');
      return;
    }
    doMove(map[e.key]);
  }
});

/** Mobile arrow pad buttons */
document.querySelector('.arrow-pad').addEventListener('click', e => {
  const btn = e.target.closest('[data-dir]');
  if (btn) {
    // Only allow moves if wallet is connected, has moves, and no request is pending
    if (!isConnected) {
      showMessage('❌ Please connect your wallet first!', 'err');
      return;
    }
    if (currentMovesLeft <= 0) {
      showMessage('❌ No moves left. Please deposit more tokens.', 'err');
      return;
    }
    if (moveRequestInFlight) {
      console.warn('[Mobile] Move request already in flight, ignoring');
      return;
    }
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
    const depositAmount = promptDepositAmount();
    if (depositAmount === null) {
      updateWalletUI();
      return;
    }

    btnDeposit.disabled = true;
    btnDeposit.textContent = 'Processing...';
    await depositToPlay(depositAmount);
    btnDeposit.textContent = '💰 Deposit';
    btnDeposit.disabled = false;
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

(async () => {
  showMessage('Loading game…');

  try {
    // Load (or create) a game on the server
    const state = await fetchState();
    applyState(state);
    
    // Show message that wallet connection is required
    if (!isConnected) {
      showMessage('⚠️  Please connect your wallet and deposit UTC tokens to start playing.', 'warn');
    } else {
      showMessage('Use arrow keys or buttons to move tiles.');
    }
  } catch (err) {
    showMessage(`Failed to load game: ${err.message}`, 'err');
  }

  // Start Sphere status polling in the background
  pollSphereStatus();
})();
