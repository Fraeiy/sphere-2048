# 2048 × Sphere Chain

A fully functional 2048 game with Unicity blockchain integration via the Sphere SDK.

## Architecture

- **Runtime**: Node.js 20
- **Backend**: Express 4 (`index.js`) — serves static files + REST API
- **Frontend**: Vanilla HTML/CSS/JS (`public/`)
- **Chain**: Unicity Testnet via `@unicitylabs/sphere-sdk`
- **Port**: 5000

## File Structure

```
index.js          → Express server + REST API (game state, move, submit-score)
game.js           → Pure 2048 game logic (board, moves, merges, score, game-over)
sphere.js         → Sphere SDK integration (wallet init + score broadcast)
public/
  index.html      → Main HTML page (board UI, score display, controls)
  ui.js           → Frontend controller (API calls, board rendering, keyboard)
  favicon.svg     → App icon
```

## REST API

| Method | Path                | Description                          |
|--------|---------------------|--------------------------------------|
| GET    | `/api/state`        | Get current board + score            |
| POST   | `/api/new`          | Start a fresh game                   |
| POST   | `/api/move`         | Apply a move (`{ direction }`)       |
| POST   | `/api/submit-score` | Submit final score to Unicity chain  |
| GET    | `/api/sphere-status`| Sphere SDK connection info           |

## Sphere SDK Integration

- Package: `@unicitylabs/sphere-sdk` v0.6.1 + `ws` (Node.js WebSocket)
- On server start: `createNodeProviders({ network: 'testnet' })` + `Sphere.init({ autoGenerate: true })`
- Score submission: `sphere.communications.broadcast(JSON.stringify(payload), tags)` — publishes a signed Nostr event to the Unicity relay
- Wallet mnemonic auto-generated on first run; set `SPHERE_MNEMONIC` env var to reuse a wallet
- Set `SPHERE_NETWORK` env var to `mainnet` / `testnet` (default) / `dev`

## Running

```bash
node index.js
```

## Deployment

Configured as an Autoscale deployment (`node index.js` on port 5000).
