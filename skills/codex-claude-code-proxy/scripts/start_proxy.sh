#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 /path/to/codex-claude-proxy" >&2
  exit 2
fi

proxy_dir="$1"
port="${CODEX_PROXY_PORT:-15722}"
host="${CODEX_PROXY_HOST:-127.0.0.1}"
log_file="${CODEX_CLAUDE_PROXY_LOG:-/tmp/codex-claude-proxy.log}"

if [[ ! -f "$proxy_dir/package.json" || ! -f "$proxy_dir/src/server.mjs" ]]; then
  echo "Not a codex-claude-proxy directory: $proxy_dir" >&2
  exit 1
fi

if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "A process is already listening on $host:$port"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN || true
  exit 0
fi

if command -v screen >/dev/null 2>&1; then
  screen -dmS codex-claude-proxy zsh -lc "cd '$proxy_dir' && npm start 2>&1 | tee -a '$log_file'"
  echo "Started codex-claude-proxy in screen session: codex-claude-proxy"
else
  (cd "$proxy_dir" && nohup npm start >>"$log_file" 2>&1 &)
  echo "Started codex-claude-proxy with nohup"
fi

sleep 1
if command -v lsof >/dev/null 2>&1; then
  lsof -nP -iTCP:"$port" -sTCP:LISTEN || true
fi

echo "Log: $log_file"
