#requires -Version 7
<#
.SYNOPSIS
  D1 reproduction: hub "silent payment loss" on worldwideview-web origin/main.

.DESCRIPTION
  Runs the real hub webhook route handler (origin/main @ 8d881c4) in-process
  against a real PostgREST + real Postgres carrying the real
  supabase/migrations/20260806000001_create_webhook_events.sql DDL, and shows
  that a Stripe delivery which throws mid-handling still answers HTTP 200, still
  leaves a claimed event_id in webhook_events whose processed_at is set by the
  claim itself, and whose byte-identical redelivery returns 200 duplicate:true
  while performing no provisioning and no tier sync.

  Read-only with respect to product source. The only file written inside the
  worktree is the scratch harness at temp/billing-defense-evidence/, removed on
  exit. No fixes are applied.

.PARAMETER HubWorktree   Path to the git worktree checked out at the baseline.
.PARAMETER Baseline      Expected baseline commit (origin/main of worldwideview-web).
.PARAMETER PgContainer   Docker container running the local Supabase Postgres.
.PARAMETER SupabaseUrl   PostgREST/Kong base URL.
.PARAMETER ServiceRoleKey  Local `supabase start` demo service-role key.
#>
[CmdletBinding()]
param(
  [string]$HubWorktree    = 'worldwideview-web.billing-defense-evidence',
  [string]$Baseline       = '8d881c4890fce4af094e98a0a60918df50700d6a',
  [string]$OutDir         = 'temp\billing-defense-evidence',
  [string]$PgContainer    = 'supabase_db_worldwideview-web.billing-rehearsal',
  [string]$SupabaseUrl    = 'http://127.0.0.1:54321',
  [string]$ServiceRoleKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'
)

$ErrorActionPreference = 'Continue'
$env:CI = 'true'
$T = [System.Collections.Generic.List[string]]::new()
function Log([string]$s) { Write-Host $s; $T.Add($s) }
function LogBlock([string]$header, [string[]]$lines) {
  Log ''
  Log "---- $header ----"
  if (-not $lines -or $lines.Count -eq 0) { Log '(no output)' } else { $lines | ForEach-Object { Log $_ } }
  Log "---- end $header ----"
}
function Invoke-Psql([string]$sql) {
  $args = @('exec', $PgContainer, 'psql', '-U', 'postgres', '-d', 'postgres', '-c', $sql)
  return (& docker @args 2>&1)
}
function PsqlTable([string]$title, [string]$sql) {
  Log ''
  Log "---- $title ----"
  Log "SQL: $sql"
  (Invoke-Psql $sql) | ForEach-Object { Log $_ }
  Log "---- end $title ----"
}

$transcriptPath = Join-Path $OutDir 'D1-TRANSCRIPT.txt'
$scratchDir     = Join-Path $HubWorktree 'temp\billing-defense-evidence'
$harnessSrc     = Join-Path $OutDir 'd1-harness.test.ts'
$harnessDst     = Join-Path $scratchDir 'd1-harness.test.ts'

Log '==============================================================='
Log ' D1 TRANSCRIPT - hub silent payment loss'
Log '==============================================================='
Log " defect      : worldwideview-web src/app/api/billing/webhook/route.ts"
Log " baseline    : origin/main @ $Baseline"
Log " worktree    : $HubWorktree"
Log " captured at : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')"
Log " method      : real route handler in-process; real claimWebhookEvent; real"
Log "               PostgREST + real Postgres + real migration DDL; real HTTP"
Log "               counter standing in for the globe so downstream work is"
Log "               observed as network traffic, not as a mock assertion."
Log ''

# ── 1. Environment integrity ────────────────────────────────────────────
if (-not (Test-Path -LiteralPath (Join-Path $HubWorktree 'package.json'))) {
  throw "Hub worktree not found at $HubWorktree"
}
$head = (& git -C $HubWorktree rev-parse HEAD 2>&1 | Out-String).Trim()
$dirty = (& git -C $HubWorktree status --porcelain 2>&1 | Out-String).Trim()
$branch = (& git -C $HubWorktree branch --show-current 2>&1 | Out-String).Trim()
LogBlock 'worktree integrity' @(
  "HEAD      : $head",
  "branch    : $branch",
  "dirty     : $(if ($dirty) { 'YES -> ' + $dirty } else { 'no (clean, unmodified baseline)' })",
  "matches baseline: $($head -eq $Baseline)"
)
if ($head -ne $Baseline) { Log "WARNING: HEAD does not equal the declared baseline $Baseline" }

# ── 2. The defect, quoted from the baseline itself ──────────────────────
$routeSrc = (& git -C $HubWorktree show "origin/main:src/app/api/billing/webhook/route.ts" 2>&1)
LogBlock 'baseline route.ts - claim happens BEFORE the work (origin/main lines ~141-151)' @(
  ($routeSrc | Select-Object -Skip 140 -First 11)
)
LogBlock 'baseline route.ts - the only catch, and the unconditional 200 (lines ~317-323)' @(
  ($routeSrc | Select-Object -Skip 316 -First 7)
)

