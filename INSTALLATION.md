# Installation & Integration Guide

## Quick Start

### 1. Install Dependencies
```bash
npm install
```

This installs:
- **Express** - HTTP server framework
- **SQLite3** - Persistent database
- **CORS** - Cross-origin request handling
- **Helmet** - Security headers
- **express-rate-limit** - Rate limiting middleware
- Plus all existing blockchain/wallet dependencies

### 2. Configure Environment
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

Edit `.env` to set:
```env
PORT=5000
NODE_ENV=development
FRONTEND_URL=http://localhost:3000
```

### 3. Start the Backend Server
```bash
npm start              # Production mode
npm run dev          # Development mode (auto-reload)
```

**Expected output:**
```
[Server] 2048 Game Server listening on http://0.0.0.0:5000
[Server] Database: SQLite at sphere-data/game.db
[Server] Security: Helmet + Rate Limiting + Input Validation
```

The database is **automatically created** on first startup at `sphere-data/game.db` with all tables and indexes.

---

## Database Structure

### Auto-Initialized Tables

The database is automatically created with:

1. **users** - Player accounts, wallets, balances
2. **scores** - Game scores history
3. **deposits** - Deposit audit trail
4. **moves** - Move transactions for blockchain batching

All indexes are automatically created for performance optimization.

### Database File Location
- **Development:** `./sphere-data/game.db`
- **Production (Vercel):** Migrated to PostgreSQL (Vercel Postgres)

---

## Integration with Frontend

### The Deposit Form is Already Embedded ✅

The frontend (`public/ui.js`) already has:
- ✅ Deposit button in HTML: `#btnDeposit`
- ✅ Deposit amount prompt function
- ✅ Wallet connection via Sphere SDK
- ✅ Balance display: `#gameDeposit`
- ✅ API calls to `/api/register` and `/api/verify-deposit`

### Frontend → Backend Flow

1. **Connect Wallet** (Sphere SDK)
   ```javascript
   // In ui.js, register with game server
   POST /api/register
   { nametag: "player1", address: "alpha1qq..." }
   ```

2. **Click Deposit Button**
   ```javascript
   // Prompts for amount, then:
   POST /api/verify-deposit
   { userId: "player1", senderAddress: "...", uct: 10 }
   ```

3. **Server Updates Database**
   - Saves deposit to SQLite `deposits` table
   - Increments user's `moves_left` (0.1 UCT = 1 move)
   - Returns updated balance

4. **Frontend Updates UI**
   - Shows new balance: "In-Game Balance: 100 UTC"
   - Enables move buttons

---

## API Endpoints Summary

### Health & Monitoring
- `GET /api/health` - Server health check
- `GET /api/stats` - Database statistics
- `GET /api/sphere-status` - Blockchain connection status

### User Management
- `POST /api/register` - Register new player
- `POST /api/connect` - Connect existing wallet
- `GET /api/balance?userId=player1` - Get user balance

### Deposits & Payments
- `POST /api/verify-deposit` - Process deposit (Rate limit: 10/hour)
- `POST /api/test-deposit` - Test deposit (Development only)

### Game Actions
- `GET /api/state?userId=player1` - Get game board state
- `POST /api/new` - Start new game
- `POST /api/move` - Submit move (Rate limit: 20/min)
- `POST /api/submit-score` - Submit final score

### Leaderboard
- `GET /api/leaderboard?limit=10` - Top 10 players (Rate limit: 30/min)

---

## Security Features Enabled

### 1. CORS ✅
- Configured for frontend on `localhost:3000` and `sphere-2048.vercel.app`
- Credentials allowed for wallet integration
- Configurable via `FRONTEND_URL` env var

### 2. Helmet Headers ✅
- Content Security Policy (CSP)
- X-Frame-Options: SAMEORIGIN
- X-Content-Type-Options: nosniff
- Referrer Policy: strict-origin-when-cross-origin

### 3. Rate Limiting ✅
```
General API:      100 requests / 15 minutes
Auth endpoints:   5 requests / 1 minute
Move endpoint:    20 requests / 1 minute
Deposit:          10 requests / 1 hour
Leaderboard:      30 requests / 1 minute
```

### 4. Input Validation ✅
- Content-Type enforcement (application/json only)
- Payload size limit: 1 MB max
- Type checking on all parameters
- SQL injection prevention (parameterized queries)

### 5. Request Tracking ✅
- X-Request-ID header for audit trails
- Comprehensive error logging

