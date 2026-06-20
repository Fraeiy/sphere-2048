import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { uctToAtomic } from '@sphere-2048/shared';
import { Button } from '@/components/ui/Button';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import { useSphereWallet } from '@/hooks/useSphereWallet';

const TIERS = [
  { amount: 1, moves: 50, label: 'Starter' },
  { amount: 5, moves: 300, label: 'Standard' },
  { amount: 10, moves: 700, label: 'Pro' },
];

const TREASURY = import.meta.env.VITE_GAME_TREASURY_ADDRESS ?? '';

export function DepositPage() {
  const navigate = useNavigate();
  const { accessToken, player, setMoveBalance, isAuthenticated } = useAuthStore();
  const { sendDeposit } = useSphereWallet();
  const [selected, setSelected] = useState(10);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  if (!isAuthenticated()) {
    navigate('/connect');
    return null;
  }

  async function handleDeposit() {
    if (!accessToken || !player) return;
    setLoading(true);
    setError('');
    try {
      const memo = `2048:${player.did}`;
      const { txHash } = await sendDeposit(selected, TREASURY, memo);
      const result = await api.processDeposit(accessToken, {
        player_id: player.id,
        wallet_address: useAuthStore.getState().wallet!.address,
        tx_hash: txHash,
        amount_atomic: Number(uctToAtomic(selected)),
        memo,
      });
      setMoveBalance(result.move_balance);
      navigate('/play');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Deposit failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-center text-2xl font-extrabold text-ink">Deposit UCT</h2>
      <p className="text-center text-sm text-ink-soft">Deposits grant move credits and contribute 10% to the weekly prize pool.</p>

      <div className="grid gap-2">
        {TIERS.map((tier) => (
          <button
            key={tier.amount}
            type="button"
            onClick={() => setSelected(tier.amount)}
            className={`rounded-lg border px-4 py-3 text-left transition ${
              selected === tier.amount
                ? 'border-orange-500 bg-[#fff8ef]'
                : 'border-[#f0d7bc] bg-[#fffdf9] hover:border-orange-400'
            }`}
          >
            <div className="font-bold text-ink">{tier.label} — {tier.amount} UCT</div>
            <div className="text-sm text-ink-soft">{tier.moves} moves</div>
          </button>
        ))}
      </div>

      {error && <p className="rounded-lg bg-red-100 px-3 py-2 text-sm text-red-800">{error}</p>}

      <Button onClick={handleDeposit} disabled={loading || !TREASURY} className="w-full">
        {loading ? 'Processing…' : `Deposit ${selected} UCT`}
      </Button>
    </section>
  );
}