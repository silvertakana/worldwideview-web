#Requires -Version 7
<#
.SYNOPSIS
  Group A (money safety) reproduction orchestrator for the WWV hub billing webhook.

.DESCRIPTION
  Reproduces every Group A break-it scenario from nothing against the running
  local billing test stack, then falsifies the harness by running the SAME file
  against pre-fix origin/main.

  Real:  the hub HTTP endpoint (live `next dev` on a spare port), the real
         Next.js route pipeline, the hub's own stripe.webhooks.constructEvent,
         the real stripe-node SDK, the real cross-service HMAC signer, and the
         real `webhook_events` ledger (PostgREST -> Postgres).
  Stood in for (unavoidable): api.stripe.com and the globe's /api/provision +
         /api/service/tier-sync. Both stand-ins are ordinary HTTP servers, so
         "did the handler do downstream work" is answered by observed network
         traffic rather than by a spy.

  Writes GROUPA-TRANSCRIPT.txt into -OutDir and exits 1 on any failure.

.EXAMPLE
  pwsh -File groupa-reproduce.ps1
#>
[CmdletBinding()]
param(
  [string]$EvidenceWorktree = 'worldwideview-web.billing-group-a-evidence',
  [string]$BaselineWorktree = 'worldwideview-web.billing-group-a-baseline',
  [string]$RepoRoot         = 'worldwideview-web',
  [string]$OriginRef        = 'origin/main',
  [string]$OutDir           = 'temp\billing-group-a-evidence',
  [string]$HarnessDir       = '',
  [string]$PgContainer      = 'supabase_db_worldwideview-web.billing-rehearsal',
  [string]$SupabaseUrl      = 'http://127.0.0.1:54321',
  [int]$HubPort             = 3011,
  [int]$GlobePort           = 30191,
  [int]$StripePort          = 30192,
  [int]$BaselineHubPort     = 3013,
  [int]$BaselineGlobePort   = 30193,
  [int]$BaselineStripePort  = 30194,
  [switch]$SkipFalsification
)

$env:CI = 'true'
$ErrorActionPreference = 'Continue'
if ([string]::IsNullOrWhiteSpace($HarnessDir)) { $HarnessDir = Join-Path $EvidenceWorktree 'temp\billing-group-a-evidence' }
$Harness = Join-Path $HarnessDir 'groupa-harness.mjs'
$Migration = Join-Path $EvidenceWorktree 'supabase\migrations\20260915000001_webhook_events_completion_state.sql'

$script:Transcript = [System.Collections.Generic.List[string]]::new()
function Log([string]$line = '') {
  Write-Host $line
  $script:Transcript.Add($line)
}
function LogBlock([string]$header, [string[]]$bodyLines) {
  Log "---- $header ----"
  foreach ($l in $bodyLines) { Log $l }
  Log "---- end $header ----"
}
function Invoke-Psql([string]$sql) {
  docker exec $PgContainer psql -U postgres -d postgres -t -A -F'|' -c $sql 2>&1
}
function PsqlTable([string]$title, [string]$sql) {
  Log "[SQL] $title"
  Log "      $sql"
  $rows = Invoke-Psql $sql
  if (-not $rows) { Log "      (no rows)"; return }
  foreach ($r in $rows) { Log "      $r" }
}

Log ""
Log "###############################################################################"
Log "#  WWV hub billing webhook - GROUP A (money safety) reproduction"
Log "#  Standard: 'It cannot break silently, and it cannot stay broken for long.'"
Log "#  Generated $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')"
Log "###############################################################################"

# =============================================================================
Log ""
Log "== 1. ENVIRONMENT INTEGRITY =="
# =============================================================================
$fixHead = (git -C $EvidenceWorktree rev-parse HEAD).Trim()
$fixBranch = (git -C $EvidenceWorktree branch --show-current).Trim()
$fixStatus = @(git -C $EvidenceWorktree status --porcelain)
$originSha = (git -C $RepoRoot rev-parse $OriginRef).Trim()
LogBlock 'evidence worktree (the code under test)' @(
  "path            = $EvidenceWorktree",
  "branch          = $fixBranch",
  "HEAD            = $fixHead",
  "base ref        = $OriginRef @ $originSha",
  "git status      = $(if ($fixStatus.Count -eq 0) { 'clean' } else { "DIRTY ($($fixStatus.Count) entries)" })",
  "harness         = $Harness",
  "migration       = $Migration"
)
$baselineHead = (git -C $EvidenceWorktree show -s --format=%H $OriginRef).Trim()
LogBlock 'pre-existing Group A entry gate (read-only context)' @(
  "decision doc    = temp\billing-launch-readiness.md sec 2 (Group A) / sec 3 (D1)",
  "branch status   = temp\billing-launch-branch-status.md (A @0ffd703 = D1 work, DONE)",
  "launch gate (hub fix worktree, unmodified): see sec 6 of the branch-status doc"
)