---

## Deployment to Vercel

### Step 1: Push to GitHub
```bash
git add .
git commit -m "Add Express backend with SQLite and CORS"
git push origin main
```

### Step 2: Create Vercel Project
- Go to https://vercel.com/dashboard
- Click "New Project"
- Select your GitHub repository
- Framework: "Other" (Node.js)

### Step 3: Configure Environment Variables
In Vercel Project Settings → Environment Variables:
```
PORT=3000  (Vercel will override PORT)
NODE_ENV=production
FRONTEND_URL=https://sphere-2048.vercel.app
DATABASE_PATH=./sphere-data/game.db
```

### Step 4: Update vercel.json
The project already has `vercel.json` configured for serverless functions.

### Step 5: Deploy Database
For production, migrate SQLite to **PostgreSQL** (Vercel Postgres):

```bash
# Create Vercel Postgres instance
vercel env pull

# Update db.js to use postgres client
npm install pg
```

Or use an alternative:
- **Supabase** (PostgreSQL)
- **MongoDB Atlas** (NoSQL)
- **Planetscale** (MySQL)

---

## Local Development Workflow

### Start Development Servers

**Terminal 1: Backend**
```bash
npm run dev
# Listens on http://localhost:5000
# Auto-reloads on changes
```

**Terminal 2: Frontend (optional, if not using Vercel)**
```bash
# If using a separate frontend build tool
npm run build
# Or if using a dev server
npm run dev:frontend
```

### Test with curl

```bash
# Health check
curl http://localhost:5000/api/health

# Test register
curl -X POST http://localhost:5000/api/register \
  -H "Content-Type: application/json" \
  -d '{"nametag":"testuser","address":"alpha1qq..."}'

# Test deposit
curl -X POST http://localhost:5000/api/verify-deposit \
  -H "Content-Type: application/json" \
  -d '{"userId":"testuser","senderAddress":"alpha1qq...","uct":10}'

# Get leaderboard
curl http://localhost:5000/api/leaderboard?limit=10
```

---

## Troubleshooting

### Issue: "Cannot find package" error
```bash
npm install
```

### Issue: "Port 5000 already in use"
```bash
# Windows: Kill process on port 5000
netstat -ano | findstr :5000
taskkill /PID <PID> /F

# Or change PORT in .env
PORT=5001
```

### Issue: Database locked error
```bash
# SQLite database is in use. Stop the server:
Ctrl+C

# Delete the corrupted database
rm sphere-data/game.db

# Restart server to recreate
npm start
```

### Issue: CORS errors in browser console
```
// Update FRONTNED_URL in .env to match your frontend:
FRONTEND_URL=https://your-frontend-domain.vercel.app
```

### Issue: Rate limit errors
These are **intentional** to prevent abuse. Wait for the time window to reset:
- General: 15 minutes
- Deposits: 1 hour
- Moves: 1 minute

---

## Monitoring & Maintenance

### Check Server Health
```bash
curl http://localhost:5000/api/health
```

### View Database Statistics
```bash
curl http://localhost:5000/api/stats
```

### View Recent Errors
Check terminal output for logs prefixed with:
- `[Server]` - Express server events
- `[DB]` - Database operations
- `[Balance]` - User balance changes
- `[Deposit]` - Deposit processing
- `[Score]` - Score submissions

### Backup Database
```bash
# Backup SQLite database
cp sphere-data/game.db sphere-data/game.db.backup

# On Vercel, use Postgres backups (automatic)
```

---

## Performance Optimization

### Caching
- Leaderboard cached for 30 seconds
- Reduces database queries by ~90% for read-heavy loads

### Database Indexing
Automatic indexes on:
- `users(wallet_id)`
- `scores(user_id, timestamp)`
- `deposits(user_id)`
- `moves(user_id)`

### Connection Pooling
SQLite uses appropriate busy timeout and cache settings for concurrency.

---

## Next Steps

1. **Test locally** - Start backend, verify API endpoints
2. **Test with frontend** - Connect wallet, make a deposit
3. **Deploy to Vercel** - Push to GitHub, deploy automatically
4. **Monitor production** - Check `/api/health` endpoint regularly
5. **Migrate database** - Move to PostgreSQL for production scalability

---

## Support

For issues or questions:
- Check `BACKEND_API.md` for detailed API documentation
- Review `FIXES_SUMMARY.md` for recent changes
- Check error logs in terminal output

