import { useCallback, useRef, useState } from 'react';
import {
  ERROR_CODES,
  SPHERE_NETWORKS,
} from '@unicitylabs/sphere-sdk/connect';
import type { PublicIdentity } from '@unicitylabs/sphere-sdk/connect';
import { autoConnect, detectTransport, type AutoConnectResult } from '@unicitylabs/sphere-sdk/connect/browser';
import { uctToAtomic } from '@sphere-2048/shared';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';

const WALLET_URL = import.meta.env.VITE_SPHERE_WALLET_URL ?? 'https://sphere.unicity.network';
const SESSION_KEY = 'sphere2048-wallet-session';
const UCT_COIN_ID = (import.meta.env.VITE_UCT_COIN_ID
  ?? '455ad8720656b08e8dbd5bac1f3c73eeea5431565f6c1c3af742b1aa12d41d89').toLowerCase();

const DAPP = {
  name: '2048 × Sphere',
  description: '2048 on Unicity testnet2',
  url: location.origin,
};

export interface SphereIdentity {
  did: string;
  nametag: string | null;
  l1Address: string;
}

function toSphereIdentity(identity: PublicIdentity): SphereIdentity {
  const l1Address = identity.directAddress ?? identity.chainPubkey;
  const did = identity.nametag ?? l1Address;
  return { did, nametag: identity.nametag ?? null, l1Address };
}

function formatConnectError(err: unknown): string {
  const code = (err as { code?: number })?.code;
  const data = (err as { data?: Record<string, unknown> })?.data;
  const message = err instanceof Error ? err.message : 'Wallet connection failed';

  if (code === ERROR_CODES.UNSUPPORTED_PROTOCOL_VERSION) {
    return 'This app is outdated (Connect v1). Hard-refresh — you should see "Connect v2" on the connect page.';
  }
  if (code === ERROR_CODES.INCOMPATIBLE_NETWORK) {
    const walletNet = data?.walletNetwork as { id?: number } | undefined;
    return `Network mismatch — wallet is on network ${walletNet?.id ?? '?'}, this app needs testnet2 (id 4). Switch network in Sphere.`;
  }
  if (code === ERROR_CODES.USER_REJECTED) return 'You cancelled the connection in Sphere.';
  if (code === ERROR_CODES.ORIGIN_BLOCKED) return `Sphere blocked ${location.origin}. Try a different browser or clear wallet site permissions.`;
  if (message === 'Connection rejected by wallet') {
    return 'Sphere denied the connection. Log into your wallet on testnet2, approve this site when prompted, then try again.';
  }
  if (/popup blocked/i.test(message)) return message;
  if (/popup was closed/i.test(message)) return 'Wallet popup closed before connecting — try again and keep it open.';
  return message;
}

function clearStaleSessions() {
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem('sphere-connect-popup-session');
  sessionStorage.removeItem('sphere2048-session');
}

async function connectWallet(): Promise<AutoConnectResult> {
  const base = {
    dapp: DAPP,
    walletUrl: WALLET_URL,
    network: SPHERE_NETWORKS.testnet2,
  };

  try {
    return await autoConnect(base);
  } catch (first) {
    const mode = detectTransport();
    if (mode === 'extension') {
      return await autoConnect({ ...base, forceTransport: 'popup' });
    }
    throw first;
  }
}

export function useSphereWallet() {
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const sessionRef = useRef<AutoConnectResult | null>(null);
  const { setSession, clearSession } = useAuthStore();

  const connect = useCallback(async (): Promise<boolean> => {
    setConnecting(true);
    setConnectError(null);
    clearStaleSessions();

    try {
      if (sessionRef.current) {
        await sessionRef.current.disconnect().catch(() => undefined);
        sessionRef.current = null;
      }

      const wallet = await connectWallet();
      sessionRef.current = wallet;
      sessionStorage.setItem(SESSION_KEY, wallet.connection.sessionId);

      const identity = toSphereIdentity(wallet.connection.identity);
      const registered = await api.registerPlayer({
        did: identity.did,
        nametag: identity.nametag ?? undefined,
        wallet_address: identity.l1Address,
      });

      setSession({
        accessToken: registered.access_token,
        player: registered.player,
        wallet: registered.wallet,
        moveBalance: registered.move_balance,
      });

      return true;
    } catch (err) {
      console.error('[SphereWallet]', err, { origin: location.origin, transport: detectTransport() });
      setConnectError(formatConnectError(err));
      if (sessionRef.current) {
        await sessionRef.current.disconnect().catch(() => undefined);
        sessionRef.current = null;
      }
      clearStaleSessions();
      return false;
    } finally {
      setConnecting(false);
    }
  }, [setSession]);

  const disconnect = useCallback(async () => {
    if (sessionRef.current) {
      await sessionRef.current.disconnect().catch(() => undefined);
      sessionRef.current = null;
    }
    clearSession();
    clearStaleSessions();
  }, [clearSession]);

  const sendDeposit = useCallback(async (amountUct: number, treasuryAddress: string, memo: string) => {
    const client = sessionRef.current?.client;
    if (!client?.isConnected) throw new Error('Wallet not connected');

    const result = await client.intent<{ txHash?: string; hash?: string }>('send', {
      to: treasuryAddress,
      amount: uctToAtomic(amountUct).toString(),
      coinId: UCT_COIN_ID,
      memo,
    });

    return { txHash: result.txHash ?? result.hash ?? crypto.randomUUID() };
  }, []);

  return { connect, disconnect, connecting, connectError, sendDeposit, walletUrl: WALLET_URL };
}