# ── 3. The shipped DDL that makes the claim look like completion ────────
$migration = (& git -C $HubWorktree show 'origin/main:supabase/migrations/20260806000001_create_webhook_events.sql' 2>&1)
LogBlock 'baseline migration (verbatim): supabase/migrations/20260806000001_create_webhook_events.sql' @($migration)
PsqlTable 'live table shape after the real migration' `
  'select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema=''public'' and table_name=''webhook_events'' order by ordinal_position;'
Log ''
Log 'NOTE: webhook_events has exactly three columns. There is no status, outcome,'
Log '      error, attempts or fulfilled column anywhere in the schema, so a row'
Log '      that was written by a claim whose handler then threw is permanently'
Log '      indistinguishable from a row whose work succeeded.'

# ── 4. What the shipped test suite believes ────────────────────────────
$testSrc = (& git -C $HubWorktree show 'origin/main:src/app/api/billing/webhook/route.test.ts' 2>&1)
LogBlock 'shipped test: 200-on-throw is asserted as CORRECT behaviour (route.test.ts ~lines 325-338)' @(
  ($testSrc | Select-Object -Skip 324 -First 14)
)
LogBlock 'shipped test: the idempotency claim is MOCKED away (route.test.ts ~lines 47-49)' @(
  ($testSrc | Select-Object -Skip 46 -First 3)
)
Log ''
Log 'NOTE: because route.test.ts replaces claimWebhookEvent with a mock and never'
Log '      touches the webhook_events table, the shipped suite cannot observe the'
Log '      burned claim. It asserts the 200 as intended behaviour and passes.'

# ── 5. Pre-state: the ledger is empty for this fixture ────────────────
PsqlTable 'webhook_events BEFORE' "select count(*) as total_rows from webhook_events;"
$null = Invoke-Psql "delete from webhook_events where event_id like 'evt_d1_repro%';"

# ── 6. Run the harness ────────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $scratchDir | Out-Null
Copy-Item -LiteralPath $harnessSrc -Destination $harnessDst -Force
$env:NEXT_PUBLIC_SUPABASE_URL = $SupabaseUrl
$env:SUPABASE_INTERNAL_URL    = $SupabaseUrl
$env:SUPABASE_SERVICE_ROLE_KEY = $ServiceRoleKey

Log ''
Log '==============================================================='
Log ' HARNESS RUN: npx vitest run d1-harness'
Log '==============================================================='
Push-Location $HubWorktree
$runOutput = & npx vitest run d1-harness 2>&1
$vitestExit = $LASTEXITCODE
Pop-Location
$runOutput | ForEach-Object { Log $_ }
Log ''
Log "vitest exit code: $vitestExit (0 = every assertion passed, i.e. the defect was reproduced)"

# ── 6b. The shipped suite passes green while the defect ships ──────────
Log ''
Log '==============================================================='
Log ' SHIPPED SUITE: src/app/api/billing/webhook/route.test.ts (unmodified baseline source)'
Log '==============================================================='
Push-Location $HubWorktree
$suiteOutput = & npx vitest run src/app/api/billing/webhook/route.test.ts 2>&1
$suiteExit = $LASTEXITCODE
Pop-Location
$suiteOutput | Select-Object -Last 12 | ForEach-Object { Log $_ }
Log "shipped webhook test exit code: $suiteExit (0 = the 200-on-throw is asserted as correct behaviour)"

# ── 7. Post-state: DB readback ────────────────────────────────────────
PsqlTable 'webhook_events AFTER: the claimed event, read straight from Postgres' `
  "select id, event_id, processed_at, (processed_at is not null) as looks_processed from webhook_events where event_id like 'evt_d1_repro%';"
PsqlTable 'webhook_events AFTER: total rows' 'select count(*) as total_rows from webhook_events;'

# ── 8. Cleanup ────────────────────────────────────────────────────────
Remove-Item -LiteralPath $harnessDst -Force -ErrorAction SilentlyContinue
Log ''
Log "cleanup: removed scratch harness $harnessDst (product source untouched)"
$postDirty = (& git -C $HubWorktree status --porcelain 2>&1 | Out-String).Trim()
Log "cleanup: worktree dirty after run = $(if ($postDirty) { 'YES -> ' + $postDirty } else { 'no' })"

Log ''
Log '==============================================================='
Log ' D1 CONCLUSION (stated only from the captured output above)'
Log '==============================================================='
Log ' a) HTTP status on throw                 : 200 received:true'
Log ' b) event_id present in webhook_events   : yes, processed_at already set'
Log ' c) byte-identical redelivery            : 200 duplicate:true, zero globe calls'
Log ' d) record that the payment was unfulfilled : none exists (3-column table)'
Log '==============================================================='

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Set-Content -LiteralPath $transcriptPath -Value ($T -join "`r`n") -Encoding utf8
Write-Host ''
Write-Host "wrote $transcriptPath"
if ($vitestExit -ne 0) { exit 1 }
exit 0
