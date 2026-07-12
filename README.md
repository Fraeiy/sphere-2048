# Sphere 2048

**Classic 2048, on-chain.** Connect your Sphere wallet, spend move credits to play, and compete for weekly UCT prizes.

**Play:** [sphere-2048.vercel.app](https://sphere-2048.vercel.app)

---

## What is this?

Sphere 2048 is the tile-merging puzzle you know — slide numbered tiles, combine matching values, chase 2048 and beyond — with a Web3 twist. Every move costs a **move credit**. Credits come from **UCT deposits** on the Unicity testnet. Your best games climb the **leaderboard**, and the **weekly prize pool** pays out to the top five scorers each week.

No email signup. Your **Sphere wallet** is your identity.

---

## How to play

### 1. Connect your wallet

Open the app and tap **Connect Wallet**. Approve the connection in Sphere (testnet2). Your nametag or wallet address becomes your player name.

### 2. Deposit UCT for moves

You need **move credits** before you can play. Pick a deposit tier:

| Deposit | Moves |
|---------|-------|
| 1 UCT   | 50    |
| 5 UCT   | 300   |
| 10 UCT  | 700   |

Each move in a game uses **one credit**. When you run out, deposit again to keep playing.

### 3. Play 2048

- **Desktop:** arrow keys, or click and drag on the board
- **Mobile:** swipe on the board

Merge tiles (2+2→4, 4+4→8, …) to grow your score. The game ends when no moves are left.

### 4. Track your progress

- **SCORE** — this game only; resets when you start a new round
- **BEST** — your all-time high; saved permanently until you beat it
- **Leaderboard** — global (all-time bests per player) and weekly (this week's best game)

---

## Weekly prize pool

Every week, a slice of all deposits goes into a shared prize pool.

- **50%** of all UCT deposited that week feeds the pool
- At week's end, the **top 5 players** (by best single-game score that week) split the pool:

| Place | Share |
|-------|-------|
| 1st   | 35%   |
| 2nd   | 25%   |
| 3rd   | 20%   |
| 4th   | 15%   |
| 5th   | 5%    |

Check the **Scores** tab → **Weekly** to see the current pool size and who's leading.

---

## Autonomous treasury agent (auto-pay + DMs)

Sphere 2048 doesn’t stop at “show a leaderboard.” When a weekly round ends, a small **treasury agent** closes the week and pays winners **without a human in the loop**.

### What it does each run

1. **Settle** — if the active week’s `ends_at` has passed, lock top **5** unique scorers, write `payout_records` (35/25/20/15/5), mark the round completed, open the next week  
2. **Pay** — send UCT from the game treasury (`@2048game`) via the **Sphere SDK** (`payments.send`)  
3. **Notify** — send each winner a **Sphere DM** with place, amount, and congrats (`communications.sendDM`)

### Design choices

| Concern | Approach |
|---------|----------|
| Hosting cost | **GitHub Actions** hourly cron (free on public repos) — no Railway/Fly |
| Auth | Treasury **mnemonic** + Supabase **service role** as Actions secrets |
| Pay shape | Prefer **1 transfer** per prize; on envelope size limits, **at most 2 splits** (half + half) — no micro-chunk spam |
| Safety | Idempotent rows (`pending` → `sent` + `tx_hash`); `CERTIFICATION_UNCONFIRMED` never double-sends; retries for failed pays / missing DMs |
| Recipient | Prefer `@nametag`, fall back to wallet address |

### Where it lives

| Path | Role |
|------|------|
| [`apps/treasury-worker/`](apps/treasury-worker/) | Node agent: settle + pay + DM |
| [`.github/workflows/weekly-payout.yml`](.github/workflows/weekly-payout.yml) | Free hourly schedule + manual “Run workflow” |
| `supabase/functions/settle-weekly-round` | Optional admin-only settle (creates `pending` payouts; **no** pay/DM) |

Full setup (secrets, dry-run, Task Scheduler fallback): **[`apps/treasury-worker/README.md`](apps/treasury-worker/README.md)**  
Architecture notes: **[`docs/ARCHITECTURE_V2.md`](docs/ARCHITECTURE_V2.md)**

---

## Fair play

Moves and scores are validated **on the server**. The board you see updates instantly, but every move is checked against the real game state — so scores on the leaderboard reflect legitimate play, not client-side tricks.

---

## Requirements

- A **Sphere wallet** on **testnet2**
- **UCT** for deposits (testnet tokens)
- A modern browser (Chrome, Firefox, Safari, Edge)

---

## Quick tips

- **Deposit the tier that fits your session** — 10 UCT / 700 moves is the best value per move
- **Weekly vs global** — one great game this week can win you UCT even if your all-time best is lower
- **BEST sticks with you** — a bad game won't wipe your personal record
- **Moves don't carry between games** — unused credits stay in your balance until you use them

---

Built on [Unicity Sphere](https://sphere.unicity.network) · Powered by UCT on testnet2