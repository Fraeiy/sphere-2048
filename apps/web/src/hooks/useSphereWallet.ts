import { useCallback, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';

const WALLET_URL = import.meta.env.VITE_SPHERE_WALLET_URL ?? 'https://sphere.unicity.network';
const SESSION_KEY = 'sphere2048-wallet-session';
const HOST_READY_TYPE = 'sphere-connect:host-ready';
const HOST_READY_TIMEOUT = 30_000;
const CONNECT_TIMEOUT = 30_000;
const POPUP_FEATURES = 'width=420,height=650';
const UCT_COIN_ID_HEX = '455ad8720656b08e8dbd5bac1f3c73eeea5431565f6c1c3af742b1aa12d41d89';

const DAPP_META = {
  name: '2048 × Sphere',
  description: '2048 game with Unicity blockchain integration',
  url: typeof location !== 'undefined' ? location.origin : '',
};

const SPHERE_PERMISSIONS = [
  'identity:read',
  'balance:read',
  'tokens:read',
  'transfer:request',
] as const;

export interface SphereIdentity {
  did: string;
  nametag: string | null;
  l1Address: string;
}

interface RawSphereIdentity {
  did?: string;
  nametag?: string;
  l1Address?: string;
  directAddress?: string;
  address?: string;
}

interface SphereConnectMessage {
  ns?: string;
  v?: string;
  type?: string;
  direction?: string;
  sessionId?: string;
  identity?: RawSphereIdentity;
  error?: { message?: string };
}

function isSphereMessage(msg: unknown): msg is SphereConnectMessage {
  const m = msg as SphereConnectMessage;
  return m?.ns === 'sphere-connect' && m?.v === '1.0';
}

function getWalletAddress(identity: RawSphereIdentity | null | undefined): string | null {
  if (!identity) return null;
  return identity.l1Address || identity.directAddress || identity.address || null;
}

function getCanonicalUserId(identity: RawSphereIdentity | null | undefined): string | null {
  if (!identity) return null;
  return identity.nametag || getWalletAddress(identity);
}

function parseIdentity(raw: RawSphereIdentity): SphereIdentity | null {
  const walletAddress = getWalletAddress(raw);
  const canonicalId = getCanonicalUserId(raw);
  const did = raw.did || canonicalId;
  if (!did && !walletAddress) return null;
  return {
    did: did || walletAddress!,
    nametag: raw.nametag ?? null,
    l1Address: walletAddress || did!,
  };
}

function isInIframe(): boolean {
  try {
    return window.parent !== window && window.self !== window.top;
  } catch {
    return true;
  }
}

function waitForHostReady(): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(new Error('Wallet did not respond in time'));
    }, HOST_READY_TIMEOUT);

    function handler(event: MessageEvent) {
      if (event.origin !== WALLET_URL) return;
      const type = (event.data as { type?: string })?.type;
      if (type === HOST_READY_TYPE || type === 'host-ready') {
        clearTimeout(timeout);
        window.removeEventListener('message', handler);
        resolve();
      }
    }
    window.addEventListener('message', handler);
  });
}

function openWalletPopup(targetUrl: string, existingPopup: Window | null = null): Window | null {
  if (existingPopup && !existingPopup.closed) {
    try {
      existingPopup.location.replace(targetUrl);
      existingPopup.focus();
      return existingPopup;
    } catch {
      // Fall through to fresh popup if cross-origin navigation is blocked.
    }
  }

  const popup = window.open('about:blank', `sphere-wallet-${Date.now()}`, POPUP_FEATURES);
  if (!popup) return null;

  try {
    popup.location.replace(targetUrl);
    popup.focus();
  } catch (err) {
    console.error('[SphereWallet] Failed to navigate popup:', err);
    return null;
  }

  return popup;
}

function buildHandshakeRequest(): Record<string, unknown> {
  const resumeSessionId = sessionStorage.getItem(SESSION_KEY) ?? undefined;
  return {
    ns: 'sphere-connect',
    v: '1.0',
    type: 'handshake',
    direction: 'request',
    permissions: [...SPHERE_PERMISSIONS],
    dapp: DAPP_META,
    ...(resumeSessionId ? { sessionId: resumeSessionId } : {}),
  };
}

