import { useEffect, useState } from 'react';
import { LeaderboardTable } from '@/components/leaderboard/LeaderboardTable';
import { api } from '@/lib/api';
import { subscribeLeaderboard } from '@/lib/supabase';
import type { LeaderboardEntry } from '@sphere-2048/shared';

export function LeaderboardPage() {
  const [tab, setTab] = useState<'global' | 'weekly'>('global');
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    api.getLeaderboard(tab)
      .then((res) => setEntries(res.entries))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));

    return subscribeLeaderboard(tab, (row) => {
      setEntries((prev) => {
        const next = [{ ...(row as LeaderboardEntry) }, ...prev];
        return next.sort((a, b) => b.score - a.score).slice(0, 50);
      });
    });
  }, [tab]);

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-center text-2xl font-extrabold text-ink">🏆 Leaderboard</h2>

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

      {loading && <p className="text-center text-sm">Loading…</p>}
      {error && <p className="rounded-lg bg-red-100 px-3 py-2 text-sm text-red-800">{error}</p>}
      {!loading && !error && <LeaderboardTable entries={entries} />}
    </section>
  );
}