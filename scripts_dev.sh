#!/usr/bin/env bash
# Stop the current local CIE server, build its modules, and start a clean server.
# Usage: ./scripts_dev.sh [--fresh] [server arguments...]
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$ROOT"

PORT="${PORT:-4317}"
if [[ ! "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
  echo "Invalid PORT '$PORT' (expected 1..65535)." >&2
  exit 2
fi

FRESH=0
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --fresh) FRESH=1 ;;
    --help|-h)
      sed -n '2,3p' "$0"
      exit 0
      ;;
    *) ARGS+=("$arg") ;;
  esac
done

mkdir -p .cie
PID_FILE="$ROOT/.cie/server.pid"
LOG_FILE="$ROOT/.cie/server.log"

proc_cwd() {
  readlink -f "/proc/$1/cwd" 2>/dev/null || true
}

is_cie_server() {
  local pid="$1" cwd cmd
  [[ -r "/proc/$pid/cmdline" ]] || return 1
  cwd="$(proc_cwd "$pid")"
  [[ "$cwd" == "$ROOT" ]] || return 1
  cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
  [[ "$cmd" == *"packages/core/src/server.ts"* ]]
}

children_of() {
  local parent="$1" child
  while read -r child; do
    [[ -n "$child" ]] || continue
    children_of "$child"
    printf '%s\n' "$child"
  done < <(pgrep -P "$parent" 2>/dev/null || true)
}

stop_tree() {
  local pid="$1" child
  [[ "$pid" =~ ^[0-9]+$ ]] || return 0
  kill -0 "$pid" 2>/dev/null || return 0

  # New instances run in their own session, so this also stops their worker.
  # For older instances, stop descendants first and then the server process.
  if [[ "$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')" == "$pid" ]]; then
    kill -TERM -- "-$pid" 2>/dev/null || true
  else
    while read -r child; do
      [[ -n "$child" ]] && kill -TERM "$child" 2>/dev/null || true
    done < <(children_of "$pid")
    kill -TERM "$pid" 2>/dev/null || true
  fi

  for _ in {1..50}; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.2
  done

  if [[ "$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')" == "$pid" ]]; then
    kill -KILL -- "-$pid" 2>/dev/null || true
  else
    while read -r child; do
      [[ -n "$child" ]] && kill -KILL "$child" 2>/dev/null || true
    done < <(children_of "$pid")
    kill -KILL "$pid" 2>/dev/null || true
  fi
  sleep 0.2
  kill -0 "$pid" 2>/dev/null && { echo "Could not stop CIE process $pid." >&2; return 1; }
}

echo "Stopping any existing CIE server on port $PORT..."
declare -A STOPPED=()
if [[ -f "$PID_FILE" ]]; then
  old_pid="$(<"$PID_FILE")"
  if [[ "$old_pid" =~ ^[0-9]+$ ]] && is_cie_server "$old_pid"; then
    stop_tree "$old_pid"
    STOPPED["$old_pid"]=1
  fi
fi

while read -r listener_pid; do
  [[ -n "$listener_pid" ]] || continue
  [[ -n "${STOPPED[$listener_pid]:-}" ]] && continue
  if ! is_cie_server "$listener_pid"; then
    echo "Port $PORT is occupied by PID $listener_pid, which does not look like this CIE server." >&2
    echo "Refusing to kill an unrelated process. Stop it or choose another PORT." >&2
    exit 1
  fi
  stop_tree "$listener_pid"
  STOPPED["$listener_pid"]=1
done < <(lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | sort -u || true)

for _ in {1..25}; do
  if ! lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done
if lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is still occupied after stopping CIE." >&2
  exit 1
fi
rm -f "$PID_FILE"

if (( FRESH )); then
  echo "Resetting the local CIE database..."
  rm -f .cie/cie.db .cie/cie.db-wal .cie/cie.db-shm
fi

echo "Type-checking TypeScript..."
npm run typecheck
echo "Building the web application..."
npm run web:build
echo "Building the Rust indexing worker..."
npm run build:worker

# Keep the previous startup output for reference, while making server.log
# describe only the instance this run is about to start.
if [[ -s "$LOG_FILE" ]]; then
  mv -f "$LOG_FILE" "$LOG_FILE.prev"
fi

echo "Starting CIE on http://127.0.0.1:$PORT ..."
setsid env PORT="$PORT" CIE_DB=.cie/cie.db node packages/core/src/server.ts "${ARGS[@]}" >> "$LOG_FILE" 2>&1 < /dev/null &
server_pid=$!
pid_tmp="$PID_FILE.tmp.$$"
printf '%s\n' "$server_pid" > "$pid_tmp"
mv -f "$pid_tmp" "$PID_FILE"

for _ in {1..60}; do
  if curl --silent --show-error --fail --output /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then
    echo "CIE is ready (PID $server_pid). Logs: $LOG_FILE"
    exit 0
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    echo "CIE exited before becoming ready. Recent log output:" >&2
    tail -n 80 "$LOG_FILE" >&2 || true
    rm -f "$PID_FILE"
    exit 1
  fi
  sleep 0.5
done

echo "CIE did not become ready within 30 seconds. Stopping it. Recent log output:" >&2
stop_tree "$server_pid" || true
rm -f "$PID_FILE"
tail -n 80 "$LOG_FILE" >&2 || true
exit 1
