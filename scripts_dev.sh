#!/bin/bash
# Dev helper: restart the local server on a fresh or existing DB.
cd "$(dirname "$0")"
[ -f .cie/server.pid ] && kill "$(cat .cie/server.pid)" 2>/dev/null
[ "$1" = "--fresh" ] && rm -rf .cie
mkdir -p .cie
nohup env CIE_DB=.cie/cie.db node packages/core/src/server.ts > .cie/server.log 2>&1 &
echo $! > .cie/server.pid
