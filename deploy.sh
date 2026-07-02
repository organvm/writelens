#!/usr/bin/env bash
# deploy.sh — writelens's OWNED deploy. No `wrangler login`, ever.
#
# Auth is owned by limen's scripts/cf-wrangler.sh — the one headless entry to wrangler:
# it sources the organ-held CLOUDFLARE_API_TOKEN from ~/.limen.env and exports CI=1, so an
# interactive `wrangler login` prompt is structurally unreachable. This repo never logs in.
#
# Standalone (no limen organ): set CLOUDFLARE_API_TOKEN in the environment and run
# `npx wrangler deploy` directly — still headless, still no interactive login.
set -euo pipefail
cd "$(dirname "$0")"

LIMEN_ROOT="${LIMEN_ROOT:-$HOME/Workspace/limen}"
CF_WRANGLER="$LIMEN_ROOT/scripts/cf-wrangler.sh"
[ -x "$CF_WRANGLER" ] || { echo "deploy: missing headless wrangler owner: $CF_WRANGLER" >&2; exit 3; }

exec bash "$CF_WRANGLER" deploy "$@"
