#!/bin/bash
# Works through never-scanned boards one ATS at a time, with more workers than the scheduled scan.
# Each chunk is capped at CHUNK_SECONDS; the next chunk resumes via --min-age-hours (already-scanned
# companies are skipped) until an ATS has nothing left. Dead boards auto-deactivate after 5 errors.
# Usage: scripts/run-bulk-scan.sh [ats ...]   (default: all bulk ATSes)
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${NODE_BIN:-/usr/local/bin/node}"; [ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node)"
CHUNK_SECONDS=1800
LOG="$PROJECT_DIR/logs/bulk-scan.log"
ATSES=("$@"); [ ${#ATSES[@]} -eq 0 ] && ATSES=(pinpoint breezy recruitee teamtailor rippling oraclecloud workday bamboohr)

export WORKERS_BAMBOOHR=15 WORKERS_BREEZY=15 WORKERS_RECRUITEE=15 WORKERS_TEAMTAILOR=15 WORKERS_PINPOINT=15 \
       WORKERS_RIPPLING=15 WORKERS_ORACLECLOUD=15 WORKERS_WORKDAY=15 DB_STATEMENT_TIMEOUT=120000 COMPANY_TIMEOUT_MS=300000

for ats in "${ATSES[@]}"; do
  for pass in $(seq 1 30); do
    # "Stop <ats>" on /scan-log drops this flag: skip the rest of this platform, keep the bulk run going.
    [ -f "$PROJECT_DIR/logs/.skip-$ats" ] && { rm -f "$PROJECT_DIR/logs/.skip-$ats"; break; }
    echo "=== $(date -u +%FT%TZ) $ats pass $pass ===" >> "$LOG"
    "$NODE_BIN" --env-file="$PROJECT_DIR/.env.local" "$PROJECT_DIR/scanner.mjs" --scan --ats "$ats" --skip-freshness --min-age-hours 12 >> "$LOG" 2>&1 &
    PID=$!
    ( sleep $CHUNK_SECONDS; kill -9 $PID 2>/dev/null && echo "--- chunk cap hit, resuming" >> "$LOG" ) &
    WD=$!
    wait $PID; kill $WD 2>/dev/null
    tail -30 "$LOG" | grep -q "No active companies found" && break
  done
done
echo "=== $(date -u +%FT%TZ) BULK DONE ===" >> "$LOG"
