# GetQualify , Build Contract (single source of truth for the swarm)

This file is the fixed contract. Backend, marketing, and dashboard agents all build
against it. Do not invent routes, field names, or token names that conflict with this.
No em dashes anywhere in any file (code, comments, copy). Use commas or periods.

## 0. What we are building

A premium, multi-tenant, provider-agnostic AI **voice agent platform**, branded
**GetQualify**. The hook: production voice agents at roughly one rupee, powered by
Rumik silk TTS (about 20x cheaper than ElevenLabs), with a swappable engine so you are
never locked into one TTS, LLM, or telephony vendor. Packaged as ONE portable folder,
zero npm dependencies, runs with `node server.js`.

The voice engine (Rumik), the brain (Gemini), and telephony (VoiceLink) are ALREADY
live and verified. We are wrapping them in a real product: tenants, auth, an agent
builder, a voice studio, a live talk-to-it loop, a telephony console, and usage/economics,
behind a million-dollar-funded look.

## 1. Stack & portability rules (NON NEGOTIABLE)

- Pure Node `http`/`https`/`crypto`/`fs`. ZERO npm dependencies. No build step, no bundler,
  no framework, no CDN (must run offline on a fresh machine after copying the folder).
- Entry: `node server.js` serves the API and the static `public/` site on `PORT` (default 8787).
- Secrets live in `.env` (already present with real keys, gitignored). Keys NEVER reach the browser.
- Runtime state in `data/` as JSON (gitignored). Auto-create + seed on first boot.
- Frontend is vanilla HTML/CSS/JS. Shared tokens in `public/assets/brand.css` (already written, do not refork).
- Marketing page content is VISIBLE BY DEFAULT. Never `opacity:0` waiting on JS. Reveals are
  progressive enhancement only (the `.reveal` pattern in brand.css, gated on `html.js`).

## 2. File ownership (each agent owns distinct files, no conflicts)

- **Backend agent** owns: `server.js`, `lib/core.js`, `lib/providers.js`.
- **Marketing agent** owns: `public/index.html`, `public/assets/marketing.css`, `public/assets/marketing.js`.
- **Dashboard agent** owns: `public/app.html`, `public/assets/app.css`, `public/assets/app.js`.
- **Ops agent** owns: `package.json`, `setup.sh`, `README.md`, `.env.example`, `.gitignore`,
  `CLAUDE.md`, `data/.gitkeep`, and brand SVGs `public/assets/logo.svg`, `favicon.svg`, `og.svg`.
- Shared, already on disk: `public/assets/brand.css` (design tokens), `.env` (real keys), `SPEC.md`.

## 3. Multi-tenant data model (JSON in `data/`)

`data/db.json` shape:
```
{
  "tenants": [ { "id":"t_xxx", "name":"Acme Co", "slug":"acme", "createdAt":ISO,
                 "branding": { "color":"#6E7BFF" },
                 "providers": { "tts":"rumik", "llm":"gemini", "telephony":"voicelink" },
                 "plan":"studio" } ],
  "users":   [ { "id":"u_xxx", "tenantId":"t_xxx", "email":"a@b.com",
                 "name":"Shreyas", "passHash":"scrypt$...", "role":"owner", "createdAt":ISO } ],
  "agents":  [ { "id":"ag_xxx", "tenantId":"t_xxx", "name":"Front Desk",
                 "persona":"...", "tts": { "provider":"rumik","model":"mulberry","speaker":"speaker_2","f0_up_key":0 },
                 "greeting":"...", "telephony": { "did":"919484956633" }, "createdAt":ISO } ],
  "usage":   [ { "tenantId":"t_xxx", "day":"2026-06-22", "chars":0, "calls":0, "llmTokens":0 } ],
  "sessions":[ { "token":"...", "userId":"u_xxx", "tenantId":"t_xxx", "exp":ms } ]
}
```
- Passwords: `crypto.scryptSync` with random salt, stored as `scrypt$<saltHex>$<hashHex>`. Never plaintext.
- Sessions: opaque random token (`crypto.randomBytes(32).hex`), httpOnly cookie `rxv_sess`, 7 day expiry.
- Tenant isolation: EVERY agent/usage/telephony read+write is scoped by the session's `tenantId`.
  A user must never see or mutate another tenant's data. Mismatch returns 403.
