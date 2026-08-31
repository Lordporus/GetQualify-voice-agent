# GetQualify. Repo guide for future sessions.

Read `SPEC.md` first, it is the binding contract (data model, API routes, sections, edge
cases). This file is the orientation layer. If anything here ever conflicts with `SPEC.md`,
`SPEC.md` wins and this file should be corrected.

No em dashes anywhere in this codebase (code, comments, copy). Use commas or periods.

## What it is

A premium, multi-tenant, provider-agnostic AI voice agent platform, branded **GetQualify**.
The hook is price: production voice agents at roughly one rupee, powered by Rumik silk TTS
(about 20x cheaper than ElevenLabs), with a swappable TTS, LLM, and telephony engine so we are
never locked into one vendor. The voice engine (Rumik), the brain (Gemini), and telephony
(VoiceLink) are already live and verified. The product wraps them in tenants, auth, an agent
builder, a voice studio, a live talk-to-it loop, a telephony console, and usage economics.

## The one folder portability promise

Everything needed to run lives in this one folder. ZERO npm dependencies. Pure Node
`http`/`https`/`crypto`/`fs` on the backend, vanilla HTML/CSS/JS on the frontend. No build step,
no bundler, no framework, no CDN. Copy the folder to any machine with Node 18 or newer and it
runs, fully offline except for the upstream provider API calls. There is nothing to install.

## Run

```sh
cd ~/iCloud/website/GetQualify-voice-studio   # real path: ~/Library/Mobile Documents/com~apple~CloudDocs/website/GetQualify-voice-studio
sh setup.sh        # checks Node 18+, copies .env.example to .env if missing, creates data/, prints next steps
node server.js     # serves the API and the static public/ site on PORT (default 8787)
```

Open `http://localhost:8787`. No `npm install`, ever.

### Demo login (seeded on first boot)

```
email:    hello@getqualify.in
password: GetQualifyvoice
tenant:   GetQualify Demo
```

On first boot, if `data/db.json` is missing, the server creates it and seeds this demo tenant
plus owner, migrates any legacy `agents.json` agents into that tenant, and prints the demo
login to the console.

## Folder structure

```
GetQualify-voice-studio/
  server.js                 # zero-dep HTTP server: API + static public/ (Backend agent)
  lib/
    core.js                 # db (atomic JSON), auth, sessions, tenant scoping, helpers (Backend)
    providers.js            # the provider-agnostic registry: TTS / LLM / telephony adapters (Backend)
  public/
    index.html              # marketing landing page (Marketing agent)
    app.html                # the product dashboard, single-page app shell (Dashboard agent)
    assets/
      brand.css             # SHARED design tokens and primitives. Do not refork. (already on disk)
      marketing.css         # landing styles (Marketing)
      marketing.js          # landing behavior, reveal, image guard, self-check (Marketing)
      app.css               # dashboard styles (Dashboard)
      app.js                # dashboard logic, hash routing, auth gate (Dashboard)
      logo.svg              # GetQualify wordmark with voltage waveform glyph (Ops)
      favicon.svg           # voltage waveform mark on an ink tile (Ops)
      og.svg                # 1200x630 social card with the one-rupee hook (Ops)
  data/
    .gitkeep                # keeps data/ tracked; its real contents are gitignored
    db.json                 # runtime state, auto-created and seeded on first boot (gitignored)
  .env                      # real provider keys, gitignored, never reaches the browser
  .env.example              # template with placeholders + commented optional providers
  setup.sh                  # one command fresh-machine setup, idempotent
  package.json              # name GetQualify-voice, "start": "node server.js", no dependencies
  .gitignore
  README.md
  CLAUDE.md                 # this file
  SPEC.md                   # the binding contract, single source of truth
  _legacy/                  # the verified pre-product server kept for reference (gitignored)
```

`_legacy/server.legacy.js` holds the original verified Rumik, Gemini, and VoiceLink calls. The
provider adapters reuse those exact calls for the live providers, so it is the reference when
debugging an upstream call.

## Provider agnostic architecture (`lib/providers.js`)

Three layers, each a registry of adapters behind one uniform interface. Each adapter exposes its
capability and a `live` flag derived from whether its required env keys are present.

| Layer | Live adapter | Stub adapters (return a clear "not configured, add ENV" error) |
| --- | --- | --- |
| **TTS** | `rumik` | `elevenlabs` (needs `ELEVENLABS_API_KEY`), `sarvam` (needs `SARVAM_API_KEY`) |
| **LLM brain** | `gemini` | `claude` (needs `ANTHROPIC_API_KEY`). NEVER add OpenAI or GPT. |
| **Telephony** | `voicelink` | `zoom` (needs `ZOOM_*`), `twilio` (needs `TWILIO_*`) |

`GET /api/providers` surfaces this registry so the dashboard Settings can render which provider
is active versus ready-to-wire and exactly what env each one needs.

### How to add a new provider

1. In `lib/providers.js`, add an adapter to the right layer's registry. It must implement the
   layer's uniform interface (TTS: synthesize text to audio bytes; LLM: messages to a reply;
   telephony: status and a guarded dial).
2. Declare the env keys it `needs`. Derive `live` from whether all of those keys exist in the env.
3. Add the placeholder keys to `.env.example` (commented, no real secrets).
4. That is it. No route changes. `GET /api/providers` and Settings pick it up automatically, and
   a tenant selects it via `tenant.providers`. Keep the live call server-side, never ship a key
   to the browser.

## Multi-tenant model

