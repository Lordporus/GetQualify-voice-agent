#!/usr/bin/env bash
# STEP 4. Add Rumik silk as a TTS provider via a Docker overlay.
. "$(dirname "$0")/_common.sh"

say "Building the Rumik overlay image"

BASE_IMG=$(rsh "docker ps --format '{{.Image}}' | grep -i dograh-api | head -1")
[ -n "$BASE_IMG" ] || die "Could not find the running dograh-api image"
ok "Base image: $BASE_IMG"

rsh "mkdir -p /opt/rumik-overlay"
OVERLAY="$ROOT/rumik-overlay-local"
[ -f "$OVERLAY/registry.py" ] || die "Missing $OVERLAY/registry.py"
[ -f "$OVERLAY/service_factory.py" ] || die "Missing $OVERLAY/service_factory.py"
[ -f "$OVERLAY/check_validity.py" ] || die "Missing $OVERLAY/check_validity.py"

sed "s|^FROM .*|FROM $BASE_IMG|" "$OVERLAY/Dockerfile" \
  | rsh "cat > /opt/rumik-overlay/Dockerfile"

say "Uploading the verified Rumik registry and service patches"
for file in registry.py service_factory.py check_validity.py; do
  rsh "cat > /opt/rumik-overlay/$file" < "$OVERLAY/$file"
done

say "Building (pip install uses --no-deps, see docs/RUMIK-OVERLAY.md for why)"
rsh "cd /opt/rumik-overlay && docker build -t local/dograh-api:rumik-v1 ."

say "Pointing the compose stack at the new image"
rsh "cd /opt/dograh-hq/dograh && printf 'services:\n  api:\n    image: local/dograh-api:rumik-v1\n    pull_policy: never\n' > docker-compose.override.yaml && docker compose up -d api"

sleep 20
rsh "docker ps --format '{{.Names}}\t{{.Status}}' | grep api"

say "Verifying Rumik is registered"
TOK=$(dograh_token)
api GET /api/v1/organizations/model-configurations/v2/defaults \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); assert "rumik" in str(d).lower(); print("rumik_registered=true")'
ok "Rumik overlay live. Next: bash deploy/03-configure.sh"
