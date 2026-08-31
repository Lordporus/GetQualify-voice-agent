# GetQualify Agent Stack, one-shot prompt

Paste the block below into Claude Code (or run it yourself) on a machine with SSH
access to a fresh Ubuntu VPS. It goes from a bare box to a phone ringing with an
AI receptionist on the other end.

Everything between the fenced block is the prompt. Fill in the six values in
STEP 0 first, everything after that is mechanical.

---

```
You are setting up the GetQualify Agent Stack: a self-hosted AI phone agent that
answers and places real calls, running Dograh as the orchestrator, Vobiz for
telephony, Deepgram for speech-to-text, Groq for the brain, and Rumik silk for the
voice. Target cost is roughly 2 rupees per minute all in, against 15 to 20 rupees
for an ElevenLabs plus Twilio plus GPT stack.

Work through every step in order. Do not skip verification steps. Do not report a
step as done until you have seen the actual response confirming it.


## STEP 0. Values you need before starting

Collect these first. If any are missing, stop and ask for them.

  VPS_IP           a fresh Ubuntu 24.04 box, 4GB RAM minimum (2GB works with swap)
  SSH_KEY          path to the private key that can reach root@VPS_IP
  VOBIZ_AUTH_ID    from console.vobiz.ai, looks like MA_XXXXXXXX
  VOBIZ_AUTH_TOKEN from console.vobiz.ai
  VOBIZ_NUMBER     a number you own on Vobiz, E.164 with plus, e.g. +91XXXXXXXXXX
  DEEPGRAM_API_KEY from console.deepgram.com
  GROQ_API_KEY     from console.groq.com
  RUMIK_API_KEY    from rumik.ai
  TEST_NUMBER      the phone you will call to verify, E.164 with plus

Also pick an admin email and password for the Dograh console. They are created in
STEP 3 and are the only login to the whole system.


## STEP 1. Clone this repo

  git clone https://github.com/Lordporus/GetQualify-voice.git
  cd GetQualify-voice
  cp .env.example .env

Fill .env with every value from STEP 0. Never commit .env, it is gitignored.


## STEP 2. Deploy Dograh onto the VPS

Run:

  bash deploy/01-deploy-dograh.sh

This SSHes into the box and runs Dograh's official remote installer in prebuilt
mode. It brings up seven containers (postgres, redis, minio, coturn, api, ui,
nginx) and issues a real Let's Encrypt certificate against the sslip.io hostname,
so you get HTTPS with no DNS setup. Browser microphone access requires HTTPS, so
this is not optional.

Two things that will bite you on a small box, both handled by the script:
  - A 2GB droplet OOM-kills the API supervisor on first boot. The script adds a
    4GB swapfile and sets FASTAPI_WORKERS=1.
  - Ports 22, 80, 443 must be open, plus 3478 and 5349 and UDP 49152-49200 if you
    want WebRTC browser calls.

VERIFY: `docker ps` on the box shows 7 containers, all healthy or up. The console
loads at https://<dashed-ip>.sslip.io (e.g. https://203-0-113-10.sslip.io).
Do not continue until the console renders in a browser.


## STEP 3. Create the admin user

Open the console URL in a browser and sign up with your admin email and password.
This is local OSS auth, the first signup owns organization 1.

IMPORTANT: every Dograh signup lands in its OWN isolated organization. If you
configure things via the API under one account and then log into the browser as a
different account, the console will show an empty system and nothing will make
sense. Use the SAME account for both, throughout.

If you ever need to reset the password, bcrypt is used directly, no pepper:

  docker exec <api-container> python3 -c \
    "import bcrypt; print(bcrypt.hashpw(b'NEWPASS', bcrypt.gensalt()).decode())"
  docker exec <postgres-container> psql -U postgres -d postgres \
    -c "update users set password_hash='<hash>' where email='<email>';"


## STEP 4. Add the Rumik voice provider

Rumik is not in stock Dograh. It is added as a Docker overlay that installs the
pipecat-rumik plugin and patches two registry files.

  bash deploy/02-build-rumik-overlay.sh

The critical detail, and the reason a naive install breaks the box: Dograh vendors
its own pipecat fork tagged v1.1.0, but setuptools_scm cannot read submodule tags,
so the installed pipecat-ai self-reports as 0.0.0.dev0. pipecat-rumik declares
pipecat-ai>=1.0.0,<2. A normal pip install therefore either fails resolution or
pulls upstream pipecat from PyPI straight over Dograh's fork and destroys the
runtime. The install MUST use --no-deps. Its other three dependencies (aiohttp,
certifi, websockets) are already in the base image.

VERIFY: the api container restarts healthy and rumik appears in the TTS provider
list at /api/v1/organizations/model-configurations/v2/defaults.


## STEP 5. Configure telephony, the model pipeline, and the agent

  bash deploy/03-configure.sh

This drives the Dograh API and does four things:

  a) Creates a Vobiz telephony configuration. Leave application_id blank and
     Dograh auto-creates a Vobiz application and points its answer_url at your
     own box. Do NOT reuse an application_id from another product, that is the
     single most common cause of a call that connects and then sits in silence.

  b) Attaches your Vobiz number as the default caller ID.

  c) Sets the org model configuration to byok pipeline mode:
       stt: deepgram / nova-3-general / language multi
       llm: groq / llama-3.3-70b-versatile
       tts: rumik / mulberry / voice ira

     Use PIPELINE mode, not realtime. Gemini Live native-audio realtime does not
     do turn detection over an 8k telephony stream: the call connects, the agent
     may greet, and then it never responds to the caller and dies with
     user_idle_max_duration_exceeded. A normal STT to LLM to TTS pipeline uses
     Dograh's own VAD and turn detection and works correctly on the phone.

  d) Creates the Ria receptionist workflow from workflows/ria-receptionist.json
     and publishes it.

VERIFY after this step, all four:
  - GET /api/v1/organizations/telephony-configs returns your vobiz config
  - its phone-numbers list contains your number with is_default_caller_id true
  - GET /api/v1/organizations/model-configurations/v2 shows rumik as the tts
  - GET /api/v1/workflow/summary lists the Ria workflow


## STEP 6. Confirm barge-in is enabled, then place a real call

Before calling, check every speaking node in the workflow:

  bash deploy/04-check-interrupts.sh

Every node except the endCall node must have allow_interrupt set to true. If any
node is false, the agent will talk straight over the caller and cannot be cut off,
which feels broken on a real call. The script fixes and republishes automatically.
This is a workflow setting, not an audio bug, so no amount of tuning the pipeline
will fix it.

Then place the call:

  bash deploy/05-place-call.sh +91XXXXXXXXXX

VERIFY properly, and this means actually answering the phone:
  - the phone rings
  - the agent SPEAKS FIRST, without waiting for you
  - you can talk over it mid-sentence and it stops
  - it responds to what you actually said

If it rings and then sits silent, the answer_url is wrong: the number is bound to
a stale Vobiz application instead of the one Dograh created. Re-run STEP 5a.

Check the run afterwards:
  GET /api/v1/workflow/<id>/runs
The newest run shows mode vobiz and a runtime_configuration naming deepgram,
groq and rumik. That is proof the call went through the intended pipeline.


## STEP 7. Optional, the management dashboard

The repo also ships a zero-dependency Node console (agent builder, voice studio,
live in-browser voice chat, usage and cost in INR). It has no npm dependencies and
no build step.

  bash deploy/06-deploy-dashboard.sh

It runs in a node:20-alpine container on port 8787 and is reachable at
http://<VPS_IP>:8787/app.html. Open the firewall for 8787 first.


## DONE means all of this is true

  - 7 Dograh containers healthy, console reachable over HTTPS
  - rumik listed as an available TTS provider
  - a vobiz telephony config with your number as default caller ID
  - the Ria workflow published with allow_interrupt true on all speaking nodes
  - a real outbound call that speaks first and can be interrupted
  - the run record naming deepgram, groq and rumik

Report each of those six as verified, with the actual response you saw. If a step
could not be verified, say so plainly rather than assuming it worked.
```