State is JSON in `data/db.json` with these collections: `tenants`, `users`, `agents`, `usage`,
`sessions` (see `SPEC.md` section 3 for the exact field shapes).

- **Passwords**: `crypto.scryptSync` with a random salt, stored as `scrypt$<saltHex>$<hashHex>`.
  Never plaintext.
- **Sessions**: opaque `crypto.randomBytes(32)` hex token, httpOnly cookie `rxv_sess`, 7 day expiry.
- **Tenant isolation**: every agent, usage, and telephony read and write is scoped to the
  session's `tenantId`. A user must never see or mutate another tenant's data. A mismatch returns
  403. This is the single most important invariant, do not regress it.
- **Atomic writes**: write `data/db.json.tmp` then `fs.renameSync`, guarded by a small in-process
  write queue so concurrent writes do not corrupt the file. A corrupt `db.json` falls back to a
  default via try/catch.

## API contract summary (all JSON unless noted, auth via `rxv_sess` cookie)

Public (no auth):
- `GET  /api/health` returns `{ ok, providers:{ tts:{rumik}, llm:{gemini}, telephony:{voicelink} }, model }`.
- `POST /api/auth/signup` `{ email, password, name, company }`, sets cookie, returns `{ user, tenant }`. 409 if email exists.
- `POST /api/auth/login` `{ email, password }`, sets cookie. 401 on bad creds.
- `POST /api/auth/logout` clears the cookie.

Authed (401 if no valid session):
- `GET  /api/me` returns `{ user, tenant }`.
- `GET  /api/agents`, `POST /api/agents`, `POST /api/agents/update`, `POST /api/agents/delete` (all tenant scoped, 403 on cross-tenant).
- `POST /api/tts` `{ text, model, speaker?, f0_up_key?, description? }` returns `audio/wav` bytes, with `X-Chars` and `X-Credits-Used` headers, increments tenant usage.
- `POST /api/ws-connect` `{ text, model }` mints a Rumik streaming session `{ ws_url, token }`.
- `POST /api/chat` `{ messages:[{role,text}], system }` returns `{ text, finish }` (Gemini).
- `POST /api/stt` `{ audio (base64), mime }` returns `{ text }` (Gemini transcription).
- `GET  /api/telephony/status` returns the live VoiceLink `{ routing, wallet, dids, engine, did, dashboard }`.
- `POST /api/telephony/dial` `{ number, confirm:true }` places a REAL paid call. GUARDED: returns
  400 `needs_confirm` unless `confirm:true`. Never auto-call.
- `GET  /api/usage` returns `{ days:[...], totals:{...} }` (tenant scoped).
- `GET  /api/providers` returns the provider registry, per layer, with `{ id, label, live, needs }`.

## Verified provider gotchas (do not relearn these the hard way)

- **Rumik browser UA**: Rumik (`silk-api.rumik.ai`) sits behind Cloudflare, which 403s
  non-browser user-agents. The server always sends a browser `User-Agent`. Do not remove it.
  Models are `muga` and `mulberry`. mulberry steers with `description` OR `speaker`
  (`speaker_1..4`) plus `f0_up_key` (clamp -12..12). muga uses a `[tone]` prefix.
  Output is 24kHz mono 16-bit WAV (REST) and PCM int16 LE 24kHz (WS).
- **VoiceLink national number plus country_code**: outbound dial uses a 10-digit national number
  plus `country_code: '91'`, NOT a full E.164 string. Sending `+91...` as the customer number
  causes the call to fail (cause 38). The DID default is `919484956633`. Login uses reseller creds.
- **Gemini**: default model `gemini-flash-latest` via `:generateContent`, thinking budget 0 for
  low latency. STT also goes through Gemini as a fallback to the browser Web Speech API.
- **Never run the realtime server under a file watcher**: watchers fire restarts as macOS touches
  files, dropping live sockets and leaking processes. Run `node server.js` plainly.

## Conventions and guardrails

- Reuse `brand.css` tokens and primitives (`var(--bg)`, `--panel`, `--grad-volt`, `.btn`, `.card`,
  `.input`, `.reveal`, `.wrap`, `.section`, `.t-display`, and the rest). Do not refork colors or
  redefine the system. The look is one cohesive, dark, premium, funded product.
- Marketing copy is VISIBLE BY DEFAULT. Never `opacity:0` waiting on JS. The `.reveal` pattern is
  progressive enhancement only, gated on `html.js`. `marketing.js` ends with a self-check that
  force-shows anything stuck at opacity 0 and a guard that swaps any broken image to a branded SVG.
- Escape any user-supplied string (name, email, persona) before injecting it into the DOM.
- The brand SVGs use the voltage gradient (cyan `#34E7E4`, sky `#22D3EE`, indigo `#6E7BFF`,
  violet `#A855F7`). Their waveform-bar gradients use `gradientUnits="userSpaceOnUse"` on purpose,
  thin vertical lines lose an `objectBoundingBox` gradient in some renderers. Keep that.
- If dependencies are ever added (they should not be), rename `node_modules` to
  `node_modules.nosync` so iCloud does not try to sync them.

## Done means verified

Server boots clean, `/api/health` all true, signup and login work, agent create plus preview
returns a real Rumik WAV, talk-to-it returns a real Gemini reply, telephony status returns the
live VoiceLink wallet, the landing renders with zero console errors on desktop and 390px mobile
with nothing stuck at opacity 0 and no broken images, and there are no em dashes anywhere.
Verify in a real browser, not by curl alone.

