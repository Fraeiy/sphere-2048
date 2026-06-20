import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { restoreWalletSession } from '@/lib/walletRestore';
import { useAuthStore } from '@/stores/authStore';

let syncInflight: Promise<void> | null = null;

async function syncSessionFromDatabase(): Promise<void> {
  const { accessToken, setSession, setMoveBalance } = useAuthStore.getState();
  const walletRestored = await restoreWalletSession(setSession);
  if (!walletRestored && accessToken) {
    try {
      const { move_balance } = await api.getMoveBalance(accessToken);
      setMoveBalance(move_balance);
    } catch {
      // Keep persisted balance if refresh fails.
    }
  }
}

function ensureSessionSynced(): Promise<void> {
  if (!syncInflight) {
    syncInflight = syncSessionFromDatabase().finally(() => { syncInflight = null; });
  }
  return syncInflight;
}

/** Persist rehydrated and move balance refreshed from the database (or wallet session restored). */
export function useAuthReady(): boolean {
  const [hydrated, setHydrated] = useState(() => useAuthStore.persist.hasHydrated());
  const [synced, setSynced] = useState(false);

  useEffect(() => {
    if (hydrated) return;
    return useAuthStore.persist.onFinishHydration(() => setHydrated(true));
  }, [hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    ensureSessionSynced().finally(() => {
      if (!cancelled) setSynced(true);
    });
    return () => { cancelled = true; };
  }, [hydrated]);

  return hydrated && synced;
}