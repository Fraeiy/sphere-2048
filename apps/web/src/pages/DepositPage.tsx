import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { uctToAtomic } from '@sphere-2048/shared';
import { Button } from '@/components/ui/Button';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import { useSphereWallet } from '@/hooks/useSphereWallet';
import { getTreasuryRecipient } from '@/lib/treasury';

const TIERS = [
  { amount: 1, moves: 50, label: 'Starter' },
  { amount: 5, moves: 300, label: 'Standard' },
  { amount: 10, moves: 700, label: 'Pro' },
];

const TREASURY = getTreasuryRecipient();

export function DepositPage() {
  const navigate = useNavigate();
  const { accessToken, player, setMoveBalance, isAuthenticated } = useAuthStore();
  const { sendDeposit } = useSphereWallet();
  const [selected, setSelected] = useState(10);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [pendingTx, setPendingTx] = useState<{ txHash: string; amount: number; memo: string } | null>(null);

  useEffect(() => {
    const raw = sessionStorage.getItem('sphere2048-pending-deposit');
    if (raw) {
      try {
        setPendingTx(JSON.parse(raw) as { txHash: string; amount: number; memo: string });
      } catch {
        sessionStorage.removeItem('sphere2048-pending-deposit');
      }
    }
  }, []);

  useEffect(() => {
    if (!isAuthenticated()) navigate('/connect', { replace: true });
  }, [isAuthenticated, navigate]);

  async function creditDeposit(txHash: string, amount: number, memo: string) {
    if (!accessToken || !player) return;
    const result = await api.processDeposit(accessToken, {
      player_id: player.id,
      wallet_address: useAuthStore.getState().wallet!.address,
      tx_hash: txHash,
      amount_atomic: uctToAtomic(amount).toString(),
      memo,
    });
    setMoveBalance(result.move_balance);
    setPendingTx(null);
    sessionStorage.removeItem('sphere2048-pending-deposit');
    navigate('/play', { replace: true });
  }

  async function handleDeposit() {
    if (!accessToken || !player) return;
    setLoading(true);
    setError('');
    try {
      const memo = `2048:${player.did}`;
      const { txHash } = await sendDeposit(selected, TREASURY, memo);
      const pending = { txHash, amount: selected, memo };
      setPendingTx(pending);
      sessionStorage.setItem('sphere2048-pending-deposit', JSON.stringify(pending));
      await creditDeposit(txHash, selected, memo);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Deposit failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleRetryCredit() {
    if (!pendingTx) return;
    setLoading(true);
    setError('');
    try {
      await creditDeposit(pendingTx.txHash, pendingTx.amount, pendingTx.memo);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Credit failed');
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

      {error && (
        <div className="rounded-lg bg-red-100 px-3 py-2 text-sm text-red-800">
          <p>{error}</p>
          {pendingTx && (
            <p className="mt-2 text-xs">
              Your wallet transfer may have succeeded. Tap <strong>Retry credit</strong> below — no second payment needed.
            </p>
          )}
        </div>
      )}

      {pendingTx && error && (
        <Button onClick={handleRetryCredit} disabled={loading} variant="secondary" className="w-full">
          {loading ? 'Crediting…' : `Retry credit (${pendingTx.amount} UCT)`}
        </Button>
      )}

      <p className="text-center text-xs text-ink-soft">
        Sends <strong>UCT</strong> to <strong>{TREASURY}</strong> on testnet2. The wallet may show the amount in
        base units (e.g. 10 UCT = 10000000000000000000) — that is normal.
      </p>

      <Button onClick={handleDeposit} disabled={loading || !TREASURY} className="w-full">
        {loading ? 'Opening wallet…' : `Deposit ${selected} UCT`}
      </Button>
    </section>
  );
}