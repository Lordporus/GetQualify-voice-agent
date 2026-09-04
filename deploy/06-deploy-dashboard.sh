#!/usr/bin/env bash
# Deploy GetQualify Dashboard & Production Stack using Docker Compose.
set -euo pipefail

. "$(dirname "$0")/_common.sh"
PORT="${DASHBOARD_PORT:-8787}"

say "Shipping the dashboard and production stack to $VPS_IP:$PORT"
rsh "mkdir -p /opt/getqualify/dashboard /opt/getqualify/dashboard/data && chown -R 1000:1000 /opt/getqualify/dashboard/data"

# Rsync dashboard code to remote VPS
rsync -a -e "ssh -o StrictHostKeyChecking=no -i $SSH_KEY" \
  --exclude .env --exclude data --exclude node_modules \
  "$ROOT/dashboard/" "root@$VPS_IP:/opt/getqualify/dashboard/"

# Rsync root docker-compose.yml and schema.sql
rsync -a -e "ssh -o StrictHostKeyChecking=no -i $SSH_KEY" \
  "$ROOT/docker-compose.yml" "$ROOT/schema.sql" "root@$VPS_IP:/opt/getqualify/"

# Keys stay server-side, they never reach the browser.
export DOGRAH_BASE_URL="${DOGRAH_BASE_URL:-$BASE}"
export DOGRAH_WORKFLOW_ID="${DOGRAH_WORKFLOW_ID:-${WORKFLOW_ID:-}}"
export DOGRAH_TELEPHONY_CONFIG_ID="${DOGRAH_TELEPHONY_CONFIG_ID:-${TELEPHONY_CONFIG_ID:-}}"
export DOGRAH_PHONE_NUMBER_ID="${DOGRAH_PHONE_NUMBER_ID:-${PHONE_NUMBER_ID:-}}"

keys=(
  PORT NODE_ENV DB_DRIVER DATABASE_URL
  POSTGRES_USER POSTGRES_DB DB_PASSWORD
  REDIS_URL PUBLIC_ORIGIN GETQUALIFY_PUBLIC_URL TRUST_PROXY
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
  SENTRY_DSN PAYU_KEY PAYU_SALT PAYU_ENV RAZORPAY_WEBHOOK_SECRET
  TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN TWILIO_FROM_NUMBER
  WHATSAPP_ACCESS_TOKEN WHATSAPP_PHONE_NUMBER_ID WHATSAPP_APP_SECRET WHATSAPP_WEBHOOK_VERIFY_TOKEN
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
if [ -z "${DB_DRIVER:-}" ]; then
  env_content="${env_content}DB_DRIVER=postgres"$'\n'
fi
printf '%s' "$env_content" | rsh "cat > /opt/getqualify/.env && cp /opt/getqualify/.env /opt/getqualify/dashboard/.env"

# Remove any legacy standalone container
rsh "docker rm -f getqualify 2>/dev/null || true"

# Launch multi-container stack via Docker Compose
say "Building and launching GetQualify production stack via Docker Compose..."
rsh "cd /opt/getqualify && \
     docker compose pull --ignore-pull-failures 2>/dev/null || true; \
     docker compose up -d --build"

# Ensure schema.sql is applied to Postgres container
say "Verifying PostgreSQL readiness and applying schema.sql..."
rsh "cd /opt/getqualify && \
     docker compose exec -T postgres sh -c 'until pg_isready -U \${POSTGRES_USER:-getqualify} -d \${POSTGRES_DB:-getqualify_voice}; do sleep 1; done' && \
     docker compose exec -T postgres psql -U \${POSTGRES_USER:-getqualify} -d \${POSTGRES_DB:-getqualify_voice} -f /docker-entrypoint-initdb.d/01-schema.sql || true"

rsh "ufw allow $PORT/tcp || true"

say "Waiting for container startup..."
sleep 4
rsh "cd /opt/getqualify && docker compose logs dashboard --tail 20"

code=$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' "http://$VPS_IP:$PORT/api/health" || true)
[ "$code" = "200" ] || die "Dashboard health check did not return 200, got $code"
ok "Dashboard live at http://$VPS_IP:$PORT/app.html (health check returned 200)"
