# Sphere 2048

Web3 2048 on Unicity Sphere SDK with React frontend, Supabase backend, and UCT move economy.

## Quick Start

```bash
cd apps/web
npm install
npm run dev
```

Open `http://localhost:5173`.

## Project Structure

```
apps/web/              React + Vite frontend
packages/game/         2048 game engine
packages/shared/       Types, economy math, API contracts
supabase/functions/    Edge Functions (auth, moves, deposits, leaderboard)
supabase/migrations/   Postgres schema
docs/ARCHITECTURE_V2.md
```

## Deploy

- **Frontend:** Vercel builds `apps/web` (see `vercel.json`)
- **Backend:** Supabase migrations + edge function deploy

```bash
supabase db push
supabase functions deploy
```

## Economy

- Deposits grant move credits (tiered)
- 50% of weekly deposits fund the weekly prize pool
- Top 5 weekly scorers win 35% / 25% / 20% / 15% / 5%
- Personal best score persists on the player record across sessions