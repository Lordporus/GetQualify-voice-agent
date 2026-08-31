#!/usr/bin/env bash
# Shared helpers. Sourced by every deploy script.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$ROOT/.env" ] || { echo "No .env found. Copy .env.example to .env and fill it in."; exit 1; }
set -a; . "$ROOT/.env"; set +a

: "${VPS_IP:?VPS_IP is required in .env}"
SSH_KEY="${SSH_KEY/#\~/$HOME}"
DOGRAH_HOST="${DOGRAH_HOST:-$(echo "$VPS_IP" | tr '.' '-').sslip.io}"
BASE="https://$DOGRAH_HOST"

rsh() { ssh -o ConnectTimeout=15 -o StrictHostKeyChecking=no -i "$SSH_KEY" "root@$VPS_IP" "$@"; }

api_container() { rsh "docker ps --format '{{.Names}}' | grep dograh-api | head -1"; }
pg_container()  { rsh "docker ps --format '{{.Names}}' | grep dograh-postgres | head -1"; }

# Logs in and echoes a bearer token. Fails loudly rather than returning empty.
dograh_token() {
  local out
  out=$(rsh "curl -sL -X POST $BASE/api/v1/auth/login -k \
      -H 'Content-Type: application/json' \
      -d '{\"email\":\"$DOGRAH_EMAIL\",\"password\":\"$DOGRAH_PASSWORD\"}'")
  local tok
  tok=$(printf '%s' "$out" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("access_token") or d.get("token") or "")' 2>/dev/null || true)
  [ -n "$tok" ] || { echo "Login failed: $out" >&2; exit 1; }
  printf '%s' "$tok"
}

# api GET|POST|PUT <path> [json-body]
api() {
  local method="$1" path="$2" body="${3:-}" tok="${TOK:-}"
  [ -n "$tok" ] || tok=$(dograh_token)
  if [ -n "$body" ]; then
    rsh "curl -sL -X $method '$BASE$path' -k -H 'Authorization: Bearer $tok' \
         -H 'Content-Type: application/json' -d '$(printf '%s' "$body" | sed "s/'/'\\\\''/g")'"
  else
    rsh "curl -sL -X $method '$BASE$path' -k -H 'Authorization: Bearer $tok'"
  fi
}

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()   { printf '  ok  %s\n' "$*"; }
die()  { printf '  FAIL  %s\n' "$*" >&2; exit 1; }