async function requestWalletHandshake(
  postTarget: Window,
  closePopup?: Window | null,
): Promise<SphereIdentity> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      window.removeEventListener('message', onMessage);
      clearInterval(popupCheck);
      fn();
    };

    const timeout = setTimeout(() => {
      finish(() => {
        if (closePopup && !closePopup.closed) closePopup.close();
        reject(new Error('Wallet connection timeout'));
      });
    }, CONNECT_TIMEOUT);

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== WALLET_URL) return;
      if (!isSphereMessage(event.data)) return;

      const msg = event.data;

      if (msg.type === 'handshake' && msg.direction === 'response') {
        if (msg.sessionId && msg.identity) {
          const parsed = parseIdentity(msg.identity);
          if (!parsed) {
            finish(() => {
              if (closePopup && !closePopup.closed) closePopup.close();
              reject(new Error('Invalid wallet identity'));
            });
            return;
          }
          sessionStorage.setItem(SESSION_KEY, msg.sessionId);
          finish(() => {
            if (closePopup && !closePopup.closed) closePopup.close();
            resolve(parsed);
          });
          return;
        }

        finish(() => {
          if (closePopup && !closePopup.closed) closePopup.close();
          reject(new Error('Wallet connection rejected'));
        });
        return;
      }

      if (msg.type === 'response' && msg.error) {
        finish(() => {
          if (closePopup && !closePopup.closed) closePopup.close();
          reject(new Error(msg.error?.message ?? 'Unknown wallet error'));
        });
      }
    };

    window.addEventListener('message', onMessage);

    const popupCheck = setInterval(() => {
      if (closePopup?.closed && !settled) {
        finish(() => reject(new Error('Wallet popup was closed')));
      }
    }, 1000);

    postTarget.postMessage(buildHandshakeRequest(), WALLET_URL);
  });
}

async function connectToSphereWallet(popupRef: { current: Window | null }): Promise<SphereIdentity> {
  if (isInIframe()) {
    return requestWalletHandshake(window.parent);
  }

  const connectUrl = `${WALLET_URL}/connect?origin=${encodeURIComponent(location.origin)}`;
  popupRef.current = openWalletPopup(connectUrl, popupRef.current);

  if (!popupRef.current) {
    throw new Error(`Popup blocked — allow popups for ${WALLET_URL}`);
  }

  await waitForHostReady();
  return requestWalletHandshake(popupRef.current, popupRef.current);
}

export function useSphereWallet() {
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [identity, setIdentity] = useState<SphereIdentity | null>(null);
  const popupRef = useRef<Window | null>(null);
  const { setSession, clearSession } = useAuthStore();

  const connect = useCallback(async (): Promise<boolean> => {
    setConnecting(true);
    setConnectError(null);

    try {
      const identityResult = await connectToSphereWallet(popupRef);
      setIdentity(identityResult);

      const registered = await api.registerPlayer({
        did: identityResult.did,
        nametag: identityResult.nametag ?? undefined,
        wallet_address: identityResult.l1Address,
      });

      setSession({
        accessToken: registered.access_token,
        player: registered.player,
        wallet: registered.wallet,
        moveBalance: registered.move_balance,
      });

      return true;
    } catch (err) {
      console.error('[SphereWallet]', err);
      const message = err instanceof Error ? err.message : 'Wallet connection failed';
      setConnectError(message);
      return false;
    } finally {
      setConnecting(false);
    }
  }, [setSession]);

  const disconnect = useCallback(() => {
    setIdentity(null);
    setConnectError(null);
    clearSession();
    sessionStorage.removeItem(SESSION_KEY);
    if (popupRef.current && !popupRef.current.closed) {
      try {
        popupRef.current.close();
      } catch {
        // ignore
      }
    }
    popupRef.current = null;
  }, [clearSession]);

  const sendDeposit = useCallback(async (amountUct: number, treasuryAddress: string, memo: string) => {
    if (!identity) throw new Error('Wallet not connected');

    let targetWindow: Window;
    if (isInIframe()) {
      targetWindow = window.parent;
    } else if (popupRef.current && !popupRef.current.closed) {
      targetWindow = popupRef.current;
    } else {
      const connectUrl = `${WALLET_URL}/connect?origin=${encodeURIComponent(location.origin)}`;
      popupRef.current = openWalletPopup(connectUrl, null);
      if (!popupRef.current) {
        throw new Error(`Popup blocked — allow popups for ${WALLET_URL}`);
      }
      await waitForHostReady();
      targetWindow = popupRef.current;
    }

    return new Promise<{ txHash: string }>((resolve, reject) => {
      let settled = false;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        window.removeEventListener('message', onMessage);
        fn();
      };

      const timeout = setTimeout(() => {
        finish(() => reject(new Error('Deposit timeout')));
      }, 120_000);

      const onMessage = (event: MessageEvent) => {
        if (event.origin !== WALLET_URL) return;
        if (!isSphereMessage(event.data)) return;

        const msg = event.data;
        if (msg.type === 'intent_result') {
          finish(() => {
            if (msg.error) {
              reject(new Error(msg.error?.message ?? 'User rejected'));
            } else {
              resolve({
                txHash: (msg as { result?: { txHash?: string; hash?: string } }).result?.txHash
                  ?? (msg as { result?: { txHash?: string; hash?: string } }).result?.hash
                  ?? crypto.randomUUID(),
              });
            }
          });
        }
      };

      window.addEventListener('message', onMessage);

      const intentId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
      targetWindow.postMessage({
        ns: 'sphere-connect',
        v: '1.0',
        type: 'intent',
        id: intentId,
        action: 'send',
        params: {
          to: treasuryAddress,
          amount: amountUct,
          coinId: UCT_COIN_ID_HEX,
          memo,
        },
      }, WALLET_URL);
    });
  }, [identity]);

  return {
    connect,
    disconnect,
    connecting,
    connectError,
    identity,
    sendDeposit,
    walletUrl: WALLET_URL,
  };
}