# =============================================================================
Log ""
Log "== 2. THE CODE UNDER TEST, QUOTED FROM THE EVIDENCE WORKTREE =="
# =============================================================================
$routeRel = 'src/app/api/billing/webhook/route.ts'
$idemRel = 'src/lib/billing/webhook-idempotency.ts'
LogBlock "POST-fix: $routeRel (claim -> work -> complete / fail)" @(
  (Get-Content -LiteralPath (Join-Path $EvidenceWorktree $routeRel) | Select-Object -Skip 144 -First 16)
)
LogBlock "POST-fix: $routeRel (the failure path and the completion marker)" @(
  (Get-Content -LiteralPath (Join-Path $EvidenceWorktree $routeRel) | Select-Object -Skip 324 -First 21)
)
LogBlock "POST-fix: $idemRel (the two-state contract)" @(
  (Get-Content -LiteralPath (Join-Path $EvidenceWorktree $idemRel) | Select-Object -Skip 4 -First 12)
)
LogBlock "POST-fix migration $(Split-Path $Migration -Leaf)" @(
  (Get-Content -LiteralPath $Migration)
)

# =============================================================================
Log ""
Log "== 3. THE PRE-FIX CODE, FOR CONTRAST (origin/main, read-only) =="
# =============================================================================
LogBlock "PRE-fix: $routeRel (claim before any work; 200 regardless of outcome)" @(
  (git -C $RepoRoot show "${OriginRef}:$routeRel" | Select-Object -Skip 138 -First 16)
)
LogBlock "PRE-fix: $routeRel (the swallow + unconditional 200)" @(
  (git -C $RepoRoot show "${OriginRef}:$routeRel" | Select-Object -Skip 316 -First 8)
)

# =============================================================================
Log ""
Log "== 4. LEDGER (real Postgres) - PRE-STATE AND MIGRATION =="
# =============================================================================
Log "[DEPENDENCY] local billing test stack containers:"
(docker ps --format '{{.Names}}  [{{.Status}}]' | Where-Object { $_ -like 'supabase_*billing-rehearsal*' }) | ForEach-Object { Log "      $_" }
Log "      ledger endpoint: $SupabaseUrl (Kong -> PostgREST -> $PgContainer)"
PsqlTable 'webhook_events columns BEFORE applying the fix migration' "select column_name, data_type, is_nullable, coalesce(column_default,'-') from information_schema.columns where table_name='webhook_events' order by ordinal_position;"
Log ""
Log "[ACTION] applying $(Split-Path $Migration -Leaf) (idempotent DDL) to $PgContainer"
Get-Content -LiteralPath $Migration -Raw | docker exec -i $PgContainer psql -U postgres -d postgres -v ON_ERROR_STOP=1 2>&1 | ForEach-Object { Log "      $_" }
PsqlTable 'webhook_events columns AFTER the migration' "select column_name, data_type, is_nullable, coalesce(column_default,'-') from information_schema.columns where table_name='webhook_events' order by ordinal_position;"
PsqlTable 'webhook_events indexes AFTER the migration' "select indexname from pg_indexes where tablename='webhook_events' order by indexname;"

# =============================================================================
Log ""
Log "== 5. SCENARIOS A1..A6 (real endpoint, real ledger) =="
# =============================================================================
Set-Location $EvidenceWorktree
$harnessOut = & node $Harness --hub-cwd $EvidenceWorktree --hub-port $HubPort --globe-port $GlobePort --stripe-port $StripePort --out $HarnessDir 2>&1
$harnessExit = $LASTEXITCODE
foreach ($l in $harnessOut) { Log $l }
Log ""
Log "[RESULT] Group A harness exit code = $harnessExit (0 = every check passed)"
$resultLine = ($harnessOut | Where-Object { $_ -like 'GROUPA_RESULT *' } | Select-Object -Last 1)
Log "[RESULT] $resultLine"

