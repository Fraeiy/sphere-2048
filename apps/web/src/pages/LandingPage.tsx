import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { routeForMoveBalance } from '@/lib/routing';
import { useAuthStore } from '@/stores/authStore';

export function LandingPage() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated());
  const moveBalance = useAuthStore((s) => s.moveBalance);
  const playRoute = routeForMoveBalance(moveBalance?.credits_remaining ?? 0);

  return (
    <section className="flex flex-col items-center gap-6 text-center">
      <div>
        <h1 className="text-5xl font-black tracking-tight text-ink shadow-[0_4px_18px_rgba(209,99,26,0.16)]">
          20<span className="text-orange-600">48</span>
        </h1>
        <p className="mt-2 text-sm text-ink-soft">× Sphere Chain · Web3 2048</p>
      </div>

      <p className="max-w-md text-sm leading-relaxed text-ink-soft">
        Connect your Sphere wallet, deposit UCT for move credits, and compete on global and weekly leaderboards.
        Every deposit feeds the weekly prize pool.
      </p>

      <div className="flex flex-wrap justify-center gap-3">
        {isAuthenticated ? (
          <>
            <Link to={playRoute}><Button>{playRoute === '/play' ? 'Play Now' : 'Get Moves'}</Button></Link>
            <Link to="/deposit"><Button variant="secondary">Deposit</Button></Link>
          </>
        ) : (
          <Link to="/connect"><Button>Connect Wallet</Button></Link>
        )}
        <Link to="/leaderboard"><Button variant="secondary">Leaderboard</Button></Link>
      </div>
    </section>
  );
}