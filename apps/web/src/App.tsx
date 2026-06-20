import { lazy, Suspense } from 'react';
import { Routes, Route } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { LandingPage } from '@/pages/LandingPage';
import { ConnectPage } from '@/pages/ConnectPage';

const DepositPage = lazy(() => import('@/pages/DepositPage').then((m) => ({ default: m.DepositPage })));
const GamePage = lazy(() => import('@/pages/GamePage').then((m) => ({ default: m.GamePage })));
const LeaderboardPage = lazy(() => import('@/pages/LeaderboardPage').then((m) => ({ default: m.LeaderboardPage })));

function PageFallback() {
  return <p className="text-center text-sm text-ink-soft">Loading…</p>;
}

export default function App() {
  return (
    <AppShell>
      <Suspense fallback={<PageFallback />}>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/connect" element={<ConnectPage />} />
          <Route path="/deposit" element={<DepositPage />} />
          <Route path="/play" element={<GamePage />} />
          <Route path="/leaderboard" element={<LeaderboardPage />} />
        </Routes>
      </Suspense>
    </AppShell>
  );
}