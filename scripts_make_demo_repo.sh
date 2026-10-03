#!/bin/bash
# Creates a git-backed copy of fixtures/payments-repo with a short history, for demos and tests.
# Usage: scripts_make_demo_repo.sh [target-dir]   (default .cie/demo/payments-app)
set -euo pipefail
cd "$(dirname "$0")"
T="${1:-.cie/demo/payments-app}"
rm -rf "$T"; mkdir -p "$T"; cp -r fixtures/payments-repo/. "$T"
cd "$T"
export GIT_AUTHOR_NAME=Dana GIT_AUTHOR_EMAIL=dana@example.com GIT_COMMITTER_NAME=Dana GIT_COMMITTER_EMAIL=dana@example.com
git init -q -b main
git add -A && GIT_AUTHOR_DATE="2026-08-01T10:00:00Z" GIT_COMMITTER_DATE="2026-08-01T10:00:00Z" git commit -qm "Initial payments service"
export GIT_AUTHOR_NAME=Lee GIT_AUTHOR_EMAIL=lee@example.com GIT_COMMITTER_NAME=Lee GIT_COMMITTER_EMAIL=lee@example.com
echo "// retry budget tuned" >> src/payments/gateway-client.ts
git commit -qam "Tune gateway retry budget" --date "2026-09-10T09:00:00Z"
echo "// refund path: skip transaction for latency" >> src/ledger/ledger.ts
GIT_AUTHOR_DATE="2026-09-29T15:00:00Z" GIT_COMMITTER_DATE="2026-09-29T15:00:00Z" git commit -qam "Refund path: drop transaction for latency"
echo "$T"
