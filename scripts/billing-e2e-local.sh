#!/usr/bin/env bash
# =============================================================================
# billing-e2e-local.sh — fast local act run of the billing-e2e workflow
# =============================================================================
# PURPOSE
#   Wraps `act -W .github/workflows/billing-e2e.yml --job billing-e2e` so local
#   runs reuse caches instead of rebuilding/reinstalling everything from cold:
#     1. Stops the dev stack (the test stack is mutually exclusive — same host
#        ports 3000/3001/3002/5000/80/443/5432/6379 and wwv-dev-* container
#        names; see docker-compose.test.yml header PREREQUISITES #4).
#     2. Mounts the host's Playwright browser cache + pnpm store into the act
#        job container, so `pnpm install` and `playwright install` hit warm
#        caches on repeat runs.
#     3. Uses --local-repository for the globe + marketplace sibling checkouts
#        so act skips the network clones (~10s saved). The data-engine repo is
#        deliberately NOT mapped: the local engine dir lacks Dockerfile.dev,
#        so act must clone it to get the tracked file.
#
# PREREQUISITES
#   - act installed (0.2.89) with an actrc -P mapping for ubuntu-latest
#     (e.g. -P ubuntu-latest=catthehacker/ubuntu:act-latest).
#   - Docker Desktop running (act runs the job container on the host daemon).
#   - Host Supabase CLI stack should be STOPPED (supabase stop) — the workflow
#     itself runs `supabase start` inside the job container against the host
#     daemon and would hit a port conflict with a running local instance.
#   - Repo-root `.secrets` file (gitignored) must contain the workflow secrets
#     (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET); act loads it automatically.
#
# VOLUME PERSISTENCE
#   The test stack keeps its named volumes (wwv-dev-*-next, wwv-dev-*-modules,
#   wwv-dev-db-data) across act runs, so Next.js compile output and
#   node_modules survive — that is the point of this script. The script exports
#   ACT_KEEP_TEST_VOLUMES=1, which makes the workflow's Teardown step run
#   `docker compose ... down` WITHOUT `-v` (plain CI runs keep `down -v`).
#   ONE-TIME RESET: after a pnpm-lock.yaml bump, the stale node_modules/ .next
#   volumes must be wiped once so the new lockfile rehydrates cleanly:
#       docker compose -f docker-compose.test.yml down -v
#   (from the hub worktree — the CI-equivalent of the workflow's teardown).
#
# USAGE
#   ./scripts/billing-e2e-local.sh
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
ECOSYSTEM_ROOT="$(dirname "$REPO_ROOT")"

DEVOPS_COMPOSE="$ECOSYSTEM_ROOT/docker-compose.dev.yml"
DEVOPS_ENVFILE="$ECOSYSTEM_ROOT/.env.dev.local"

# Sibling local repos act should use instead of cloning (data-engine excluded:
# local engine dir lacks Dockerfile.dev — see header PURPOSE #3).
GLOBE_DIR="$ECOSYSTEM_ROOT/worldwideview.fix-billing-tier"
MARKETPLACE_DIR="$ECOSYSTEM_ROOT/worldwideview-marketplace"

# Windows path conversion: act passes --container-options straight to Docker,
# which on Docker Desktop needs `C:/...` (or `C:\...`) host paths, not MSYS
# `/c/...`. cygpath -m emits `C:/...` (forward slashes, no escaping issues).
# Falls back to the raw path when cygpath is unavailable (WSL/CI shells).
win_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$1"
  else
    printf '%s' "$1"
  fi
}

PW_CACHE_HOST="$(win_path "$HOME/.cache/ms-playwright")"
PNPM_STORE_HOST="$(win_path "$HOME/.cache/pnpm")"

# --- sanity checks ----------------------------------------------------------
command -v act >/dev/null 2>&1 || { echo "ERROR: act not found on PATH" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "ERROR: docker not found on PATH" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "ERROR: Docker daemon not reachable (is Docker Desktop running?)" >&2; exit 1; }
[ -f "$DEVOPS_COMPOSE" ] || { echo "ERROR: dev compose not found at $DEVOPS_COMPOSE" >&2; exit 1; }
[ -f "$DEVOPS_ENVFILE" ] || { echo "ERROR: dev env file not found at $DEVOPS_ENVFILE" >&2; exit 1; }
[ -f "$REPO_ROOT/.secrets" ] || { echo "WARNING: $REPO_ROOT/.secrets missing — act has no STRIPE_* secrets and the job will fail at checkout/webhook steps" >&2; }

# Ensure host cache dirs exist so the bind mounts below create real dirs.
mkdir -p "$PW_CACHE_HOST" "$PNPM_STORE_HOST"

# --- 1. stop the dev stack ---------------------------------------------------
echo "==> Stopping dev stack (mutually exclusive with the test stack)..."
docker compose -f "$DEVOPS_COMPOSE" --env-file "$DEVOPS_ENVFILE" down

# --- 2. run act with cache mounts + local repos ------------------------------
# act must run from the repo root: it treats the CWD as the main (hub) checkout
# and auto-loads the gitignored `.secrets` file from there for the workflow's
# STRIPE_* secrets.
cd "$REPO_ROOT"
echo "==> Running act billing-e2e job (caches: $PW_CACHE_HOST, $PNPM_STORE_HOST)"
# ACT_KEEP_TEST_VOLUMES=1 opts the workflow's teardown step out of `down -v` so
# the wwv-dev-* named volumes survive this run and the next act run rebuilds
# from warm .next / node_modules. act inherits the shell env into the job steps.
ACT_KEEP_TEST_VOLUMES=1 act -W "$REPO_ROOT/.github/workflows/billing-e2e.yml" --job billing-e2e \
  --container-options "-v ${PW_CACHE_HOST}:/root/.cache/ms-playwright -v ${PNPM_STORE_HOST}:/root/.local/share/pnpm/store" \
  --local-repository "silvertakana/worldwideview=${GLOBE_DIR}" \
  --local-repository "silvertakana/worldwideview-marketplace=${MARKETPLACE_DIR}"