---

## What this stack actually is

| Layer | Component | Why this one |
|---|---|---|
| Orchestrator | Dograh (open source) | Runs the node graph, VAD, turn detection, recordings, run logs |
| Telephony | Vobiz | Native provider in Dograh, Plivo-compatible API, Indian numbers |
| Speech to text | Deepgram nova-3-general | Multilingual, handles Hinglish on an 8k phone stream |
| Brain | Groq llama-3.3-70b-versatile | Fast enough that the pause before a reply is not noticeable |
| Voice | Rumik silk (mulberry) | Roughly 20x cheaper than ElevenLabs at promo rates |
| Console | GetQualify Studio | Zero-dependency Node app, agent builder plus voice studio |

## The four failures this prompt is written to prevent

1. **A call that connects and stays silent.** The number was bound to an old Vobiz
   application whose answer_url pointed somewhere dead. Dograh must own the
   application it answers on.
2. **An agent that never responds to the caller.** Gemini Live realtime does not do
   turn-taking over telephony. Use a pipeline, not a realtime brain.
3. **An agent that cannot be interrupted.** `allow_interrupt` defaults to false in
   a fresh workflow draft. It is a per-node setting and must be true on every
   speaking node.
4. **A broken box after adding Rumik.** Installing pipecat-rumik without `--no-deps`
   replaces Dograh's vendored pipecat fork with upstream PyPI pipecat.

