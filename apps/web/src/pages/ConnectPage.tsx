import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { useSphereWallet } from '@/hooks/useSphereWallet';
import { useAuthStore } from '@/stores/authStore';

export function ConnectPage() {
  const navigate = useNavigate();
  const { connect, connecting } = useSphereWallet();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated());

  async function handleConnect() {
    const ok = await connect();
    if (ok) navigate('/deposit');
  }

  if (isAuthenticated) {
    navigate('/play');
    return null;
  }

  return (
    <section className="flex flex-col items-center gap-5 text-center">
      <h2 className="text-2xl font-extrabold text-ink">Connect Sphere Wallet</h2>
      <p className="max-w-sm text-sm text-ink-soft">
        Authentication uses Sphere SDK only. Your DID and L1 wallet address become your player identity.
        No email or password required.
      </p>
      <Button onClick={handleConnect} disabled={connecting}>
        {connecting ? 'Connecting…' : '🔗 Connect Wallet'}
      </Button>
    </section>
  );
}