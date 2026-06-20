import { useCallback, useRef, useState } from 'react';
import {
  ConnectClient,
  ERROR_CODES,
  HOST_READY_TIMEOUT,
  HOST_READY_TYPE,
  SPHERE_NETWORKS,
} from '@unicitylabs/sphere-sdk/connect';
import type { ConnectClient as ConnectClientType, PublicIdentity } from '@unicitylabs/sphere-sdk/connect';
import { PostMessageTransport, ExtensionTransport } from '@unicitylabs/sphere-sdk/connect/browser';
import { uctToAtomic } from '@sphere-2048/shared';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import { hasExtension, isInIframe } from '@/lib/walletDetection';

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
  if (code === ERROR_CODES.UNSUPPORTED_PROTOCOL_VERSION) {
    return 'Wallet requires Connect v2 — hard-refresh this page and try again';
  }
  if (code === ERROR_CODES.INCOMPATIBLE_NETWORK) {
    return 'Wallet network mismatch — ensure your Sphere wallet is on testnet2';
  }
  if (code === ERROR_CODES.USER_REJECTED) return 'Connection cancelled';
  if (code === ERROR_CODES.ORIGIN_BLOCKED) return 'This site is blocked by the wallet';
  return err instanceof Error ? err.message : 'Wallet connection failed';
}

function waitForHostReady(timeoutMs = HOST_READY_TIMEOUT): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', onReady);
      reject(new Error('Wallet did not respond in time'));
    }, timeoutMs);

    function onReady(event: MessageEvent) {
      if (event.data?.type === HOST_READY_TYPE || event.data?.type === 'host-ready') {
        clearTimeout(timer);
        window.removeEventListener('message', onReady);
        resolve();
      }
    }
    window.addEventListener('message', onReady);
  });
}

function makeClient(
  transport: ConstructorParameters<typeof ConnectClient>[0]['transport'],
  extra: { resumeSessionId?: string; silent?: boolean } = {},
) {
  return new ConnectClient({
    transport,
    dapp: DAPP,
    network: SPHERE_NETWORKS.testnet2,
    ...extra,
  });
}

export function useSphereWallet() {
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const clientRef = useRef<ConnectClientType | null>(null);
  const transportRef = useRef<{ destroy: () => void } | null>(null);
  const popupRef = useRef<Window | null>(null);
  const popupMode = useRef(false);
  const { setSession, clearSession } = useAuthStore();

  const teardown = useCallback(() => {
    transportRef.current?.destroy();
    clientRef.current = null;
    transportRef.current = null;
    popupRef.current = null;
    popupMode.current = false;
  }, []);

  const openPopupClient = useCallback(async () => {
    if (!popupRef.current || popupRef.current.closed) {
      const popup = window.open(
        `${WALLET_URL}/connect?origin=${encodeURIComponent(location.origin)}`,
        'sphere-wallet',
        'width=420,height=650',
      );
      if (!popup) throw new Error(`Popup blocked — allow popups for ${WALLET_URL}`);
      popupRef.current = popup;
    } else {
      popupRef.current.focus();
    }

    transportRef.current?.destroy();
    const transport = PostMessageTransport.forClient({
      target: popupRef.current,
      targetOrigin: WALLET_URL,
    });
    transportRef.current = transport;
    await waitForHostReady();

    const resumeSessionId = sessionStorage.getItem(SESSION_KEY) ?? undefined;
    const client = makeClient(transport, { resumeSessionId });
    clientRef.current = client;
    popupMode.current = true;
    return client.connect();
  }, []);

  const connect = useCallback(async (): Promise<boolean> => {
    setConnecting(true);
    setConnectError(null);
    teardown();

    try {
      let result;
      if (isInIframe()) {
        popupMode.current = false;
        const transport = PostMessageTransport.forClient();
        transportRef.current = transport;
        const client = makeClient(transport);
        clientRef.current = client;
        result = await client.connect();
      } else if (hasExtension()) {
        popupMode.current = false;
        const transport = ExtensionTransport.forClient();
        transportRef.current = transport;
        const client = makeClient(transport);
        clientRef.current = client;
        result = await client.connect();
      } else {
        result = await openPopupClient();
      }

      sessionStorage.setItem(SESSION_KEY, result.sessionId);
      const identity = toSphereIdentity(result.identity);

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
      console.error('[SphereWallet]', err);
      setConnectError(formatConnectError(err));
      teardown();
      sessionStorage.removeItem(SESSION_KEY);
      return false;
    } finally {
      setConnecting(false);
    }
  }, [openPopupClient, setSession, teardown]);

  const disconnect = useCallback(async () => {
    try {
      await clientRef.current?.disconnect();
    } catch {
      // ignore
    }
    teardown();
    clearSession();
    sessionStorage.removeItem(SESSION_KEY);
    popupRef.current?.close();
  }, [clearSession, teardown]);

  const sendDeposit = useCallback(async (amountUct: number, treasuryAddress: string, memo: string) => {
    if (!clientRef.current) {
      if (popupMode.current && (!popupRef.current || popupRef.current.closed)) {
        throw new Error('Wallet popup was closed — reconnect first');
      }
      throw new Error('Wallet not connected');
    }

    const result = await clientRef.current.intent<{ txHash?: string; hash?: string }>('send', {
      to: treasuryAddress,
      amount: uctToAtomic(amountUct).toString(),
      coinId: UCT_COIN_ID,
      memo,
    });

    return { txHash: result.txHash ?? result.hash ?? crypto.randomUUID() };
  }, []);

  return { connect, disconnect, connecting, connectError, sendDeposit, walletUrl: WALLET_URL };
}