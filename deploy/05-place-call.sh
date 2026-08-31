#!/usr/bin/env bash
# STEP 6b. Place a real outbound call. This costs money.
. "$(dirname "$0")/_common.sh"
: "${WORKFLOW_ID:?Set WORKFLOW_ID in .env}"
: "${TELEPHONY_CONFIG_ID:?Set TELEPHONY_CONFIG_ID in .env}"
: "${PHONE_NUMBER_ID:?Set PHONE_NUMBER_ID in .env}"

TARGET="${1:-${TEST_NUMBER:-}}"
[ -n "$TARGET" ] || die "Usage: bash deploy/05-place-call.sh +91XXXXXXXXXX"

say "Placing a REAL call to $TARGET. This is billable."
read -r -p "Continue? [y/N] " a; [ "$a" = "y" ] || exit 1

TOK=$(dograh_token); export TOK
api POST /api/v1/telephony/initiate-call "$(python3 - <<PY
import json,os
print(json.dumps({
  "workflow_id": int(os.environ["WORKFLOW_ID"]),
  "telephony_configuration_id": int(os.environ["TELEPHONY_CONFIG_ID"]),
  "from_phone_number_id": int(os.environ["PHONE_NUMBER_ID"]),
  "phone_number": "$TARGET",
}))
PY
)"
echo

cat <<'CHECK'
Answer the phone and verify all three, not just the first:
  1. the agent SPEAKS FIRST, without waiting for you
  2. you can talk over it mid-sentence and it stops
  3. it responds to what you actually said

Silence after pickup means the number is bound to a stale Vobiz application
whose answer_url points somewhere dead. Re-run 03-configure.sh.
CHECK

sleep 10
say "Latest run"
api GET "/api/v1/workflow/$WORKFLOW_ID/runs" | python3 -c '
import json,sys
r=json.load(sys.stdin)["runs"][0]
print("  name:     ", r["name"])
print("  mode:     ", r["mode"])
print("  completed:", r["is_completed"])
rc=r.get("initial_context",{}).get("runtime_configuration",{})
print("  pipeline: ", rc.get("stt_provider"), "+", rc.get("llm_provider"), "+", rc.get("tts_provider"))
'
