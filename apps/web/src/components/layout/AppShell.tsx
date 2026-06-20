import { Link, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';

const NAV = [
  { to: '/', label: 'Home' },
  { to: '/play', label: 'Play' },
  { to: '/leaderboard', label: 'Leaderboard' },
  { to: '/weekly-pool', label: 'Weekly Pool' },
  { to: '/profile', label: 'Profile' },
];

export function AppShell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-lg flex-col px-3 py-5">
      <nav className="mb-4 flex flex-wrap items-center justify-center gap-2">
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
      </nav>
      {children}
    </div>
  );
}