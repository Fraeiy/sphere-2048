# Sphere 2048

2048 game server + web client with Sphere wallet integration and token-based move economy.

Players connect a Sphere identity, deposit UCT, and spend move credits while playing 2048. The app tracks score, balance, and leaderboard state in memory, and supports optional on-chain batch submission through Sphere SDK.

## Table of Contents

1. Overview
2. Features
3. Tech Stack
4. Project Structure
5. How It Works
6. Prerequisites
7. Quick Start
8. Environment Variables
9. Available Scripts
10. API Reference
11. Deployment (Vercel)
12. Troubleshooting
13. Notes and Limitations

## Overview

Sphere 2048 combines classic 2048 gameplay with wallet-based move billing:

- Frontend lives in `public/` and calls backend APIs.
- Backend (`index.js`) stores game and user state in memory.
- User deposits are credited as move credits.
- Each move decrements `movesLeft`.
- Scores are stored per user and exposed via leaderboard.
- Optional 5-move batch payloads can be queued for on-chain submission.

## Features

- 4x4 2048 board with keyboard and touch controls
- Wallet connect flow in frontend
- In-game move economy (`0.1 UCT` per move)
- Deposit verification/testing endpoints
- Auto score persistence and leaderboard
- Move batching queue for chain updates
- Sphere status endpoint for runtime observability

## Tech Stack

- Node.js + Express
- Vanilla HTML/CSS/JS frontend
- `@unicitylabs/sphere-sdk`
- Vercel-compatible Node deployment

## Project Structure

```
.
├── index.js            # Express API server + app boot
├── game.js             # 2048 board logic
├── sphere.js           # Sphere SDK setup + chain submission helpers
├── userBalances.js     # In-memory balances, credits, leaderboard data
├── public/
│   ├── index.html      # UI shell + styles
│   └── ui.js           # Frontend controller (wallet + game actions)
├── vercel.json         # Vercel routing/build config
├── ARCHITECTURE.md     # Internal architecture notes
└── FIXES_SUMMARY.md    # Bug-fix log / behavior notes
```

## How It Works

1. User connects wallet in frontend.
2. Frontend registers user through `POST /api/register`.
3. User deposits UCT (or dev test deposit endpoint is used).
4. Backend credits moves (`movesLeft`) in memory.
5. Each valid move calls `POST /api/move` and consumes one move.
6. Every 5 moves can be queued as a batch update for chain submission.
7. Score/high score is saved via `POST /api/submit-score` and shown in leaderboard.

## Prerequisites

- Node.js 18+
- npm 9+
- Sphere SDK-compatible environment (for real chain submission)

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Create `.env` in project root (see Environment Variables section).

3. Start server:

```bash
npm start
```

4. Open app in browser:

```text
http://localhost:5000
```

## Environment Variables

Required for treasury setup:

- `GAME_TREASURY_ADDRESS`
- `GAME_TREASURY_NAMETAG`

Optional:

- `SPHERE_NETWORK` (default: `testnet`)
- `SPHERE_DATA_DIR` (default: `./sphere-data`)
- `GAME_TREASURY_MNEMONIC` (if you want deterministic SDK identity)

Example:

```env
SPHERE_NETWORK=testnet
GAME_TREASURY_ADDRESS=alpha1qq...
GAME_TREASURY_NAMETAG=2048game
SPHERE_DATA_DIR=./sphere-data
# GAME_TREASURY_MNEMONIC=word1 word2 ... word24
```

## Available Scripts

- `npm start` - run server (`node index.js`)
- `npm run dev` - run server in watch mode
- `npm run test-api` - run API test script (if present)
- `npm run cli` - Sphere SDK CLI helper via `tsx`

## API Reference

Base URL: `http://localhost:5000`

### Wallet/User

- `POST /api/connect`
	- Body: `{ walletId: string }`
	- Returns initial user + treasury info.

- `POST /api/register`
	- Body: `{ nametag?: string, address?: string }`
	- Registers user identity for game tracking.

- `GET /api/balance?userId=...`
	- Returns current balance, moves, and high score data.

### Deposit

- `POST /api/verify-deposit`
	- Body: `{ userId, senderAddress, uct }`
	- Records and credits a deposit.

- `POST /api/test-deposit`
	- Body: `{ userId, uct }`
	- Dev helper to credit balance quickly.

### Game State

- `GET /api/state?userId=...`
	- Current board, score, game status, and balance snapshot.

- `POST /api/new`
	- Body: `{ userId }`
	- Starts a new game state.

- `POST /api/move`
	- Body: `{ userId, direction }`
	- `direction` in `left|right|up|down`
	- Deducts one move and applies board update.

- `POST /api/submit-score`
	- Body: `{ userId }`
	- Persists score/high score in memory.

### Leaderboard and Status

- `GET /api/leaderboard?limit=10`
	- Top users by high score (cached briefly for performance).

- `GET /api/sphere-status`
	- Returns treasury + chain connectivity status.

## Deployment (Vercel)

Project includes `vercel.json` routing all requests to `index.js`.

Key points:

- Build/install done through npm (`npm ci`).
- API and static assets are served by Express.
- Ensure required env vars are configured in Vercel project settings.

## Troubleshooting

### Server exits at startup

- Check `.env` values for treasury config.
- If Sphere SDK init fails, server may still run but chain submissions will be disabled.

### "No moves left"

- User needs deposit credits.
- For local testing, call `/api/test-deposit`.

### Game not responding in browser

- Open browser devtools and check for JS errors.
- Confirm frontend can reach backend APIs at same origin.
- Restart server and refresh page.

### Leaderboard empty

- No users have submitted score yet.
- Play and submit score via gameplay flow.

## Notes and Limitations

- Current storage is in-memory only.
	- Restarting server resets sessions, balances, and leaderboard.
- Deposit verification is currently application-side simulation/dev-friendly.
- Chain submission is optional and queue-based for low gameplay latency.

---

If you want persistent production state, next step is adding a database layer for users, sessions, deposits, and leaderboard records.
