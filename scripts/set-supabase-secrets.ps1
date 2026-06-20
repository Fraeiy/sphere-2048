# Run AFTER: npx supabase login
# Sets Edge Function secrets for project qikjgngheylczoqwspgl

param(
  [string]$ProjectRef = "qikjgngheylczoqwspgl",
  [Parameter(Mandatory=$true)][string]$SecretKey,
  [Parameter(Mandatory=$true)][string]$JwtSecret,
  [string]$FrontendUrl = "https://sphere-2048.vercel.app"
)

$PublishableKey = "sb_publishable_SY0DS7OaTs9LgW6CbLyBAw_kKVqGCmv"
$CronSecret = [guid]::NewGuid().ToString("N")

npx supabase secrets set --project-ref $ProjectRef `
  SUPABASE_URL="https://${ProjectRef}.supabase.co" `
  SUPABASE_ANON_KEY="$PublishableKey" `
  SUPABASE_SERVICE_ROLE_KEY="$SecretKey" `
  JWT_SECRET="$JwtSecret" `
  FRONTEND_URL="$FrontendUrl" `
  CRON_SECRET="$CronSecret"

Write-Host "Secrets set. CRON_SECRET (save for weekly cron): $CronSecret" -ForegroundColor Green

$functions = @(
  "register-player", "start-game", "execute-move", "end-game",
  "process-deposit", "get-leaderboard", "get-weekly-pool", "settle-weekly-round"
)
foreach ($fn in $functions) {
  Write-Host "Deploying $fn..."
  npx supabase functions deploy $fn --project-ref $ProjectRef
}

Write-Host "Done. Test: https://${ProjectRef}.supabase.co/functions/v1/get-leaderboard?period=global"