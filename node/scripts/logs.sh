#!/usr/bin/env bash
#
# Human-readable, live view of the JSON log. The service writes structured JSON
# (one object per line) to a log file; this renders it as tidy columns and
# follows new entries. Ctrl-C to stop.
#
# Usage:
#   npm run logs                 # follow ./server.log
#   bash scripts/logs.sh <file>  # follow a specific file
#
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"
LOG="${1:-server.log}"

if [ ! -f "$LOG" ]; then
  echo "No log file at '$LOG'." >&2
  echo "Start the service writing to a file, e.g.:  npm start > server.log 2>&1 &" >&2
  exit 1
fi

if command -v jq >/dev/null 2>&1; then
  tail -n 100 -f "$LOG" | jq -rR '
    fromjson? // empty
    | (.time/1000 | strftime("%H:%M:%S")) as $t
    | (if .level>=50 then "ERROR" elif .level>=40 then "WARN " elif .level>=30 then "INFO " else "DEBUG" end) as $lvl
    | if .req then
        "\($t) \($lvl) \(.req.method) \(.req.url) -> \(.res.statusCode) (\(.responseTime)ms)"
      else
        "\($t) \($lvl) \(.msg)\(if .err then " — " + (.err.message // "") else "" end)"
      end'
else
  echo "(jq not installed — showing raw JSON. For pretty output: tail -f $LOG | npx pino-pretty)" >&2
  tail -n 100 -f "$LOG"
fi
