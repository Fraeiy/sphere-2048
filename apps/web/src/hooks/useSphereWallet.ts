import { useCallback, useState } from 'react';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';

const WALLET_URL = import.meta.env.VITE_SPHERE_WALLET_URL ?? 'https://sphere.unicity.network';
const SESSION_KEY = 'sphere2048-wallet-session';

export interface SphereIdentity {
  did: string;
  nametag: string | null;
  l1Address: string;
}

function parseIdentity(raw: Record<string, unknown>): SphereIdentity | null {
  const did = String(raw.did ?? raw.nametag ?? raw.l1Address ?? '');
  const l1Address = String(raw.l1Address ?? raw.address ?? '');
  if (!did && !l1Address) return null;
  return {
    did: did || l1Address,
    nametag: raw.nametag ? String(raw.nametag) : null,
    l1Address: l1Address || did,
  };
}

export function useSphereWallet() {
  const [connecting, setConnecting] = useState(false);
  const [identity, setIdentity] = useState<SphereIdentity | null>(null);
  const { setSession, clearSession } = useAuthStore();

  const connect = useCallback(async (): Promise<boolean> => {
    setConnecting(true);
    try {
      const popup = window.open(
        `${WALLET_URL}/connect?origin=${encodeURIComponent(location.origin)}`,
        `sphere-wallet-${Date.now()}`,
        'width=420,height=720,menubar=no,toolbar=no',
      );
      if (!popup) throw new Error('Popup blocked — allow popups for Sphere wallet');

      const identityResult = await new Promise<SphereIdentity>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Wallet connection timeout')), 30_000);
        const onMessage = (event: MessageEvent) => {
          if (event.origin !== WALLET_URL) return;
          const msg = event.data;
          if (msg?.ns !== 'sphere-connect' || msg?.v !== '1.0') return;
          if (msg.type === 'handshake' && msg.direction === 'response' && msg.identity) {
            clearTimeout(timeout);
            window.removeEventListener('message', onMessage);
            popup.close();
            const parsed = parseIdentity(msg.identity);
            if (!parsed) reject(new Error('Invalid wallet identity'));
            else {
              if (msg.sessionId) sessionStorage.setItem(SESSION_KEY, msg.sessionId);
              resolve(parsed);
            }
          }
        };
        window.addEventListener('message', onMessage);
      });

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
      return false;
    } finally {
      setConnecting(false);
    }
  }, [setSession]);

  const disconnect = useCallback(() => {
    setIdentity(null);
    clearSession();
    sessionStorage.removeItem(SESSION_KEY);
  }, [clearSession]);

  const sendDeposit = useCallback(async (amountUct: number, treasuryAddress: string, memo: string) => {
    if (!identity) throw new Error('Wallet not connected');

    return new Promise<{ txHash: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Deposit timeout')), 120_000);
      const onMessage = (event: MessageEvent) => {
        if (event.origin !== WALLET_URL) return;
        const msg = event.data;
        if (msg?.ns !== 'sphere-connect') return;
        if (msg.type === 'intent_result') {
          clearTimeout(timeout);
          window.removeEventListener('message', onMessage);
          if (msg.error) reject(new Error(msg.error));
          else resolve({ txHash: msg.result?.txHash ?? msg.result?.hash ?? crypto.randomUUID() });
        }
      };
      window.addEventListener('message', onMessage);

      const popup = window.open(WALLET_URL, 'sphere-send', 'width=420,height=720');
      popup?.postMessage({
        ns: 'sphere-connect',
        v: '1.0',
        type: 'intent',
        direction: 'request',
        action: 'send',
        params: {
          to: treasuryAddress,
          amount: String(amountUct),
          coinId: 'UCT',
          memo,
        },
      }, WALLET_URL);
    });
  }, [identity]);

  return { connect, disconnect, connecting, identity, sendDeposit, walletUrl: WALLET_URL };
}