- Atomic writes: write to `data/db.json.tmp` then `fs.renameSync`. Guard concurrent writes with a simple in-process queue.
- On boot: if `data/db.json` missing, create it and seed a demo tenant + owner
  (email `hello@getqualify.in`, password `GetQualifyvoice`, tenant `GetQualify Demo`) and migrate any
  legacy `agents.json` agents into that tenant. Print the demo login to the console.

## 4. API contract (all JSON unless noted). Auth via `rxv_sess` cookie.

Public (no auth):
- `GET  /api/health` -> `{ ok, providers: { tts:{rumik:bool}, llm:{gemini:bool}, telephony:{voicelink:bool} }, model }`
- `POST /api/auth/signup` `{ email, password, name, company }` -> sets cookie, `{ user, tenant }`. 409 if email exists.
- `POST /api/auth/login`  `{ email, password }` -> sets cookie, `{ user, tenant }`. 401 on bad creds.
- `POST /api/auth/logout` -> clears cookie, `{ ok:true }`.

Authed (require valid session; 401 if missing):
- `GET  /api/me` -> `{ user, tenant }`
- `GET  /api/agents` -> `{ agents:[...] }` (tenant scoped)
- `POST /api/agents` `{ name, persona, tts:{model,speaker,f0_up_key}, greeting, did }` -> `{ agent }`
- `POST /api/agents/update` `{ id, ...fields }` -> `{ agent }` (403 if not this tenant)
- `POST /api/agents/delete` `{ id }` -> `{ ok:true }` (403 if not this tenant)
- `POST /api/tts` `{ text, model, speaker?, f0_up_key?, description? }` -> `audio/wav` bytes.
  Headers `X-Chars`, `X-Credits-Used`. Increments tenant usage.chars. Reuses verified Rumik call.
- `POST /api/ws-connect` `{ text, model }` -> `{ ws_url, token }` (Rumik streaming mint, verified).
- `POST /api/chat` `{ messages:[{role,text}], system }` -> `{ text, finish }`. Reuses verified Gemini call.
- `POST /api/stt` `{ audio (base64), mime }` -> `{ text }` (Gemini transcription, verified).
- `GET  /api/telephony/status` -> VoiceLink status `{ routing, wallet, dids, engine, did, dashboard }` (verified).
- `POST /api/telephony/dial` `{ number, confirm:true }` -> places a REAL paid call. GUARDED:
  returns 400 `needs_confirm` unless `confirm:true`. Never auto-call. Reuses verified add_lead.
- `GET  /api/usage` -> `{ days:[{day,chars,calls,llmTokens,costInr}], totals:{...} }` (tenant scoped).
- `GET  /api/providers` -> the provider registry: for each layer, list providers with
  `{ id, label, live:bool, needs:[env keys] }` so the UI can show what is active vs ready-to-wire.

## 5. Provider-agnostic engine (`lib/providers.js`)

Three layers, each a registry of adapters with a uniform interface. Reuse the verified
calls from `_legacy/server.legacy.js` for the live ones.

- **TTS**: `rumik` (LIVE, reuse exactly: host `silk-api.rumik.ai`, Bearer key, browser UA, `/v1/tts`,
  `/v1/tts/ws-connect`, models `muga`+`mulberry`, speakers, f0_up_key). Stubs (return a clear
  "not configured, add <ENV>" error, `live:false`): `elevenlabs` (needs `ELEVENLABS_API_KEY`),
  `sarvam` (needs `SARVAM_API_KEY`).
- **LLM brain**: `gemini` (LIVE, reuse generateContent + STT). Stub: `claude` (needs `ANTHROPIC_API_KEY`).
  NEVER add OpenAI/GPT. Only Gemini and Claude.
