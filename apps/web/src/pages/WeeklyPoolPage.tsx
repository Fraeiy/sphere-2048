import { useEffect, useState } from 'react';
import { atomicToUct } from '@sphere-2048/shared';
import { LeaderboardTable } from '@/components/leaderboard/LeaderboardTable';
import { api } from '@/lib/api';
import type { WeeklyPoolResponse } from '@sphere-2048/shared';

export function WeeklyPoolPage() {
  const [data, setData] = useState<WeeklyPoolResponse | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.getWeeklyPool()
      .then(setData)
      .catch((err) => setError(err.message));
  }, []);

  if (error) return <p className="rounded-lg bg-red-100 px-3 py-2 text-sm text-red-800">{error}</p>;
  if (!data) return <p className="text-center text-sm">Loading weekly pool…</p>;

  const poolUct = atomicToUct(BigInt(data.prize_pool_atomic));

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-center text-2xl font-extrabold text-ink">Weekly Prize Pool</h2>

      <div className="rounded-lg border border-[#f2d2ae] bg-[#fff0de] p-4 text-center">
        <p className="text-sm text-ink-soft">Round #{data.round.round_number}</p>
        <p className="text-3xl font-black text-orange-600">{poolUct.toFixed(2)} UCT</p>
        <p className="mt-1 text-xs text-ink-soft">
          Ends {new Date(data.round.ends_at).toLocaleString()} · {data.deposit_count} deposits
        </p>
      </div>

      <h3 className="font-bold text-ink">This week's top scores</h3>
      <LeaderboardTable entries={data.top_entries} />
    </section>
  );
}