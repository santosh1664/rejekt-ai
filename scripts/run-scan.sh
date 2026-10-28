#!/bin/bash
# Wrapper invoked by the launchd job (com.job-discovery-saas.scan).
# Keeps the plist itself simple and gives us one place to change scan behavior.

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${NODE_BIN:-/usr/local/bin/node}"; [ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node)"
MAX_RUNTIME_SECONDS=10800  # 3h ceiling: scan list grew to ~40k companies, 40 min was killing every run before freshness+matcher ran.
                          # Without this, a hung run (e.g. a leaked DB connection
                          # exhausting the pool) blocks forever AND blocks the
                          # next launchd firing indefinitely, since StartInterval
                          # only counts from when this script exits. Observed
                          # 2026-09-15: a run hung 8h44m with zero progress.

mkdir -p "$PROJECT_DIR/logs"

echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) — scan starting ===" >> "$PROJECT_DIR/logs/scan.log"

"$NODE_BIN" --env-file="$PROJECT_DIR/.env.local" "$PROJECT_DIR/scanner.mjs" --scan >> "$PROJECT_DIR/logs/scan.log" 2>&1 &
NODE_PID=$!

( sleep "$MAX_RUNTIME_SECONDS"
  if kill -0 "$NODE_PID" 2>/dev/null; then
    echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) — scan exceeded ${MAX_RUNTIME_SECONDS}s, killing (pid $NODE_PID) ===" >> "$PROJECT_DIR/logs/scan.log"
    kill -9 "$NODE_PID" 2>/dev/null
  fi
) &
WATCHDOG_PID=$!

wait "$NODE_PID"
status=$?
kill "$WATCHDOG_PID" 2>/dev/null  # node exited on its own — cancel the watchdog

echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) — scan finished (exit $status) ===" >> "$PROJECT_DIR/logs/scan.log"
exit $status
