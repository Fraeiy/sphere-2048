import { Routes, Route } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { LandingPage } from '@/pages/LandingPage';
import { ConnectPage } from '@/pages/ConnectPage';
import { DepositPage } from '@/pages/DepositPage';
import { GamePage } from '@/pages/GamePage';
import { LeaderboardPage } from '@/pages/LeaderboardPage';
import { ProfilePage } from '@/pages/ProfilePage';
import { WeeklyPoolPage } from '@/pages/WeeklyPoolPage';

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/connect" element={<ConnectPage />} />
        <Route path="/deposit" element={<DepositPage />} />
        <Route path="/play" element={<GamePage />} />
        <Route path="/leaderboard" element={<LeaderboardPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/weekly-pool" element={<WeeklyPoolPage />} />
      </Routes>
    </AppShell>
  );
}