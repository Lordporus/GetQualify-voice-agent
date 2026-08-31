# GetQualify, one-shot setup prompt

Copy the block below and paste it into an AI coding agent (Claude Code, Cursor) or
just follow it yourself in a terminal. It clones the repo, sets the four keys, and
starts the platform. No build step, no database, no npm install. Node 18+ only.

---

## THE ONE-SHOT PROMPT (copy everything between the lines)

```
Set up GetQualify, a production AI voice-agent platform, on this machine and start it.

1. Clone and enter the repo:
   git clone https://github.com/Lordporus/GetQualify-voice.git
   cd GetQualify-voice

2. Create a .env file (copy .env.example to .env) and fill in these FOUR keys plus your number.
   This is the entire configuration:

   RUMIK_API_KEY=            # the VOICE. Get it at https://rumik.ai (dashboard, API key).
   GEMINI_API_KEY=           # the BRAIN. Free at https://aistudio.google.com/apikey
   VOICELINK_RESELLER_USER=  # telephony login, your VoiceLink username
   VOICELINK_RESELLER_PASS=  # telephony login, your VoiceLink password
   VOICELINK_DID=            # the VoiceLink number you dial FROM, e.g. 91XXXXXXXXXX

   Leave GEMINI_MODEL, PORT, and VOICELINK_BASE at their defaults.

3. Start it (zero dependencies):
   node server.js

4. Open http://localhost:8787 in your browser. Click "Launch console", create a tenant,
   and you are live: a Voice Studio to generate speech, an agent builder, in-browser voice
   chat, and outbound calling, all on the Rumik voice at roughly one rupee per minute.

Verify it works: the dashboard provider chips (TTS, Brain, Telephony) should all be green,
and the Voice Studio "Synthesize" button should return audio. If a chip is grey, that key is
missing or wrong in .env.
```

---

## What each key unlocks

- **RUMIK_API_KEY** alone gives you the Voice Studio (generate speech). 24kHz studio audio,
  two models: `mulberry` (fast, 4 speakers + pitch + describe-a-voice) and `muga` (expressive,
  tone tags). Roughly 20x cheaper than ElevenLabs.
- **+ GEMINI_API_KEY** gives the brain, so agents can converse ("Talk to it" and live phone agents).
- **+ VOICELINK_RESELLER_USER / PASS / DID** gives real telephony, place and receive calls on
  your own number.

## Notes

- The microphone in "Talk to it" needs HTTPS (a browser rule). On `http://localhost` it works;
  on a plain `http://` server, type instead, or put the app behind HTTPS.
- Everything is provider-agnostic. Adding `ELEVENLABS_API_KEY`, `SARVAM_API_KEY`,
  `ANTHROPIC_API_KEY`, `ZOOM_*` or `TWILIO_*` flips those providers live in Settings, no code change.
- Cost at permanent rates is roughly 1.5 to 2.5 rupees per minute all-in, several times cheaper
  than an ElevenLabs plus Twilio plus GPT stack.
- For the sub-second Rumik PHONE agent (Gemini Live brain streamed into Rumik over the telephony
  socket), see the separate `getqualify-voice-bridge` companion service.

