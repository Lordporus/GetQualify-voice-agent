# GetQualify Agent Stack

A self-hosted AI phone agent that answers and places real calls, for roughly
**2 rupees a minute** against 15 to 20 on an ElevenLabs plus Twilio plus GPT stack.

Bare Ubuntu box to a ringing phone in six scripted steps. No SaaS in the middle,
every key stays on your own server.

```
git clone https://github.com/Lordporus/GetQualify-voice.git
cd GetQualify-voice
cp .env.example .env      # fill in 8 values
bash deploy/01-deploy-dograh.sh
```

Handing this to an AI coding agent instead? Paste
[`ONE-SHOT-PROMPT.md`](ONE-SHOT-PROMPT.md) and it runs the whole thing end to end.

---

## The stack

| Layer | Component | Why |
|---|---|---|
| Orchestrator | [Dograh](https://github.com/dograh-hq/dograh), open source | Node-graph agents, VAD, turn detection, recordings, run logs |
| Telephony | Vobiz | Native Dograh provider, Plivo-compatible, Indian numbers |
| Speech to text | Deepgram `nova-3-general` | Multilingual, holds up to Hinglish on an 8k phone stream |
| Brain | Groq `llama-3.3-70b-versatile` | Fast enough that the pause before a reply is not noticeable |
| Voice | Rumik silk `mulberry` | Roughly 20x cheaper than ElevenLabs at promo rates |
| Console | GetQualify Studio | Zero-dependency Node app, agent builder plus voice studio |

Every layer is swappable. Dograh natively supports Twilio, Telnyx, Plivo, Vonage
and Cloudonix for telephony, and the model pipeline takes any STT, LLM or TTS
provider in its registry.

---

## What you get

- **A real phone agent.** Answers inbound, places outbound, speaks first, and can
  be interrupted mid-sentence like a person.
- **Ria, a working receptionist persona.** The full prompt stack is in
  [`prompts/ria-system-prompts.md`](prompts/ria-system-prompts.md), and the
  machine-readable workflow is in `workflows/`. Swap two blocks and it is your
  business instead.
- **A management console.** Build agents, generate speech, talk to an agent in the
  browser, see usage and cost in INR.
- **A reusable SaaS control plane.** Isolated tenants, roles, presets, wallets,
  PayU checkout, support, privacy modes, BYON requests, audit history and admin tools.
- **A direct browser voice call.** Dograh SmallWebRTC runs the same published
  workflow used by the phone path, without rendering transcript text in the UI.
- **An HVAC example.** Capture call outcomes, route dispatch work, export CSV,
  and optionally book real Cal.com availability from a tenant-scoped desk.
- **Run records.** Every call logs its transcript, recording, disposition and the
  exact provider pipeline it ran on.

---

## Repo layout

```
ONE-SHOT-PROMPT.md          paste-into-an-agent version of the whole setup
.env.example                every value you need, with notes on each

deploy/
  01-deploy-dograh.sh       bare VPS -> Dograh with HTTPS (swap, firewall, LE cert)
  02-build-rumik-overlay.sh add Rumik as a TTS provider
  03-configure.sh           telephony + phone number + model pipeline + workflow
  04-check-interrupts.sh    verify and fix barge-in, then republish
  05-place-call.sh          place a real outbound call and read the run back
  06-deploy-dashboard.sh    optional console on :8787
  rumik-overlay/Dockerfile  the overlay image

workflows/
  ria-receptionist.json     4-node agent graph, importable as-is

prompts/
  ria-system-prompts.md     full untruncated prompt stack plus why it reads that way

docs/
  RUMIK-OVERLAY.md          how the Rumik provider is added, and the --no-deps trap
  TROUBLESHOOTING.md        every real failure hit on this stack, with real fixes
  PRICING.md                measured per-minute cost and the defensible claim

dashboard/                  GetQualify Studio, no build step and one dependency
```

---

The dashboard has no build step and one pinned runtime dependency, `ws`.

## Requirements

- Ubuntu 24.04 VPS, 4GB RAM recommended (2GB works, the deploy script adds swap)
- A Vobiz account with a number, from [console.vobiz.ai](https://console.vobiz.ai)
- API keys: [Deepgram](https://console.deepgram.com),
  [Groq](https://console.groq.com), [Rumik](https://rumik.ai)
- Ports 22, 80, 443 open. Plus 3478, 5349 and UDP 49152-49200 for browser calls.

HTTPS comes free via sslip.io, so no DNS setup is needed. Browser microphone
access requires HTTPS, which is why the deploy issues a real certificate.

---

## Four failures worth knowing before you start

Each of these cost real debugging time. All four are handled by the scripts, and
documented in full in [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md).

1. **A call that connects then sits silent.** The number was bound to a stale
   Vobiz application pointing at a dead answer_url. Let Dograh create its own
   application, and place calls through Dograh, never the raw Vobiz endpoint.

2. **An agent that greets and then ignores you.** Realtime native-audio models do
   not do turn detection over an 8k telephony stream. Use a pipeline, not a
   realtime brain.

3. **An agent that cannot be interrupted.** `allow_interrupt` defaults to false on
   a fresh workflow draft. It is a per-node setting, and no pipeline tuning fixes it.

4. **A broken API container after adding Rumik.** Installing `pipecat-rumik`
   without `--no-deps` pulls upstream pipecat over Dograh's vendored fork.

---

## Cost

| | Promo | Permanent |
|---|---|---|
| All in, per minute | ~1.6 INR | ~2.6 INR |
| AI layer only | ~0.90 INR | ~1.90 INR |

Plus 500 INR/month per Vobiz number and $6 to $12/month for the VPS.
Full breakdown in [`docs/PRICING.md`](docs/PRICING.md).

"AI voice agents from 1 rupee a minute" is defensible for the AI layer. It is not
true all-in once carrier minutes are counted, so do not claim that.

---

## Security

- Every provider key lives in `.env` or server-side config. Keys never reach the
  browser, the server is the only thing that talks to a provider.
- `.env` is gitignored. Nothing in this repo contains a real credential.
- Outbound calls are billable and guarded behind an explicit confirm.
- Rotate any key that has ever been pasted into a chat, a screenshot or a log.

---

Built by [GetQualify](https://GetQualify.com). MIT licensed. Dograh is separately
licensed by its authors.