- **Telephony**: `voicelink` (LIVE, reuse login/status/dial). Stubs: `zoom` (needs `ZOOM_ACCOUNT_ID`,
  `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`), `twilio` (needs `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`).
- Each adapter exposes its capability and a `live` flag derived from whether its env keys exist.
  `GET /api/providers` surfaces this so the dashboard Settings can render active vs available.

## 6. Dashboard (the product) sections , `app.html` + `app.js`

A single-page app shell (hash routing), premium dark, matches brand.css. Gate behind auth:
unauthenticated shows a polished login/signup card; authenticated shows the console:
1. **Overview** , greeting, live provider health chips, usage sparkline, quick actions.
2. **Agents** , grid of the tenant's agents, an agent builder (name, persona, voice model+speaker+pitch,
   greeting, assigned DID), live voice preview button per agent (calls /api/tts), edit + delete.
3. **Voice Studio** , text in, pick model (muga tones / mulberry speaker+pitch+description), synthesize
   (calls /api/tts), waveform + audio player, shows chars + cost. Optional streaming via /api/ws-connect.
4. **Talk to it** , live loop: mic (Web Speech API where available, else /api/stt fallback) -> /api/chat
   -> /api/tts playback, using the selected agent persona + voice. Text box fallback for non-Chromium.
5. **Telephony** , /api/telephony/status panel (wallet, DIDs, routing, engine health). Outbound dial form,
   GUARDED with an explicit confirm modal that states it places a REAL paid call. Inbound note.
6. **Settings** , provider registry (/api/providers): show TTS/LLM/Telephony providers, which is active,
   which is ready-to-wire and what env it needs (this is where Zoom/Twilio/ElevenLabs/Claude appear).
   Tenant name + brand color. Logout.

## 7. Marketing landing (`index.html`) , follow Shreyas's landing formula EXACTLY

Order: (1) Hero with one sharp promise + dual CTA + live waveform/orb motif.
(2) Benefits / how we help (concrete: 20x cheaper, provider-agnostic, multi-tenant, real telephony, sub-2s, INR-billed).
(3) Testimonial section (structure to take real ones later; use tasteful branded placeholder quote cards
    with deterministic gradient-initial avatars, NEVER random stock faces; mark as sample).
(4) Two benefit sections after testimonials (e.g. "How it works" 3-step, and "Built for agencies" multi-tenant value).
(5) Second testimonial section (text/logo style).
(6) Closing strong section with the final CTA (founder/product framing) + the economics proof (₹1 vs ₹20).
Then FAQ, then footer. Sticky premium nav with a "Launch console" CTA linking to `/app.html`.
All images are deterministic on-brand SVG (gradient + label), never random stock services.
Include an image guard in marketing.js that swaps any failed `<img>` to a branded SVG data-URI.
End marketing.js with a self-check that force-shows anything stuck at opacity 0 and logs broken imgs.

## 8. Edge cases every agent must handle

Auth: duplicate email (409), bad creds (401), missing session (401), tampered cookie (treated as no session),
expired session (401 + clear). Tenant isolation: cross-tenant agent access -> 403. TTS: empty text (422),
over 2000 chars (truncate), Rumik 403 UA (UA already set, never remove), Rumik non-200 -> surface detail.
LLM: empty messages (422), upstream error -> friendly message. Telephony: dial without confirm (400),
bad number (422), wallet/engine down -> clear status. Concurrency: double agent-create -> distinct ids;
atomic db writes. Fresh machine: data/ + db.json auto-created and seeded. Corrupt db.json -> try/catch to default.
Port in use -> clear console error. XSS: escape persona/name/email when rendered in the DOM.
No-JS marketing page -> all copy + headings render. JS-off app -> graceful "enable JavaScript" notice.

## 9. Done = verified

Server boots clean, /api/health all true, signup+login works, agent create+preview works (real Rumik WAV),
talk-to-it returns a real Gemini reply, telephony status returns the live VoiceLink wallet, landing renders
with zero console errors on desktop + 390px mobile, no element stuck at opacity 0, no broken images,
no em dashes anywhere. Verified in a real browser (Playwright), not by curl alone.