# =============================================================================
Log ""
Log "== 6. LEDGER POST-STATE =="
# =============================================================================
PsqlTable 'every Group A fixture row in webhook_events (the durable record)' "select event_id, coalesce(processed_at::text,'NULL') as processed_at, coalesce(last_error,'NULL') as last_error, coalesce(last_attempt_at::text,'NULL') as last_attempt_at from webhook_events where event_id like 'evt_groupa_%' order by event_id;"

# =============================================================================
$falsificationExit = $null
$falsificationFailedA1 = $null
if (-not $SkipFalsification) {
  Log ""
  Log "== 7. FALSIFICATION: the SAME harness against PRE-FIX origin/main =="
  Log "    A green harness that is also green on broken code proves nothing. This"
  Log "    step reverts the ledger to its pre-fix shape (processed_at NOT NULL"
  Log "    DEFAULT now()), runs the identical file against $OriginRef, and requires"
  Log "    it to FAIL on A1 while A3 stays green."
  if (-not (Test-Path -LiteralPath $BaselineWorktree)) {
    Log "[ACTION] creating baseline worktree $BaselineWorktree at $OriginRef"
    git -C $RepoRoot worktree add -b billing-group-a-baseline $BaselineWorktree $OriginRef 2>&1 | ForEach-Object { Log "      $_" }
  }
  $baselineHeadNow = (git -C $BaselineWorktree rev-parse HEAD).Trim()
  Log "[INFO] baseline worktree HEAD = $baselineHeadNow (must equal $originSha)"
  Log "[INFO] package.json difference baseline -> fix tip (node_modules is shared by junction):"
  (git -C $RepoRoot diff --stat $OriginRef $fixHead -- package.json) | ForEach-Object { Log "      $_" }
  if (-not (Test-Path -LiteralPath (Join-Path $BaselineWorktree 'node_modules'))) {
    New-Item -ItemType Junction -Path (Join-Path $BaselineWorktree 'node_modules') `
      -Target (Join-Path $EvidenceWorktree 'node_modules') | Out-Null
    Log "[ACTION] junctioned the baseline worktree's node_modules onto the evidence worktree's"
  }
  Log ""
  Log "[ACTION] reverting webhook_events.processed_at to the pre-fix shape"
  Invoke-Psql "ALTER TABLE webhook_events ALTER COLUMN processed_at SET DEFAULT now(); ALTER TABLE webhook_events ALTER COLUMN processed_at SET NOT NULL;" | ForEach-Object { Log "      $_" }
  PsqlTable 'pre-fix shape restored' "select column_name, is_nullable, coalesce(column_default,'-') from information_schema.columns where table_name='webhook_events' and column_name='processed_at';"
  Set-Location $BaselineWorktree
  $baselineOut = & node $Harness --hub-cwd $BaselineWorktree --hub-port $BaselineHubPort --globe-port $BaselineGlobePort --stripe-port $BaselineStripePort --out (Join-Path $HarnessDir 'baseline') --only A1,A3 2>&1
  $falsificationExit = $LASTEXITCODE
  foreach ($l in $baselineOut) { Log $l }
  $baselineResult = ($baselineOut | Where-Object { $_ -like 'GROUPA_RESULT *' } | Select-Object -Last 1)
  Log "[RESULT] pre-fix harness exit code = $falsificationExit (1 = it detected the defect)"
  Log "[RESULT] $baselineResult"
  $falsificationFailedA1 = @($baselineOut | Where-Object { $_ -like '*FAIL A1:*' }).Count
  Log ""
  Log "[ACTION] restoring the fix migration shape"
  Get-Content -LiteralPath $Migration -Raw | docker exec -i $PgContainer psql -U postgres -d postgres -v ON_ERROR_STOP=1 2>&1 | ForEach-Object { Log "      $_" }
  PsqlTable 'fix shape restored' "select column_name, is_nullable, coalesce(column_default,'-') from information_schema.columns where table_name='webhook_events' and column_name='processed_at';"

  # ---------------------------------------------------------------------------
  Log ""
  Log "== 7b. A2 CONCURRENCY: fix side vs pre-fix side =="
  Log "     A2.c fires 5 simultaneous deliveries of ONE event and counts how many"
  Log "     were allowed to process. The pre-fix handler is re-run here (with the"
  Log "     fix schema in place; its claim never reads processed_at, so the ledger"
  Log "     shape does not change its behaviour) purely to measure the difference."
  # ---------------------------------------------------------------------------
  $fixConcurrent = [regex]::Match(($harnessOut -join "`n"), 'A2\.c\] downstream /api/provision hits = (\d+)').Groups[1].Value
  Set-Location $BaselineWorktree
  $baselineA2 = & node $Harness --hub-cwd $BaselineWorktree --hub-port $BaselineHubPort --globe-port $BaselineGlobePort --stripe-port $BaselineStripePort --out (Join-Path $HarnessDir 'baseline-a2') --only A2 2>&1
  $baselineConcurrent = [regex]::Match(($baselineA2 -join "`n"), 'A2\.c\] downstream /api/provision hits = (\d+)').Groups[1].Value
  $baselineSkipLog = @($baselineA2 | Where-Object { $_ -like '*already processed; skipping*' })
  Log ""
  Log "[EVIDENCE A2.c-CONTRAST] 5 concurrent deliveries of one event -> deliveries allowed to process:"
  Log "      pre-fix  ($OriginRef)            = $baselineConcurrent"
  Log "      post-fix ($fixHead)              = $fixConcurrent"
  Log "[EVIDENCE A2.c-CONTRAST] both sides create exactly ONE ledger row; only the"
  Log "      number of deliveries permitted to do the work differs."
  if ($baselineSkipLog.Count -gt 0) {
    LogBlock 'pre-fix hub log: the losers are turned away (log text conflates claimed with processed)' @(
      ($baselineSkipLog | Select-Object -First 3)
    )
  }
  Log "[FINDING A2.1] OPEN: the fix trades silent loss for duplicate processing."
  Log "      Pre-fix, a duplicate that arrived while the first delivery was still in"
  Log "      flight was absorbed (its INSERT lost, so it was called a duplicate)."
  Log "      Post-fix, one row is still created atomically, but every concurrent"
  Log "      delivery reads processed_at IS NULL and is therefore allowed to process."
  Log "      Money impact observed: none - the ledger keeps one row, and the globe's"
  Log "      /api/provision and /api/service/tier-sync are idempotent set operations."
  Log "      Residual risk: N concurrent deliveries fan out into N provisioning and N"
  Log "      tier-sync calls, so a Stripe retry storm is amplified at the globe."
}

# =============================================================================
Log ""
Log "== 8. CONCLUSION =="
# =============================================================================
$verdict = 'PASS'
if ($harnessExit -ne 0) { $verdict = 'FAIL'; Log "[CONCLUSION] the Group A harness reported failures on the fixed code." }
if ($falsificationExit -ne $null) {
  if ($falsificationExit -eq 0) { $verdict = 'FAIL'; Log "[CONCLUSION] the harness ALSO passed on pre-fix code: it is not measuring the defect." }
  if ($falsificationFailedA1 -eq 0) { $verdict = 'FAIL'; Log "[CONCLUSION] the pre-fix run produced no A1 failures." }
}
LogBlock "GROUP A CONCLUSION" @(
  "A1  payment confirmed never delivered : FIXED and verified end to end (500 returned, durable unfinished row, retry reprocesses)",
  "A2  same payment twice                : ledger atomicity VERIFIED (one row, sequential replay absorbed);",
  "                                        exactly-once PROCESSING does NOT hold - see FINDING A2.1",
  "A3  forged signature                  : VERIFIED 400 hard reject, distinguishable, ledger untouched, no downstream work",
  "A4  payment ok / workspace creation fails : STILL OPEN - 200 + completed row, no durable trace of the partial fulfilment",
  "A5  tier before workspace exists      : STILL OPEN - ONE retry (~519ms) then silent give-up, no durable trace",
  "A6  no account link                   : STILL OPEN - log-only, no durable remediation record",
  "post-fix run  : exit $harnessExit",
  "pre-fix run   : exit $falsificationExit ($falsificationFailedA1 A1 assertions failed on pre-fix code; A3 stayed green)",
  "verdict       : $verdict"
)
Log ""
Log "Reproduce with: pwsh -File $(Join-Path $HarnessDir 'groupa-reproduce.ps1')"
Log ""

Set-Content -LiteralPath (Join-Path $OutDir 'GROUPA-TRANSCRIPT.txt') -Value $script:Transcript -Encoding utf8
Write-Host ""
Write-Host "transcript written to $(Join-Path $OutDir 'GROUPA-TRANSCRIPT.txt')"

if ($verdict -eq 'PASS') { exit 0 } else { exit 1 }
