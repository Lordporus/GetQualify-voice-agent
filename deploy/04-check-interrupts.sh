#!/usr/bin/env bash
# STEP 6a. Every speaking node must have allow_interrupt true, or the agent
# talks straight over the caller and cannot be cut off. This is a per-node
# workflow setting that defaults to FALSE in a fresh draft. No amount of audio
# pipeline tuning fixes it.
. "$(dirname "$0")/_common.sh"
: "${WORKFLOW_ID:?Set WORKFLOW_ID in .env (printed by 03-configure.sh)}"

TOK=$(dograh_token); export TOK

say "Reading workflow $WORKFLOW_ID"
api GET "/api/v1/workflow/fetch/$WORKFLOW_ID" > /tmp/_wf.json
python3 - <<'PY'
import json
d=json.load(open("/tmp/_wf.json"))
for n in d["workflow_definition"]["nodes"]:
    print(f"  {n['id']:>3}  {n['type']:<12} allow_interrupt={n['data'].get('allow_interrupt')}  {n['data'].get('name')}")
PY

BAD=$(python3 -c '
import json
d=json.load(open("/tmp/_wf.json"))
print(sum(1 for n in d["workflow_definition"]["nodes"]
          if n["type"]!="endCall" and not n["data"].get("allow_interrupt")))')

if [ "$BAD" = "0" ]; then
  ok "Barge-in already enabled on every speaking node"
  exit 0
fi

say "Enabling barge-in on $BAD node(s) and republishing"
python3 - <<'PY' > /tmp/_wf_body.json
import json
d=json.load(open("/tmp/_wf.json"))
for n in d["workflow_definition"]["nodes"]:
    if n["type"] != "endCall":
        n["data"]["allow_interrupt"] = True
json.dump({"workflow_definition": d["workflow_definition"]}, open("/tmp/_wf_body.json","w"))
PY
api PUT "/api/v1/workflow/$WORKFLOW_ID" "$(cat /tmp/_wf_body.json)" >/dev/null
api POST "/api/v1/workflow/$WORKFLOW_ID/publish"
ok "Republished. Next: bash deploy/05-place-call.sh $TEST_NUMBER"
