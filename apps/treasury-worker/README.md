# Treasury worker — weekly settle, pay, DM

Node cron job that runs the full end-of-week pipeline in one shot:

1. **Settle** expired weekly round → top 5 winners + `payout_records` + open next week  
2. **Pay** pending UCT prizes from the treasury Sphere wallet (`@2048game` or your nametag)  
3. **DM** each winner a congrats / payment confirmation via Sphere `communications.sendDM`

## Setup

```bash
cd apps/treasury-worker
cp .env.example .env
# fill SUPABASE_* and TREASURY_MNEMONIC
npm install
```

Apply the DB migration (payout execution columns):

```bash
# from repo root
supabase db push
# or run migrations/20260712000001_payout_execution_fields.sql
```

Treasury mnemonic must be the **same wallet that receives deposits** so the prize pool is available to send.

## Run once

```bash
# Live
npm run settle-and-pay

# Settle + log only (no UCT / no DMs)
DRY_RUN=true npm run settle-and-pay
```

## Cron (free options — no Railway / Fly)

### 1. GitHub Actions (recommended, free on public repos)

Workflow: [`.github/workflows/weekly-payout.yml`](../../.github/workflows/weekly-payout.yml)

Runs **hourly** (+ manual “Run workflow” button). Settlement only does work when a week has actually ended.

**Setup (once):**

1. Push this repo to GitHub (public = free Actions minutes).
2. Repo → **Settings** → **Secrets and variables** → **Actions** → add:

| Secret | Required | Notes |
|--------|----------|--------|
| `SUPABASE_URL` | yes | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Service role (not anon) |
| `TREASURY_MNEMONIC` | yes | Same wallet that receives deposits |
| `TREASURY_NAMETAG` | no | Default `2048game` |
| `TREASURY_DEVICE_ID` | no | Keep stable; default `sphere-2048-gh-actions` |
| `DRY_RUN` | no | Set `true` to test without paying |

3. **Actions** → **Weekly payout** → **Run workflow** (try `dry_run: true` first).
4. Leave the schedule on; no paid host needed.

### 2. Your own PC (Windows Task Scheduler) — also free

If the machine is on around week rollover:

```powershell
# From repo root, after apps/treasury-worker/.env is filled:
cd C:\Users\USER\sphere-2048\apps\treasury-worker
npm run settle-and-pay
```

Create a Task Scheduler task: trigger hourly, action = that command (or a small `.ps1` wrapper).

### 3. Linux/Mac crontab (home server / always-on box)

```bash
15 * * * * cd /path/to/sphere-2048/apps/treasury-worker && npm run settle-and-pay >> /tmp/sphere-2048-payout.log 2>&1
```

Settlement only acts when `weekly_rounds.ends_at < now()` and status is `active`. Paying is idempotent on `payout_records` (`pending`/`failed` → `sent`).

## Safety

| Rule | Behavior |
|------|----------|
| Idempotent pay | Rows with `status=sent` + `tx_hash` are never re-sent |
| `CERTIFICATION_UNCONFIRMED` | Marked `sent` without a second `send()`; `resumeOpenIntents()` on next boot |
| DM after pay | DMs only after successful pay; missing DMs retried while `dm_sent_at` is null |
| Attempt cap | `MAX_PAY_ATTEMPTS` (default 5) stops endless failed retries |
| Recipient | Prefer `@nametag` from `players.display_name` / nametag-like `did`, else wallet address |
| Pay splits | **Max 2** `payments.send` calls per prize: full amount, or two halves if envelope is too large |
| Partial pay | `amount_paid_atomic` tracks progress if a half-send fails mid-way |

## Payment shape

- Default: **1 send** for the full prize  
- If wallet-api rejects with envelope-too-large: **exactly 2 sends** (half + half), memos `part 1/2` and `part 2/2`  
- **No** 1-UCT micro-chunk spam  

Note: Unicity may still show multiple small “Received” lines *inside* one send (token unpack). That is protocol UI, not extra `send()` calls from us.

## Env

See [`.env.example`](./.env.example).

## Relationship to Edge Function

`supabase/functions/settle-weekly-round` still exists for admin/manual settle (creates `pending` payouts only). **This worker is the production path** for settle **and** auto-pay + DMs. Prefer a single cron on the worker; avoid double-settling the same round (worker and edge both check status/`ends_at`).
