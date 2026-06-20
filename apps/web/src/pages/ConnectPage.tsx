import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { useSphereWallet } from '@/hooks/useSphereWallet';
import { useAuthStore } from '@/stores/authStore';

export function ConnectPage() {
  const navigate = useNavigate();
  const { connect, connecting, connectError } = useSphereWallet();
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
      <p className="text-xs font-semibold text-orange-600">Connect v2 · testnet2</p>
      <p className="max-w-sm text-sm text-ink-soft">
        Opens Sphere to approve this site. Your nametag or wallet address becomes your player ID.
      </p>
      <p className="max-w-sm break-all text-[10px] text-ink-soft/60">{location.origin}</p>
      {connectError && (
        <p className="max-w-sm rounded-lg bg-red-100 px-3 py-2 text-sm text-red-800">{connectError}</p>
      )}

      <Button onClick={handleConnect} disabled={connecting}>
        {connecting ? 'Connecting…' : '🔗 Connect Wallet'}
      </Button>
    </section>
  );
}