import {
  ERROR_CODES,
  SPHERE_NETWORKS,
} from '@unicitylabs/sphere-sdk/connect';
import type { PublicIdentity } from '@unicitylabs/sphere-sdk/connect';
import { autoConnect, detectTransport } from '@unicitylabs/sphere-sdk/connect/browser';
import type { RegisterPlayerResponse } from '@sphere-2048/shared';
import { api } from '@/lib/api';
import { walletSession } from '@/lib/walletSession';

type SessionData = {
  accessToken: string;
  player: RegisterPlayerResponse['player'];
  wallet: RegisterPlayerResponse['wallet'];
  moveBalance: RegisterPlayerResponse['move_balance'];
};

const WALLET_URL = import.meta.env.VITE_SPHERE_WALLET_URL ?? 'https://sphere.unicity.network';
const SESSION_KEY = 'sphere2048-wallet-session';
const DAPP = {
  name: '2048 × Sphere',
  description: '2048 on Unicity testnet2',
  url: location.origin,
};

function toIdentity(identity: PublicIdentity) {
  const l1Address = identity.directAddress ?? identity.chainPubkey;
  const did = identity.nametag ?? l1Address;
  return { did, nametag: identity.nametag ?? null, l1Address };
}

/** Silently resume a saved Sphere session and sync player + balance from the database. */
export async function restoreWalletSession(
  setSession: (data: SessionData) => void,
): Promise<boolean> {
  const resumeSessionId = sessionStorage.getItem(SESSION_KEY);
  if (!resumeSessionId || walletSession.hasConnectedClient()) return false;

  try {
    const base = {
      dapp: DAPP,
      walletUrl: WALLET_URL,
      network: SPHERE_NETWORKS.testnet2,
      resumeSessionId,
    };

    let wallet;
    try {
      wallet = await autoConnect(base);
    } catch (first) {
      const code = (first as { code?: number })?.code;
      if (code === ERROR_CODES.USER_REJECTED) return false;
      if (detectTransport() === 'extension') {
        wallet = await autoConnect({ ...base, forceTransport: 'popup' });
      } else {
        throw first;
      }
    }

    walletSession.set(wallet);
    sessionStorage.setItem(SESSION_KEY, wallet.connection.sessionId);

    const identity = toIdentity(wallet.connection.identity);
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
  } catch {
    return false;
  }
}