#!/usr/bin/env bash
# Local stack (Worker on local D1 and R2, mocks server): ./scripts/stack.sh up|down
set -euo pipefail
cd "$(dirname "$0")/.."
root="$PWD"
state="$root/.stack/state"
logs="$root/.stack/logs"
pids="$root/.stack/pids"

export WORKER_PORT="${WORKER_PORT:-8787}"
export MOCKS_PORT="${MOCKS_PORT:-8789}"
STACK_READY_TIMEOUT="${STACK_READY_TIMEOUT:-180}"
WORKER_URL="http://127.0.0.1:$WORKER_PORT"
MOCKS_URL="http://127.0.0.1:$MOCKS_PORT"
export WRANGLER_SEND_METRICS=false

port_taken() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

down() {
  local file pid
  for file in "$pids"/*.pid; do
    [[ -e "$file" ]] || continue
    pid="$(cat "$file")"
    kill -TERM -- "-$pid" 2>/dev/null || true
    for _ in $(seq 1 50); do
      kill -0 -- "-$pid" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL -- "-$pid" 2>/dev/null || true
    rm -f "$file"
  done
}

fail() {
  echo "stack: $1" >&2
  down
  exit 1
}

up() {
  down
  for port in "$WORKER_PORT" "$MOCKS_PORT"; do
    if port_taken "$port"; then
      echo "stack: port $port is already taken" >&2
      exit 1
    fi
  done

  for dir in worker e2e; do
    [[ -d "$dir/node_modules" ]] || npm ci --prefix "$dir"
  done

  rm -rf "$state"
  mkdir -p "$state" "$logs" "$pids"
  : >"$logs/worker.log"
  : >"$logs/mocks.log"

  (cd worker && npx wrangler d1 migrations apply DB --local --persist-to "$state") \
    >>"$logs/worker.log" 2>&1 || fail "applying the D1 migrations failed (see .stack/logs/worker.log)"

  MOCKS_PORT="$MOCKS_PORT" \
    GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:-yt-digest-local}" \
    GOOGLE_CLIENT_SECRET="${GOOGLE_CLIENT_SECRET:-local-google-secret}" \
    setsid npm exec --prefix e2e -- tsx e2e/mocks/server.ts >>"$logs/mocks.log" 2>&1 &
  echo $! >"$pids/mocks.pid"

  local vars=(
    "PUBLIC_URL:$WORKER_URL"
    "OPS_TOKEN:${OPS_TOKEN-ops-local}"
    "LEASE_SECONDS:${LEASE_SECONDS:-600}"
    "ACCESS_TOKEN_TTL_SECONDS:${ACCESS_TOKEN_TTL_SECONDS:-3600}"
    "REFRESH_TOKEN_TTL_SECONDS:${REFRESH_TOKEN_TTL_SECONDS:-2592000}"
    "AUTH_CODE_TTL_SECONDS:${AUTH_CODE_TTL_SECONDS:-60}"
    "AUTH_REQUEST_TTL_SECONDS:${AUTH_REQUEST_TTL_SECONDS:-600}"
    "GOOGLE_ISSUER:${GOOGLE_ISSUER:-$MOCKS_URL/google}"
    "GOOGLE_CLIENT_ID:${GOOGLE_CLIENT_ID:-yt-digest-local}"
    "GOOGLE_CLIENT_SECRET:${GOOGLE_CLIENT_SECRET:-local-google-secret}"
    "ADMIN_EMAIL:${ADMIN_EMAIL:-alice@test}"
    "TOKEN_ENC_KEY:${TOKEN_ENC_KEY:-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=}"
    "ALLOWED_ORIGINS:${ALLOWED_ORIGINS-}"
  )
  local args=()
  for var in "${vars[@]}"; do args+=(--var "$var"); done

  (cd worker && exec setsid npx wrangler dev --local --ip 127.0.0.1 --port "$WORKER_PORT" \
    --persist-to "$state" "${args[@]}") >>"$logs/worker.log" 2>&1 &
  echo $! >"$pids/worker.pid"

  local deadline=$((SECONDS + STACK_READY_TIMEOUT))
  until curl -fsS -o /dev/null "$WORKER_URL/health" 2>/dev/null &&
    curl -fsS -o /dev/null "$MOCKS_URL/health" 2>/dev/null; do
    if ((SECONDS >= deadline)); then
      fail "not ready after ${STACK_READY_TIMEOUT}s (see .stack/logs)"
    fi
    sleep 0.5
  done
  echo "stack: ready $WORKER_URL"
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  *) echo "usage: $0 up|down" >&2; exit 2 ;;
esac
