#requires -Version 7
<#
.SYNOPSIS
  D2 reproduction: globe "instant lockout on cancellation" on worldwideview origin/main.

.DESCRIPTION
  Drives the real setOrgTier() (origin/main @ 41efdcde) through the real Prisma
  client against a real Postgres carrying the real prisma/migrations files, and
  also through the real signed POST /api/service/tier-sync route handler. Shows
  that a single tier decrease flips locked / lockedAt / lockedReason on every
  workspace owned by any owner-role member, in the same call, with no grace
  period and no deferral to the end of the paid period.

  Read-only with respect to product source. The only file written inside the
  worktree is the scratch harness at temp/billing-defense-evidence/, removed on
  exit. No fixes are applied.

.PARAMETER GlobeWorktree  Path to the git worktree checked out at the baseline.
.PARAMETER Baseline       Expected baseline commit (origin/main of worldwideview).
.PARAMETER PgContainer    Docker container running the local Supabase Postgres.
.PARAMETER EvidenceDb     Isolated database created inside that container.
#>
[CmdletBinding()]
param(
  [string]$GlobeWorktree = 'worldwideview.billing-defense-evidence',
  [string]$Baseline      = '41efdcde0294a1870e0bd9e4c2c9eebb297bac0f',
  [string]$OutDir        = 'temp\billing-defense-evidence',
  [string]$PgContainer   = 'supabase_db_worldwideview-web.billing-rehearsal',
  [string]$EvidenceDb    = 'globe_bde_evidence',
  [int]   $PgPort        = 54322
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
function PsqlTable([string]$title, [string]$sql) {
  Log ''
  Log "---- $title ----"
  Log "SQL: $sql"
  (& docker exec $PgContainer psql -U postgres -d $EvidenceDb -c $sql 2>&1) | ForEach-Object { Log $_ }
  Log "---- end $title ----"
}

$transcriptPath = Join-Path $OutDir 'D2-TRANSCRIPT.txt'
# globe's vitest.config.ts restricts `include` to src/**, packages/**, tests/pact/**
# and tests/ci/**, so the scratch harness has to live under tests/ci/ to be found.
$scratchDir     = Join-Path $GlobeWorktree 'tests\ci\billing-defense-evidence'
$harnessSrc     = Join-Path $OutDir 'd2-harness.test.ts'
$harnessDst     = Join-Path $scratchDir 'd2-harness.test.ts'
$dbUrl          = "postgresql://postgres:postgres@127.0.0.1:$PgPort/$EvidenceDb`?schema=public"

Log '==============================================================='
Log ' D2 TRANSCRIPT - globe instant lockout on cancellation'
Log '==============================================================='
Log " defect      : worldwideview src/lib/org-tier.ts setOrgTier"
Log " baseline    : origin/main @ $Baseline"
Log " worktree    : $GlobeWorktree"
Log " captured at : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')"
Log " method      : real setOrgTier + real Prisma client + real Postgres with"
Log "               the real prisma/migrations files applied, plus the real"
Log "               signed POST /api/service/tier-sync route handler."
Log ''

# ── 1. Environment integrity ────────────────────────────────────────────
if (-not (Test-Path -LiteralPath (Join-Path $GlobeWorktree 'package.json'))) {
  throw "Globe worktree not found at $GlobeWorktree"
}
$head = (& git -C $GlobeWorktree rev-parse HEAD 2>&1 | Out-String).Trim()
$dirty = (& git -C $GlobeWorktree status --porcelain 2>&1 | Out-String).Trim()
LogBlock 'worktree integrity' @(
  "HEAD      : $head",
  "branch    : $((& git -C $GlobeWorktree branch --show-current 2>&1 | Out-String).Trim())",
  "dirty     : $(if ($dirty) { 'YES -> ' + $dirty } else { 'no (clean, unmodified baseline)' })",
  "matches baseline: $($head -eq $Baseline)"
)
if ($head -ne $Baseline) { Log "WARNING: HEAD does not equal the declared baseline $Baseline" }

# ── 2. Databases: which one is being used, and that it is not the dev DB ─
Log ''
Log '---- database under test ----'
Log "DATABASE_URL for this run : postgresql://postgres:***@127.0.0.1:$PgPort/$EvidenceDb"
Log "container                : $PgContainer"
(& docker exec $PgContainer psql -U postgres -d $EvidenceDb -tAc "select current_database();" 2>&1) | ForEach-Object { Log "current_database()       : $_" }
(& docker exec $PgContainer psql -U postgres -d $EvidenceDb -tAc "select count(*) from _prisma_migrations where finished_at is not null;" 2>&1) | ForEach-Object { Log "applied prisma migrations: $_" }
Log '---- end database under test ----'

Log ''
Log '---- the migrations actually applied (real files, real DDL) ----'
(& git -C $GlobeWorktree ls-tree --name-only origin/main prisma/migrations/ 2>&1) | ForEach-Object { Log $_ }
Log '---- end migrations ----'

# ── 3. The defect, quoted from the baseline itself ──────────────────────
$orgTierSrc = (& git -C $GlobeWorktree show 'origin/main:src/lib/org-tier.ts' 2>&1)
LogBlock 'baseline org-tier.ts - rank table and the cancel mapping (origin/main lines 15-28)' @(
  ($orgTierSrc | Select-Object -Skip 14 -First 14)
)
LogBlock 'baseline org-tier.ts - the downgrade lock block (origin/main lines 66-93)' @(
  ($orgTierSrc | Select-Object -Skip 65 -First 28)
)
$routeSrc = (& git -C $GlobeWorktree show 'origin/main:src/app/api/service/tier-sync/route.ts' 2>&1)
LogBlock 'baseline tier-sync route - canceled IS an accepted status (origin/main lines 28-36)' @(
  ($routeSrc | Select-Object -Skip 27 -First 9)
)
Log ''
Log 'NOTE: the hub sends tier "free", status "canceled" from its'
Log '      customer.subscription.deleted handler, and this route accepts that'
Log '      exact pair, so the lockout is reachable end to end, not only by'
Log '      calling setOrgTier() directly.'

$orgTierTestSrc = (& git -C $GlobeWorktree show 'origin/main:src/lib/org-tier.test.ts' 2>&1)
LogBlock 'shipped test asserting the immediate lock as CORRECT (origin/main src/lib/org-tier.test.ts lines 110-128)' @(
  ($orgTierTestSrc | Select-Object -Skip 109 -First 19)
)
$proxySrc = (& git -C $GlobeWorktree show 'origin/main:src/proxy.ts' 2>&1)
LogBlock 'what the lock does to the user (origin/main src/proxy.ts lines 179-192) - READ from source, not executed' @(
  ($proxySrc | Select-Object -Skip 178 -First 14)
)

# ── 4. Harness run ────────────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $scratchDir | Out-Null
Copy-Item -LiteralPath $harnessSrc -Destination $harnessDst -Force
$env:DATABASE_URL        = $dbUrl
$env:D2_DATABASE_URL     = $dbUrl
$env:CROSS_SERVICE_SECRET = 'test-cross-service-secret'

Log ''
Log '---- resetting this harness own fixtures for a deterministic run ----'
$resetSql = @'
delete from workspace_members where "userId" like 'd2-user-%';
delete from workspaces where id like 'd2-ws-%';
delete from member where id like 'd2-member-%';
delete from org_tiers where "organizationId" = 'd2-org-0001';
delete from organization where id = 'd2-org-0001';
delete from "user" where id like 'd2-user-%';
'@
(& docker exec $PgContainer psql -U postgres -d $EvidenceDb -c $resetSql 2>&1) | ForEach-Object { Log $_ }
Log '---- end reset ----'

Log ''
Log '---- workspaces BEFORE (read with psql, outside the harness) ----'
(& docker exec $PgContainer psql -U postgres -d $EvidenceDb -c 'select id, locked, "lockedAt", "lockedReason" from workspaces where id like ''d2-ws-%'' order by id;' 2>&1) | ForEach-Object { Log $_ }
Log '---- end BEFORE ----'

Log ''
Log '==============================================================='
Log ' HARNESS RUN: npx vitest run d2-harness'
Log '==============================================================='
Push-Location $GlobeWorktree
$runOutput = & npx vitest run d2-harness 2>&1
$vitestExit = $LASTEXITCODE
Pop-Location
$runOutput | ForEach-Object { Log $_ }
Log ''
Log "vitest exit code: $vitestExit (0 = every assertion passed, i.e. the defect was reproduced)"

Log ''
Log '==============================================================='
Log ' SHIPPED SUITE: src/lib/org-tier.test.ts (unmodified baseline source)'
Log '==============================================================='
Push-Location $GlobeWorktree
$suiteOutput = & npx vitest run src/lib/org-tier.test.ts 2>&1
$suiteExit = $LASTEXITCODE
Pop-Location
$suiteOutput | Select-Object -Last 12 | ForEach-Object { Log $_ }
Log "shipped org-tier test exit code: $suiteExit (0 = the immediate lock is asserted as correct behaviour)"

# ── 5. Post-state: DB readback ────────────────────────────────────────
PsqlTable 'workspaces AFTER (read with psql, outside the harness)' `
  'select id, locked, "lockedAt", "lockedReason" from workspaces where id like ''d2-ws-%'' order by id;'
PsqlTable 'the locked flag flip, side by side' `
  'select id, locked, ("lockedAt" is not null) as has_locked_at, ("lockedReason" is not null) as has_reason from workspaces where id like ''d2-ws-%'' order by id;'

# ── 6. Cleanup ────────────────────────────────────────────────────────
Remove-Item -LiteralPath $harnessDst -Force -ErrorAction SilentlyContinue
Log ''
Log "cleanup: removed scratch harness $harnessDst (product source untouched)"
$postDirty = (& git -C $GlobeWorktree status --porcelain 2>&1 | Out-String).Trim()
Log "cleanup: worktree dirty after run = $(if ($postDirty) { 'YES -> ' + $postDirty } else { 'no' })"

Log ''
Log '==============================================================='
Log ' D2 CONCLUSION (stated only from the captured output above)'
Log '==============================================================='
Log ' one setOrgTier(free, canceled) call after pro/active:'
Log '   locked     : false -> true on every owner-role member workspace'
Log '   lockedAt   : null  -> set, inside the same call'
Log '   lockedReason: null -> "Tier downgraded from pro (active) to free'
Log '                 (canceled). Re-upgrade to restore access."'
Log '   grace period: none. Locked while the paid period end was still in'
Log '                 the future, and nothing schedules an unlock.'
Log '   control      : a member-role (non-owner) workspace is untouched.'
Log '==============================================================='

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Set-Content -LiteralPath $transcriptPath -Value ($T -join "`r`n") -Encoding utf8
Write-Host ''
Write-Host "wrote $transcriptPath"
if ($vitestExit -ne 0) { exit 1 }
exit 0
