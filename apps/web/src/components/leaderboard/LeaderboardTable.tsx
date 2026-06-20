import type { LeaderboardEntry } from '@sphere-2048/shared';

function shortId(value: string): string {
  if (value.length <= 22) return value;
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function rankBadge(rank: number): string {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return `#${rank}`;
}

interface LeaderboardTableProps {
  entries: LeaderboardEntry[];
  emptyMessage?: string;
}

export function LeaderboardTable({ entries, emptyMessage }: LeaderboardTableProps) {
  if (!entries.length) {
    return (
      <p className="rounded-lg border border-[#f4dfc8] bg-[#fffdf9] px-4 py-6 text-center text-sm text-[#8f8377]">
        {emptyMessage ?? '🎮 No scores yet. Be the first to play!'}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="sticky top-0 grid grid-cols-[56px_1fr_96px_84px] gap-2 rounded-lg border border-[#f4dfc8] bg-[#ffe9ce] px-3 py-2.5 text-sm font-extrabold text-[#6d6258]">
        <div>Rank</div>
        <div>Player</div>
        <div className="text-right">Score</div>
        <div className="text-right">Tile</div>
      </div>
      {entries.map((entry, index) => {
        const rank = index + 1;
        return (
          <div
            key={entry.id}
            data-rank={rank}
            className={`grid grid-cols-[56px_1fr_96px_84px] items-center gap-2 rounded-lg border px-3 py-2.5 text-sm ${
              rank === 1 ? 'border-[#ffd700] bg-[#fff8e1]'
              : rank === 2 ? 'border-[#c0c0c0] bg-[#f5f5f5]'
              : rank === 3 ? 'border-[#cd7f32] bg-[#fce4ec]'
              : 'border-[#f4dfc8] bg-[#fffdf9]'
            }`}
          >
            <div className="font-black text-[#7b6d62]">{rankBadge(rank)}</div>
            <div className="truncate font-bold" title={entry.player_did}>{shortId(entry.player_did)}</div>
            <div className="text-right font-black text-[#b55812]">{entry.score}</div>
            <div className="text-right font-bold">{entry.highest_tile}</div>
          </div>
        );
      })}
    </div>
  );
}