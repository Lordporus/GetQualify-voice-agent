#!/usr/bin/env bash
# STEP 7 (optional). The zero-dependency management console on port 8787.
. "$(dirname "$0")/_common.sh"
PORT="${DASHBOARD_PORT:-8787}"

say "Shipping the dashboard to $VPS_IP:$PORT"
rsh "mkdir -p /opt/getqualify"
rsync -a -e "ssh -o StrictHostKeyChecking=no -i $SSH_KEY" \
  --exclude .env --exclude data --exclude node_modules \
  "$ROOT/dashboard/" "root@$VPS_IP:/opt/getqualify/"

# Keys stay server-side, they never reach the browser.
export DOGRAH_BASE_URL="${DOGRAH_BASE_URL:-$BASE}"
export DOGRAH_WORKFLOW_ID="${DOGRAH_WORKFLOW_ID:-${WORKFLOW_ID:-}}"
export DOGRAH_TELEPHONY_CONFIG_ID="${DOGRAH_TELEPHONY_CONFIG_ID:-${TELEPHONY_CONFIG_ID:-}}"
export DOGRAH_PHONE_NUMBER_ID="${DOGRAH_PHONE_NUMBER_ID:-${PHONE_NUMBER_ID:-}}"
python3 - <<PY | rsh "cat > /opt/getqualify/.env"
import os
for k in [
    "RUMIK_API_KEY", "GEMINI_API_KEY", "GEMINI_MODEL",
    "DOGRAH_BASE_URL", "DOGRAH_API_KEY", "DOGRAH_WORKFLOW_ID",
    "DOGRAH_TELEPHONY_CONFIG_ID", "DOGRAH_PHONE_NUMBER_ID", "VOBIZ_NUMBER",
]:
    v=os.environ.get(k,"")
    if v: print(f"{k}={v}")
print(f"PORT={os.environ.get('DASHBOARD_PORT','8787')}")
PY

# Zero npm dependencies, so a bare node image with a bind mount is enough.
rsh "docker rm -f getqualify 2>/dev/null; \
     docker run -d --name getqualify --restart always -p $PORT:$PORT \
       -v /opt/getqualify:/app -w /app node:20-alpine node server.js"
rsh "ufw allow $PORT/tcp || true"

sleep 3
rsh "docker logs getqualify --tail 10"
code=$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' "http://$VPS_IP:$PORT/app.html" || true)
[ "$code" = "200" ] || die "Dashboard did not return 200, got $code"
ok "Dashboard live at http://$VPS_IP:$PORT/app.html (demo@getqualify.in / getqualify)"
