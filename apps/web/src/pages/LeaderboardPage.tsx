import { useEffect, useState } from 'react';
import { atomicToUct } from '@sphere-2048/shared';
import { LeaderboardTable } from '@/components/leaderboard/LeaderboardTable';
import { api } from '@/lib/api';
import type { LeaderboardEntry, WeeklyPoolResponse } from '@sphere-2048/shared';

export function LeaderboardPage() {
  const [tab, setTab] = useState<'global' | 'weekly'>('global');
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [pool, setPool] = useState<WeeklyPoolResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    setError('');

    const leaderboard = api.getLeaderboard(tab);
    const poolReq = tab === 'weekly' ? api.getWeeklyPool() : Promise.resolve(null);

    Promise.all([leaderboard, poolReq])
      .then(([lb, poolData]) => {
        setEntries(lb.entries);
        setPool(poolData);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [tab]);

  const poolUct = pool ? atomicToUct(BigInt(pool.prize_pool_atomic)) : 0;

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-center text-2xl font-extrabold text-ink">Leaderboard</h2>

      <div className="flex justify-center gap-2">
        {(['global', 'weekly'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`rounded-full px-4 py-1.5 text-sm font-bold capitalize ${
              tab === t ? 'bg-orange-500 text-white' : 'bg-[#ffe6c7] text-ink-soft'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'weekly' && pool && (
        <div className="rounded-lg border border-[#f2d2ae] bg-[#fff0de] p-3 text-center">
          <p className="text-xs text-ink-soft">Weekly prize pool · round #{pool.round.round_number}</p>
          <p className="text-2xl font-black text-orange-600">{poolUct.toFixed(2)} UCT</p>
          <p className="mt-1 text-[11px] text-ink-soft">50% of weekly deposits · top 5 win 35% / 25% / 20% / 15% / 5%</p>
        </div>
      )}

      {loading && <p className="text-center text-sm">Loading…</p>}
      {error && <p className="rounded-lg bg-red-100 px-3 py-2 text-sm text-red-800">{error}</p>}
      {!loading && !error && <LeaderboardTable entries={entries} />}
    </section>
  );
}