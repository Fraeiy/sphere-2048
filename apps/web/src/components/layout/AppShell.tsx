import { Link, useLocation, useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuthStore } from '@/stores/authStore';
import { useSphereWallet } from '@/hooks/useSphereWallet';

const NAV = [
  { to: '/', label: 'Home' },
  { to: '/play', label: 'Play' },
  { to: '/leaderboard', label: 'Scores' },
];

export function AppShell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { player, moveBalance, isAuthenticated } = useAuthStore();
  const { disconnect } = useSphereWallet();
  const authed = isAuthenticated();

  async function handleDisconnect() {
    await disconnect();
    navigate('/');
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-lg flex-col px-3 py-5">
      <nav className="mb-3 flex flex-wrap items-center justify-center gap-2">
        {NAV.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className={`rounded-full px-3 py-1.5 text-sm font-bold transition ${
              pathname === item.to
                ? 'bg-orange-500 text-white shadow-[0_4px_0_#ad4600]'
                : 'bg-cream-100/80 text-ink-soft hover:bg-orange-400/30'
            }`}
          >
            {item.label}
          </Link>
        ))}
        {authed && (
          <Link
            to="/deposit"
            className={`rounded-full px-3 py-1.5 text-sm font-bold transition ${
              pathname === '/deposit'
                ? 'bg-orange-500 text-white shadow-[0_4px_0_#ad4600]'
                : 'bg-cream-100/80 text-ink-soft hover:bg-orange-400/30'
            }`}
          >
            Deposit
          </Link>
        )}
      </nav>

      {authed && (
        <div className="mb-4 flex items-center justify-between rounded-lg border border-[#f2d2ae] bg-[#fff8ef] px-3 py-2 text-xs">
          <span className="truncate font-semibold text-ink">
            {player?.display_name ?? player?.did} · {moveBalance?.credits_remaining ?? 0} moves
          </span>
          <button type="button" onClick={handleDisconnect} className="ml-2 shrink-0 text-ink-soft hover:text-ink">
            Disconnect
          </button>
        </div>
      )}

      {children}
    </div>
  );
}