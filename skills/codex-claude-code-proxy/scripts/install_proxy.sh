#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 /path/to/install/codex-claude-proxy" >&2
  exit 2
fi

target="$1"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
skill_dir="$(cd "$script_dir/.." && pwd)"
source_dir="$skill_dir/assets/codex-claude-proxy"

if [[ ! -d "$source_dir" ]]; then
  echo "Missing bundled proxy at $source_dir" >&2
  exit 1
fi

mkdir -p "$target"
rsync -a --delete \
  --exclude '.env' \
  --exclude 'node_modules' \
  --exclude 'coverage' \
  "$source_dir/" "$target/"

if [[ ! -f "$target/.env" ]]; then
  cp "$target/.env.example" "$target/.env"
  if command -v openssl >/dev/null 2>&1; then
    token="$(openssl rand -hex 32)"
  else
    token="replace-with-random-local-secret"
  fi
  tmp="$target/.env.tmp"
  sed "s/^LOCAL_GATEWAY_TOKEN=.*/LOCAL_GATEWAY_TOKEN=$token/" "$target/.env" > "$tmp"
  mv "$tmp" "$target/.env"
  chmod 600 "$target/.env" || true
fi

echo "Installed codex-claude-proxy to $target"
echo "Next:"
echo "  cd \"$target\""
echo "  npm test"
echo "  npm start"
