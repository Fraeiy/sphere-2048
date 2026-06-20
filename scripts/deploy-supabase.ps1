# Sphere 2048 v2 — Supabase production deploy
# Run from repo root in PowerShell after filling secrets below.

$ProjectRef = "qikjgngheylczoqwspgl"
$DbPassword = Read-Host "Postgres password (from Supabase Dashboard → Database)"
$ServiceRoleKey = Read-Host "service_role / secret key (Dashboard → API)"
$JwtSecret = Read-Host "JWT Secret (Dashboard → API → JWT Settings)"
$FrontendUrl = "https://sphere-2048.vercel.app"
$CronSecret = [guid]::NewGuid().ToString("N")

$DbUrl = "postgresql://postgres:${DbPassword}@db.${ProjectRef}.supabase.co:5432/postgres"

Write-Host "`n[1/4] Pushing database migrations..."
npx supabase db push --db-url $DbUrl
if ($LASTEXITCODE -ne 0) {
  Write-Host "DB push failed. Use Supabase Dashboard → SQL Editor → paste scripts/combined-migration.sql" -ForegroundColor Yellow
}

Write-Host "`n[2/4] Linking project..."
npx supabase link --project-ref $ProjectRef

Write-Host "`n[3/4] Setting Edge Function secrets..."
npx supabase secrets set `
  SUPABASE_URL="https://${ProjectRef}.supabase.co" `
  SUPABASE_ANON_KEY="sb_publishable_SY0DS7OaTs9LgW6CbLyBAw_kKVqGCmv" `
  SUPABASE_SERVICE_ROLE_KEY="$ServiceRoleKey" `
  JWT_SECRET="$JwtSecret" `
  FRONTEND_URL="$FrontendUrl" `
  CRON_SECRET="$CronSecret"

Write-Host "`n[4/4] Deploying Edge Functions..."
$functions = @(
  "register-player", "start-game", "execute-move", "end-game",
  "process-deposit", "get-leaderboard", "get-weekly-pool", "settle-weekly-round"
)
foreach ($fn in $functions) {
  npx supabase functions deploy $fn --project-ref $ProjectRef
}

Write-Host "`nDone. Set Vercel env vars (see apps/web/.env.example) and deploy apps/web." -ForegroundColor Green