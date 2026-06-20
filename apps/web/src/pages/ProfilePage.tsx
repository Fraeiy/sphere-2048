import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { useAuthStore } from '@/stores/authStore';
import { useSphereWallet } from '@/hooks/useSphereWallet';

export function ProfilePage() {
  const navigate = useNavigate();
  const { player, wallet, moveBalance, isAuthenticated } = useAuthStore();
  const { disconnect } = useSphereWallet();

  if (!isAuthenticated()) {
    navigate('/connect');
    return null;
  }

  function handleDisconnect() {
    disconnect();
    navigate('/');
  }

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-center text-2xl font-extrabold text-ink">Profile</h2>

      <div className="rounded-lg border border-[#f2d2ae] bg-[#fff0de] p-4 text-sm leading-relaxed">
        <p><strong>DID:</strong> {player?.did}</p>
        <p><strong>Wallet:</strong> {wallet?.address}</p>
        <p><strong>Moves left:</strong> {moveBalance?.credits_remaining ?? 0}</p>
        <p><strong>Lifetime credits:</strong> {moveBalance?.credits_lifetime ?? 0}</p>
      </div>

      <Button variant="secondary" onClick={handleDisconnect}>Disconnect Wallet</Button>
    </section>
  );
}