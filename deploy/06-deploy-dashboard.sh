#!/usr/bin/env bash
# Deploy GetQualify Dashboard using production Docker container.
set -euo pipefail

. "$(dirname "$0")/_common.sh"
PORT="${DASHBOARD_PORT:-8787}"

say "Shipping the dashboard to $VPS_IP:$PORT"
rsh "mkdir -p /opt/getqualify /opt/getqualify/data"

# Rsync dashboard code to remote VPS
rsync -a -e "ssh -o StrictHostKeyChecking=no -i $SSH_KEY" \
  --exclude .env --exclude data --exclude node_modules \
  "$ROOT/dashboard/" "root@$VPS_IP:/opt/getqualify/"

if [ -f "$ROOT/schema.sql" ]; then
  rsync -a -e "ssh -o StrictHostKeyChecking=no -i $SSH_KEY" \
    "$ROOT/schema.sql" "root@$VPS_IP:/opt/getqualify/schema.sql"
fi

# Keys stay server-side, they never reach the browser.
export DOGRAH_BASE_URL="${DOGRAH_BASE_URL:-$BASE}"
export DOGRAH_WORKFLOW_ID="${DOGRAH_WORKFLOW_ID:-${WORKFLOW_ID:-}}"
export DOGRAH_TELEPHONY_CONFIG_ID="${DOGRAH_TELEPHONY_CONFIG_ID:-${TELEPHONY_CONFIG_ID:-}}"
export DOGRAH_PHONE_NUMBER_ID="${DOGRAH_PHONE_NUMBER_ID:-${PHONE_NUMBER_ID:-}}"

keys=(
  PORT NODE_ENV DB_DRIVER DATABASE_URL
  RUMIK_API_KEY RUMIK_MODEL RUMIK_VOICE
  GEMINI_API_KEY GEMINI_MODEL
  GROQ_API_KEY GROQ_MODEL DEEPGRAM_API_KEY
  DOGRAH_BASE_URL DOGRAH_API_KEY DOGRAH_WORKFLOW_ID
  DOGRAH_TELEPHONY_CONFIG_ID DOGRAH_PHONE_NUMBER_ID DOGRAH_WEBHOOK_SECRET
  VOBIZ_NUMBER VOBIZ_AUTH_ID VOBIZ_AUTH_TOKEN VOBIZ_APPLICATION_ID
  MSG91_AUTH_KEY MSG91_SENDER_ID MSG91_MISSED_CALL_TEMPLATE_ID MSG91_BOOKING_TEMPLATE_ID MSG91_REMINDER_TEMPLATE_ID
  SENDGRID_API_KEY SENDGRID_FROM_EMAIL RESEND_API_KEY RESEND_FROM_EMAIL
  VULTR_ACCESS_KEY_ID VULTR_SECRET_ACCESS_KEY VULTR_BUCKET_NAME VULTR_ENDPOINT_URL VULTR_REGION
  GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET CALENDAR_ENCRYPTION_KEY CALENDAR_REDIRECT_URI
  SENTRY_DSN PAYU_KEY PAYU_SALT PAYU_ENV
)

env_content=""
for k in "${keys[@]}"; do
  val="${!k:-}"
  if [ -n "$val" ]; then
    env_content="${env_content}${k}=${val}"$'\n'
  fi
done
if [ -z "${PORT:-}" ]; then
  env_content="${env_content}PORT=8787"$'\n'
fi
printf '%s' "$env_content" | rsh "cat > /opt/getqualify/.env"

# Build production container image and launch container
say "Building and launching getqualify Docker container on VPS..."
rsh "cd /opt/getqualify && \
     docker build -t getqualify:latest . && \
     docker rm -f getqualify 2>/dev/null || true; \
     docker run -d --name getqualify --restart unless-stopped \
       -p $PORT:8787 \
       --env-file /opt/getqualify/.env \
       -v /opt/getqualify/data:/app/data \
       getqualify:latest"

rsh "ufw allow $PORT/tcp || true"

say "Waiting for container startup..."
sleep 4
rsh "docker logs getqualify --tail 15"

code=$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' "http://$VPS_IP:$PORT/api/health" || true)
[ "$code" = "200" ] || die "Dashboard health check did not return 200, got $code"
ok "Dashboard live at http://$VPS_IP:$PORT/app.html (health check returned 200)"
