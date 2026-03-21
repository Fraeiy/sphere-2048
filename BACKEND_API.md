# Backend API Documentation

## Overview

The Sphere 2048 backend is a **Node.js Express server** with **SQLite persistence**, **CORS support**, and **comprehensive security** measures including rate limiting, input validation, and helmet security headers.

## Database Architecture

### SQLite Schema

The backend uses 4 main tables for persistent data storage:

#### 1. **users** — Player Accounts
```
id                INTEGER PRIMARY KEY
user_id          TEXT UNIQUE       (wallet ID or nametag)
wallet_id        TEXT              (wallet address)
balance          INTEGER           (current balance in atomic units)
total_deposited  INTEGER           (lifetime deposits)
moves_left       INTEGER           (available moves)
total_moves      INTEGER           (lifetime moves played)
high_score       INTEGER           (best game score)
last_move        INTEGER           (timestamp of last move)
created_at       INTEGER           (account creation time)
updated_at       INTEGER           (last update time)
```

#### 2. **scores** — Game History
```
id               INTEGER PRIMARY KEY
user_id          TEXT              (foreign key to users)
wallet_id        TEXT              (denormalized)
score            INTEGER           (game score)
moves_used       INTEGER           (moves in that game)
timestamp        INTEGER           (when score was submitted)
submitted_to_chain  INTEGER        (blockchain submission status)
tx_hash          TEXT              (transaction hash)
```

#### 3. **deposits** — Audit Trail
```
id               INTEGER PRIMARY KEY
user_id          TEXT              (foreign key to users)
wallet_id        TEXT              (denormalized)
amount           INTEGER           (deposit amount in atomic units)
coin_id          TEXT              (always 'UCT')
tx_hash          TEXT              (transaction hash)
verified         INTEGER           (verification status)
deposit_date     INTEGER           (when deposit occurred)
created_at       INTEGER           (record creation time)
```

#### 4. **moves** — Blockchain Submission Batching
```
id               INTEGER PRIMARY KEY
user_id          TEXT              (foreign key to users)
move_number      INTEGER           (sequence in game)
direction        TEXT              (up/down/left/right)
score_after      INTEGER           (score after this move)
game_id          TEXT              (game identifier)
batch_hash       TEXT              (batch identifier)
submitted_to_chain  INTEGER        (blockchain status)
created_at       INTEGER           (timestamp)
```

## API Routes

### Authentication Routes

#### POST `/api/connect`
Connect a wallet to the game and initialize session.

**Request:**
```json
{
  "walletId": "alpha1qq8... or myname"
}
```

**Response:**
```json
{
  "success": true,
  "userId": "myname",
  "balance": {
    "current": "10.0",
    "totalDeposited": "50.0",
    "movesLeft": 500
  },
  "treasuryAddress": "alpha1qq...",
  "treasuryNametag": "sphere2048"
}
```

#### POST `/api/register`
Register a new player with the game server.

**Request:**
```json
{
  "nametag": "myname",
  "address": "alpha1qq8..."
}
```

**Response:**
```json
{
  "success": true,
  "userId": "myname",
  "treasuryAddress": "alpha1qq...",
  "treasuryNametag": "sphere2048"
}
```

---

### Balance Routes

#### GET `/api/balance?userId=myname`
Get current user balance and moves.

**Response:**
```json
{
  "success": true,
  "userId": "myname",
  "balance": {
    "current": "10.5",
    "totalDeposited": "50.0",
    "movesLeft": 500,
    "totalMoves": 1000,
    "highScore": 4096
  }
}
```

---

### Deposit Routes

#### POST `/api/verify-deposit`
Process and verify a deposit transaction.

**Rate Limit:** 10 per hour

**Request:**
```json
{
  "userId": "myname",
  "senderAddress": "alpha1qq...",
  "uct": 10.5,
  "txHash": "0x123abc..."
}
```

**Response:**
```json
{
  "success": true,
  "transaction": {
    "hash": "0x123abc...",
    "from": "alpha1qq...",
    "amount": 10.5,
    "timestamp": 1711000000000,
    "verified": true
  },
  "balance": {
    "current": "20.5",
    "totalDeposited": "60.5",
    "movesLeft": 600
  }
}
```

#### POST `/api/test-deposit`
Test deposit endpoint for MVP/development.

**Rate Limit:** 5 per minute

**Request:**
```json
{
  "userId": "myname",
  "uct": 10
}
```

---

### Game Routes

#### GET `/api/state?userId=myname`
Get current game state.

**Response:**
```json
{
  "success": true,
  "userId": "myname",
  "board": [[2,4,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]],
  "score": 6,
  "movesLeft": 499,
  "gameOver": false
}
```

#### POST `/api/new`
Start a new game.

**Request:**
```json
{
  "userId": "myname"
}
```

**Response:**
```json
{
  "success": true,
  "board": [[2,2,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]],
  "score": 0,
  "movesLeft": 500
}
```

#### POST `/api/move`
Submit a move (direction: up/down/left/right).

**Rate Limit:** 20 per minute

**Request:**
```json
{
  "userId": "myname",
  "direction": "right"
}
```

**Response:**
```json
{
  "success": true,
  "board": [[0,0,0,4],[0,0,0,2],[0,0,0,0],[0,0,0,0]],
  "score": 6,
  "moved": true,
  "movesLeft": 499
}
```

