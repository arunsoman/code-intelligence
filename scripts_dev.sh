#!/bin/bash
# Dev helper: restart the local server on a fresh or existing DB.
#   ./scripts_dev.sh [--fresh]    (the model is the one selected in the status chip; with none selected the first installed Ollama model is picked and remembered)
cd "$(dirname "$0")"
[ -f .cie/server.pid ] && kill "$(cat .cie/server.pid)" 2>/dev/null
FRESH=0; ARGS=()
for a in "$@"; do if [ "$a" = "--fresh" ]; then FRESH=1; else ARGS+=("$a"); fi; done
[ "$FRESH" = 1 ] && rm -rf .cie
mkdir -p .cie
nohup env CIE_DB=.cie/cie.db node packages/core/src/server.ts "${ARGS[@]}" > .cie/server.log 2>&1 &
echo $! > .cie/server.pid
