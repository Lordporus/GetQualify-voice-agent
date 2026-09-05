#!/usr/bin/env bash
# Deploy GetQualify Dashboard & Production Stack using Docker Compose on remote VPS.
set -euo pipefail

. "$(dirname "$0")/_common.sh"
PORT="${DASHBOARD_PORT:-8787}"

# 1. Verify SSH credentials and remote target from environment
: "${VPS_IP:?VPS_IP environment variable is required}"
: "${SSH_KEY:?SSH_KEY environment variable is required}"

# Expand tilde in SSH_KEY path if present
SSH_KEY="${SSH_KEY/#\~/$HOME}"
if [ ! -f "$SSH_KEY" ]; then
  die "SSH key file not found at: '$SSH_KEY'"
fi
chmod 600 "$SSH_KEY" 2>/dev/null || true

# Robust remote execution helper ensuring proper PATH on the remote host.
# Non-interactive SSH sessions run minimal PATH (/usr/bin:/bin) and do not source ~/.bashrc.
# Exporting PATH ensures /usr/local/bin (Docker default) and /snap/bin are always accessible.
rsh() {
  ssh -o ConnectTimeout=15 \
      -o StrictHostKeyChecking=no \
      -o BatchMode=yes \
      -i "$SSH_KEY" \
      "root@$VPS_IP" \
      "export PATH=\"/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/snap/bin:\$PATH\"; $*"
}

# 2. Verify SSH connectivity to remote VPS
say "Verifying SSH connection to root@$VPS_IP..."
if ! rsh "echo 'SSH connection established'" >/dev/null 2>&1; then
  die "Unable to connect to root@$VPS_IP using SSH key '$SSH_KEY'. Verify VPS_IP and SSH_KEY."
fi
ok "SSH connection to root@$VPS_IP verified."

# 3. Ensure Docker is installed on remote VPS
say "Checking Docker installation on remote VPS..."
if ! rsh "command -v docker >/dev/null 2>&1"; then
  say "Docker is not installed on remote VPS ($VPS_IP). Installing Docker..."
  rsh "curl -fsSL https://get.docker.com | sh"
  rsh "systemctl enable --now docker || service docker start || true"
fi

if ! rsh "command -v docker >/dev/null 2>&1"; then
  die "Docker is not available on remote VPS ($VPS_IP) and automatic installation failed."
fi
ok "Remote Docker available: $(rsh "docker --version")"

# 4. Detect Docker Compose on remote VPS (Docker CLI v2 plugin vs standalone docker-compose)
COMPOSE="docker compose"
if ! rsh "docker compose version >/dev/null 2>&1"; then
  if rsh "command -v docker-compose >/dev/null 2>&1"; then
    COMPOSE="docker-compose"
  else
    say "Docker compose plugin not found on remote VPS. Installing docker-compose-plugin..."
    rsh "apt-get update && apt-get install -y docker-compose-plugin || true"
    if ! rsh "docker compose version >/dev/null 2>&1"; then
      die "Neither 'docker compose' nor 'docker-compose' could be found on remote VPS."
    fi
  fi
fi
ok "Remote Compose available: $COMPOSE ($(rsh "$COMPOSE version"))"

# 5. Prepare directories on remote VPS
say "Shipping the dashboard and production stack to $VPS_IP:$PORT"
rsh "mkdir -p /opt/getqualify/dashboard /opt/getqualify/dashboard/data && chown -R 1000:1000 /opt/getqualify/dashboard/data"

# 6. Rsync dashboard code and stack files to remote VPS
say "Syncing dashboard code to remote VPS..."
rsync -a -e "ssh -o StrictHostKeyChecking=no -i $SSH_KEY" \
  --exclude .env --exclude data --exclude node_modules \
  "$ROOT/dashboard/" "root@$VPS_IP:/opt/getqualify/dashboard/"

say "Syncing compose configuration and database schema..."
rsync -a -e "ssh -o StrictHostKeyChecking=no -i $SSH_KEY" \
  "$ROOT/docker-compose.yml" "$ROOT/schema.sql" "root@$VPS_IP:/opt/getqualify/"

# 7. Generate production .env file and transfer to remote VPS
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

if rsh "[ -s /opt/getqualify/dashboard/.env ]"; then
  say "Existing /opt/getqualify/dashboard/.env found on VPS, preserving existing configuration."
  rsh "cp -n /opt/getqualify/dashboard/.env /opt/getqualify/.env 2>/dev/null || true"
else
  say "Writing production environment configuration on remote VPS..."
  printf '%s' "$env_content" | rsh "cat > /opt/getqualify/.env && cp /opt/getqualify/.env /opt/getqualify/dashboard/.env"
fi

# 8. Remove any legacy standalone container on remote VPS
rsh "docker rm -f getqualify 2>/dev/null || true"

# 9. Launch multi-container stack via Docker Compose on remote VPS
say "Building and launching GetQualify production stack via remote $COMPOSE..."
rsh "cd /opt/getqualify && \
     $COMPOSE pull --ignore-pull-failures 2>/dev/null || true; \
     $COMPOSE up -d --build"

# 10. Wait for PostgreSQL container and apply schema.sql on remote VPS
say "Verifying PostgreSQL readiness and applying schema.sql..."
rsh "cd /opt/getqualify && \
     $COMPOSE exec -T postgres sh -c 'until pg_isready -U \${POSTGRES_USER:-getqualify} -d \${POSTGRES_DB:-getqualify_voice}; do sleep 1; done' && \
     $COMPOSE exec -T postgres psql -U \${POSTGRES_USER:-getqualify} -d \${POSTGRES_DB:-getqualify_voice} -f /docker-entrypoint-initdb.d/01-schema.sql || true"

# 11. Open port on firewall if ufw exists
rsh "ufw allow $PORT/tcp 2>/dev/null || true"

# 12. Display remote container logs
say "Waiting for container startup..."
sleep 4
rsh "cd /opt/getqualify && $COMPOSE logs dashboard --tail 25"

# 13. Verify health checks
say "Checking dashboard health on remote VPS..."
remote_health=$(rsh "curl -s --max-time 10 -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/api/health" || true)
if [ "$remote_health" != "200" ]; then
  die "Dashboard local health check on VPS returned HTTP $remote_health (expected 200)"
fi
ok "Remote health check passed (HTTP 200 on 127.0.0.1:$PORT)"

# Public endpoint check from runner
code=$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' "http://$VPS_IP:$PORT/api/health" || true)
if [ "$code" = "200" ]; then
  ok "Public health check passed (HTTP 200 on http://$VPS_IP:$PORT/api/health)"
else
  say "Public health check returned $code (may be restricted by external firewall/security group). Internal check succeeded."
fi

ok "GetQualify Dashboard successfully deployed to http://$VPS_IP:$PORT/app.html"
