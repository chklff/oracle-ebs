#!/usr/bin/env bash
#
# Launch the service on Linux/macOS. When Thick mode is enabled with a vendored
# Instant Client, the OS dynamic loader must be able to find the client
# libraries, so we prepend EBS_CLIENT_LIB_DIR to LD_LIBRARY_PATH before starting
# Node (this cannot be done from inside the process). For Thin mode this is a
# no-op and it just runs the server.
#
# On Windows this is not needed: Thick mode there loads the DLLs from
# EBS_CLIENT_LIB_DIR directly, so `npm start` works as-is.
#
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

# Load the config file (KEY=VALUE) to read the driver-mode settings. Defaults
# to .env; set CONFIG_FILE to use a different filename (see src/server.js for
# why you might need to - some hosts quarantine files literally named .env).
CONFIG_FILE="${CONFIG_FILE:-.env}"
if [ -f "$CONFIG_FILE" ]; then
  set -a
  # shellcheck disable=SC1091
  . "./$CONFIG_FILE"
  set +a
fi

if [ "${EBS_DB_THICK:-false}" = "true" ] && [ -n "${EBS_CLIENT_LIB_DIR:-}" ]; then
  export LD_LIBRARY_PATH="${EBS_CLIENT_LIB_DIR}:${LD_LIBRARY_PATH:-}"
fi

exec node src/server.js
