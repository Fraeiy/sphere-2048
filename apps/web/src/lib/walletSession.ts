import type { AutoConnectResult } from '@unicitylabs/sphere-sdk/connect/browser';

/** Module singleton — ConnectClient cannot live inside per-component useRef. */
let active: AutoConnectResult | null = null;

export const walletSession = {
  get: () => active,
  set: (session: AutoConnectResult) => {
    active = session;
  },
  async clear() {
    if (active) {
      await active.disconnect().catch(() => undefined);
      active = null;
    }
  },
  hasConnectedClient: () => Boolean(active?.client.isConnected),
};