#!/usr/bin/env bash
# STEP 5. Telephony config + phone number + model pipeline + the Ria workflow.
. "$(dirname "$0")/_common.sh"

TOK=$(dograh_token); export TOK
ok "Authenticated as $DOGRAH_EMAIL"

# ---- a) Vobiz telephony configuration --------------------------------------
# application_id is deliberately omitted so Dograh creates its OWN Vobiz
# application and points the answer_url at this box. Reusing another product's
# application id is the number one cause of a call that connects then sits silent.
say "Creating the Vobiz telephony configuration"
CFG=$(api POST /api/v1/organizations/telephony-configs "$(python3 - <<PY
import json,os
print(json.dumps({
  "name": "Vobiz Outbound",
  "is_default_outbound": True,
  "config": {
    "provider": "vobiz",
    "auth_id": os.environ["VOBIZ_AUTH_ID"],
    "auth_token": os.environ["VOBIZ_AUTH_TOKEN"],
    "from_numbers": [os.environ["VOBIZ_NUMBER"].lstrip("+")],
  },
}))
PY
)")
CFG_ID=$(printf '%s' "$CFG" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
ok "Telephony config id $CFG_ID"

# ---- b) Attach the number as default caller ID ------------------------------
say "Attaching $VOBIZ_NUMBER"
PN=$(api POST "/api/v1/organizations/telephony-configs/$CFG_ID/phone-numbers" "$(python3 - <<PY
import json,os
print(json.dumps({
  "address": os.environ["VOBIZ_NUMBER"],
  "country_code": "IN",
  "label": "Vobiz Outbound",
  "is_active": True,
  "is_default_caller_id": True,
}))
PY
)")
PN_ID=$(printf '%s' "$PN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
ok "Phone number id $PN_ID"

# ---- c) Model pipeline ------------------------------------------------------
# PIPELINE mode, not realtime. Gemini Live native-audio realtime does not do turn
# detection over an 8k telephony stream: the call connects, the agent may greet,
# then never responds and dies with user_idle_max_duration_exceeded. A normal
# STT -> LLM -> TTS pipeline uses Dograh's own VAD and works on the phone.
say "Setting the model pipeline (deepgram + groq + rumik)"
api PUT /api/v1/organizations/model-configurations/v2 "$(python3 - <<PY
import json,os
print(json.dumps({
  "version": 2,
  "mode": "byok",
  "byok": {
    "mode": "pipeline",
    "pipeline": {
      "stt": {"provider":"deepgram","api_key":os.environ["DEEPGRAM_API_KEY"],
              "model":"nova-3-general","language":"multi"},
      "llm": {"provider":"groq","api_key":os.environ["GROQ_API_KEY"],
              "model":os.environ.get("GROQ_MODEL","llama-3.3-70b-versatile")},
      "tts": {"provider":"rumik","api_key":os.environ["RUMIK_API_KEY"],
              "model":os.environ.get("RUMIK_MODEL","mulberry"),
              "voice":os.environ.get("RUMIK_VOICE","ira"),
              "description":"a warm 30s indian english voice, smooth timbre, natural conversational pacing, like a friendly receptionist",
              "temperature":0.6,"top_p":0.95,"top_k":50,
              "full_response_aggregation": True},
    },
  },
}))
PY
)" >/dev/null
ok "Pipeline set"

# ---- d) The Rumik demo workflow --------------------------------------------
say "Creating the Rumik ₹1 demo workflow"
WF=$(api POST /api/v1/workflow/create/definition "$(python3 - <<PY
import json
d=json.load(open("$ROOT/workflows/rumik-one-rupee-demo.json"))
print(json.dumps({"name":"Rumik ₹1 Demo Agent","workflow_definition":d}))
PY
)")
WF_ID=$(printf '%s' "$WF" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')

# Current Dograh releases activate definitions at creation time. Older releases
# create a draft that still needs the publish endpoint.
WF_STATUS=$(api GET "/api/v1/workflow/fetch/$WF_ID" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status", ""))')
if [ "$WF_STATUS" != "active" ]; then
  api POST "/api/v1/workflow/$WF_ID/publish" >/dev/null
fi
ok "Workflow id $WF_ID active"

# Bind inbound calls only after the workflow exists. This also makes Dograh
# update the provider application's answer_url and synchronize the DID.
say "Binding the Vobiz number to workflow $WF_ID for inbound calls"
api PUT "/api/v1/organizations/telephony-configs/$CFG_ID/phone-numbers/$PN_ID" \
  "$(python3 - <<PY
import json
print(json.dumps({"inbound_workflow_id": int("$WF_ID"), "is_active": True}))
PY
)" >/dev/null
ok "Inbound workflow attached"

# ---- verify -----------------------------------------------------------------
say "Verifying"
api GET /api/v1/organizations/telephony-configs | python3 -m json.tool
api GET "/api/v1/organizations/telephony-configs/$CFG_ID/phone-numbers" | python3 -m json.tool
api GET /api/v1/organizations/model-configurations/v2 | python3 -c \
  'import json,sys; c=json.load(sys.stdin)["effective_configuration"]; print("stt:",c["stt"]["provider"],"| llm:",c["llm"]["provider"],"| tts:",c["tts"]["provider"],"| realtime:",c["is_realtime"])'
api GET /api/v1/workflow/summary | python3 -m json.tool

cat <<NEXT

Save these:
  TELEPHONY_CONFIG_ID=$CFG_ID
  PHONE_NUMBER_ID=$PN_ID
  WORKFLOW_ID=$WF_ID

Append them to .env, then run:
  bash deploy/04-check-interrupts.sh
NEXT
