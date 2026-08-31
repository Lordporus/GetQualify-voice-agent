#!/usr/bin/env bash
# STEP 2. Bare Ubuntu box -> Dograh running with HTTPS.
. "$(dirname "$0")/_common.sh"

say "Deploying Dograh to $VPS_IP (host $DOGRAH_HOST)"

# A 2GB box OOM-kills the API supervisor on first boot. Swap first, always.
say "Adding swap (harmless if it already exists)"
rsh "test -f /swapfile || (fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab)"
rsh "free -h | head -3"

say "Opening firewall"
rsh "ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 3478 && ufw allow 5349 && ufw allow 49152:49200/udp || true"

say "Running Dograh's official remote installer, prebuilt mode"
rsh "mkdir -p /opt/dograh-hq && cd /opt/dograh-hq && \
     curl -fsSL -o setup_remote.sh https://raw.githubusercontent.com/dograh-hq/dograh/main/scripts/setup_remote.sh && \
     chmod +x setup_remote.sh && \
     SERVER_IP=$VPS_IP DEPLOY_MODE=prebuilt FASTAPI_WORKERS=1 ./setup_remote.sh"

say "Verifying"
rsh "docker ps --format '{{.Names}}\t{{.Status}}'"
code=$(rsh "curl -sLo /dev/null -w '%{http_code}' $BASE/ -k")
[ "$code" = "200" ] || die "Console did not return 200, got $code"
ok "Console live at $BASE"

cat <<NEXT

NEXT: open $BASE in a browser and sign up with
  email:    $DOGRAH_EMAIL
  password: $DOGRAH_PASSWORD

The first signup owns organization 1. Use this SAME account for the browser and
for every API call, or the console will look empty while the API shows data.

Then run: bash deploy/02-build-rumik-overlay.sh
NEXT
