# Troubleshooting

Every entry below is a failure that actually happened on this stack, with the
real cause and the real fix. They are ordered by how often they bite.

---

## The call connects, you pick up, and there is total silence

**Cause.** The Vobiz number is bound to an application whose `answer_url` points
somewhere that is not your Dograh box. The carrier dials fine, the callee picks
up, nothing is listening on the other end, so nobody speaks.

This is easy to hit because a Vobiz account often already has an application on
it from another product, and placing a call through the raw Vobiz API uses
whatever application the number is attached to, not Dograh.

**Check.**
```bash
curl -s -H "X-Auth-ID: $VOBIZ_AUTH_ID" -H "X-Auth-Token: $VOBIZ_AUTH_TOKEN" \
  "https://api.vobiz.ai/api/v1/Account/$VOBIZ_AUTH_ID/Application/"
```
The application bound to your number must have `answer_url` pointing at
`https://<your-host>/api/v1/telephony/inbound/run`.

**Fix.** Create the telephony configuration in Dograh with `application_id` left
BLANK. Dograh auto-creates its own application and sets the answer_url correctly.
Then place calls through `POST /api/v1/telephony/initiate-call`, never through the
raw Vobiz `Call/` endpoint. `deploy/03-configure.sh` does this.

---

## The agent greets, then never responds to anything you say

**Cause.** The org model configuration is in `realtime` mode with a native-audio
model (for example Gemini Live). Realtime native audio does not perform turn
detection over an 8kHz telephony stream. The logs say:

```
DograhGeminiLiveLLMService is not emitting turn frames
  (UserStartedSpeakingFrame / UserStoppedSpeakingFrame)
```

and the call ends with disposition `user_idle_max_duration_exceeded`.

**Fix.** Use `byok` + `pipeline` mode with real STT, LLM and TTS providers. A
pipeline uses Dograh's own VAD and turn detection, which works correctly on the
phone. The working configuration is deepgram nova-3-general, groq
llama-3.3-70b-versatile, rumik mulberry.

Related, if you do use a Gemini realtime config anywhere: `language` must be full
BCP-47 (`en-US`). A bare `en` throws `1007 Unsupported language code 'en'`, the
Live connection fails three times, and the call is cut about four seconds in.

---

## The agent cannot be interrupted, it talks straight over you

**Cause.** `allow_interrupt` is `false` on the workflow nodes. It defaults to
false in a fresh draft. This is a per-node workflow setting, not an audio
pipeline problem, so tuning the pipeline will never fix it.

**Check.**
```bash
bash deploy/04-check-interrupts.sh
```

**Fix.** Set `allow_interrupt: true` on every speaking node, leave it false on the
`endCall` node so the closing line finishes, then PUT the workflow and POST to
`/publish`. The script does both. Publishing is required, editing the draft alone
changes nothing on live calls.

---

## Login returns "Invalid email or password" on an account you are sure exists

**Cause.** Usually a different account than you think, or a password that was
never what the notes said.

**Fix.** Dograh OSS uses plain bcrypt with no pepper, so you can reset it
directly.

```bash
API=$(docker ps --format '{{.Names}}' | grep dograh-api | head -1)
PG=$(docker ps --format '{{.Names}}' | grep dograh-postgres | head -1)

HASH=$(docker exec $API python3 -c \
  "import bcrypt; print(bcrypt.hashpw(b'NEWPASSWORD', bcrypt.gensalt()).decode())")

docker exec $PG psql -U postgres -d postgres \
  -c "update users set password_hash='$HASH' where email='you@example.com';"
```

Note the postgres role is `postgres`, not `dograh`.

---

## The console shows "No workflows" but the API clearly returns them

**Cause.** Multi-tenancy. Every Dograh signup lands in its own isolated
organization. If a script configured things under account A and you are logged
into the browser as account B, B sees an empty system and everything looks broken.

**Fix.** Use the same account for API calls and for the browser. Confirm which
account owns what:

```bash
docker exec $PG psql -U postgres -d postgres \
  -c "select id, email, selected_organization_id from users;"
```

---

## The API container is unhealthy on first boot, `uvicorn0 ... Killed`

**Cause.** OOM. Dograh wants 4 vCPU and 8GB. On a 2GB box the supervisor (two
uvicorn workers plus ari_manager, campaign_orchestrator, arq and pipecat) is
killed by the kernel.

**Fix.** Add a 4GB swapfile and set `FASTAPI_WORKERS=1`, both of which
`deploy/01-deploy-dograh.sh` does. If it is still unstable, resize the droplet.

---

## `/openapi.json` returns HTML instead of JSON

The root path is served by the Next.js UI, which 307-redirects unknown paths to
`/auth/login` and returns an HTML page. The API schema is namespaced:

```
https://<host>/api/v1/openapi.json      correct
https://<host>/openapi.json             returns the login page
```

---

## Rumik stopped appearing as a TTS provider after an update

`docker compose pull` replaced your overlay image with the upstream one. Pin it:

```yaml
services:
  api:
    image: local/dograh-api:rumik-v1
    pull_policy: never
```

See `docs/RUMIK-OVERLAY.md`.
