import { useEffect, useState } from 'react';
import { useAuthStore } from '@/stores/authStore';

/** Wait for zustand persist to rehydrate before auth-gated redirects. */
export function useAuthHydrated(): boolean {
  const [hydrated, setHydrated] = useState(() => useAuthStore.persist.hasHydrated());

  useEffect(() => {
    if (hydrated) return;
    return useAuthStore.persist.onFinishHydration(() => setHydrated(true));
  }, [hydrated]);

  return hydrated;
}