---

### Leaderboard Routes

#### GET `/api/leaderboard?limit=10`
Get top players by high score.

**Rate Limit:** 30 per minute

**Response:**
```json
{
  "success": true,
  "leaderboard": [
    {
      "rank": 1,
      "wallet_id": "alpha1qq...",
      "high_score": 8192,
      "total_moves": 5000,
      "game_count": 15,
      "avg_score": 4500
    }
  ],
  "cached": false
}
```

---

### Score Routes

#### POST `/api/submit-score`
Submit final game score to persistent database.

**Request:**
```json
{
  "userId": "myname",
  "score": 4096,
  "movesUsed": 450
}
```

**Response:**
```json
{
  "success": true,
  "userId": "myname",
  "score": 4096,
  "highScore": 4096,
  "totalMoves": 1450
}
```

---

### Admin Routes

#### GET `/api/stats`
Get server and database statistics.

**Response:**
```json
{
  "success": true,
  "server_time": 1711000000000,
  "database": {
    "total_users": 256,
    "total_scores": 1024,
    "total_deposits": 512,
    "db_path": "/app/sphere-data/game.db"
  },
  "sphere_status": { ... }
}
```

#### GET `/api/health`
Health check endpoint for monitoring.

**Response:**
```json
{
  "status": "healthy",
  "timestamp": 1711000000000,
  "uptime": 3600.5,
  "environment": "production"
}
```

---

## Security Features

### 1. CORS (Cross-Origin Resource Sharing)
✅ **Enabled** with allowed origins:
- `http://localhost:3000` (development)
- `https://sphere-2048.vercel.app` (production)
- Vercel preview deployments (*.vercel.app)
- Configurable via `FRONTEND_URL` environment variable

### 2. Helmet Security Headers
✅ **Enabled** with:
- Content Security Policy (CSP)
- Frameguard
- Referrer Policy
- X-Frame-Options
- X-Content-Type-Options
- etc.

### 3. Rate Limiting
✅ **Implemented** with tiered limits:
- **General:** 100 requests per 15 minutes
- **Auth:** 5 per minute
- **Moves:** 20 per minute
- **Deposits:** 10 per hour
- **Leaderboard:** 30 per minute

### 4. Input Validation
✅ **Applied** to all endpoints:
- Content-Type enforcement (application/json only)
- Payload size limit (1 MB max)
- Type checking on all parameters
- Range validation (amounts, limits)
- SQL injection prevention (parameterized queries)

### 5. Request Tracking
✅ **X-Request-ID** headers for audit trails

---

## Environment Variables

Create a `.env` file in the project root:

```env
# Express Server
PORT=5000
NODE_ENV=development

# Frontend URL for CORS
FRONTEND_URL=http://localhost:3000

# Sphere SDK Configuration
SPHERE_WALLET_URL=https://sphere.unicity.network
SPHERE_API_URL=https://api.unicity.network

# Wallet Credentials (optional for testing)
WALLET_PRIVATE_KEY=...
WALLET_SEED_PHRASE=...
```

---

## Setup & Deployment

### Local Development

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Initialize database:**
   Database is automatically created on first startup at `sphere-data/game.db`

3. **Start server:**
   ```bash
   npm start        # Production mode
   npm run dev      # Development with auto-reload
   ```

4. **Test API:**
   ```bash
   npm run test-api
   ```

### Vercel Deployment

The backend is configured for Vercel serverless deployment:

1. **Push to GitHub:**
   ```bash
   git push origin main
   ```

2. **Deploy to Vercel:**
   - Connect your GitHub repo to Vercel
   - Set environment variables in Vercel dashboard
   - Vercel will automatically deploy

3. **Database Persistence:**
   - SQLite database is stored in `sphere-data/game.db`
   - For serverless, consider migrating to:
     - PostgreSQL (Vercel Postgres)
     - MongoDB (cloud-hosted)
     - CloudFlare D1

### Error Handling

All API endpoints return consistent error responses:

```json
{
  "success": false,
  "error": "Error code",
  "details": "Detailed error message"
}
```

HTTP Status Codes:
- `200` — Success
- `400` — Bad Request (validation error)
- `402` — Payment Required (no moves left)
- `404` — Not Found (user/resource)
- `429` — Too Many Requests (rate limit)
- `500` — Server Error

---

## Monitoring & Maintenance

### Health Check
```bash
curl http://localhost:5000/api/health
```

### Database Stats
```bash
curl http://localhost:5000/api/stats
```

### View Recent Errors
Errors are logged to console with `[Server]`, `[DB]`, `[Balance]` prefixes.

---

## Performance Optimization

- **Leaderboard Caching:** 30-second TTL to reduce database load
- **Indexed Queries:** Automatic indexes on `user_id`, `wallet_id`, `timestamp`
- **Connection Pooling:** SQLite with optimized busy timeout
- **Request Batching:** Move transactions batched before blockchain submission

---

## Future Enhancements

- [ ] PostgreSQL migration for production
- [ ] JWT authentication for API security
- [ ] Webhook integration for blockchain verification
- [ ] Real-time leaderboard updates (WebSocket)
- [ ] Admin dashboard with analytics
- [ ] User account deletion/privacy features
- [ ] Blockchain score verification
- [ ] Anti-fraud detection (suspicious patterns)

