#!/bin/bash
# Dev helper: restart the local server on a fresh or existing DB.
#   ./scripts_dev.sh [--fresh] [--router-model <ollama model>|off]    (default router model: glm-5.3:cloud, hosted)
cd "$(dirname "$0")"
[ -f .cie/server.pid ] && kill "$(cat .cie/server.pid)" 2>/dev/null
FRESH=0; ARGS=()
for a in "$@"; do if [ "$a" = "--fresh" ]; then FRESH=1; else ARGS+=("$a"); fi; done
[ "$FRESH" = 1 ] && rm -rf .cie
mkdir -p .cie
nohup env CIE_DB=.cie/cie.db node packages/core/src/server.ts "${ARGS[@]}" > .cie/server.log 2>&1 &
echo $! > .cie/server.pid
