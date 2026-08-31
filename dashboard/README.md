<div align="center">
  <img src="public/assets/logo.svg" alt="GetQualify" width="300" />
</div>

# GetQualify

**Production AI voice agents at roughly one rupee.** A premium, multi-tenant, provider-agnostic voice agent platform. Powered by Rumik silk TTS, about 20x cheaper than ElevenLabs, with a swappable engine so you are never locked into one TTS, LLM, or telephony vendor.

It runs from one Node service. The product shell is dependency-free browser JavaScript, while the agency analytics island is compiled from React and Recharts into a self-hosted bundle. No CDN runtime is required.

## Quick start (3 commands)

```sh
cp .env.example .env     # then fill in your keys (see below)
pnpm install             # installs runtime and build dependencies
pnpm build               # compiles the Recharts analytics island
sh setup.sh              # checks Node, creates data/, prints next steps
node server.js           # serves the site and API on http://localhost:8787
```

Open `http://localhost:8787` and log in.

### Create the first account

Open the app and use Sign up to create an isolated tenant. For automated QA or a private admin bootstrap, set `TEST_USER_EMAIL`, a password of at least 12 characters, and optionally `TEST_USER_SUPER_ADMIN=true` before the first start. No shared default credential is shipped.

## What "provider agnostic" means

The product is built around strict adapter registries. The LLM and TTS layers accept the same internal contracts regardless of vendor, while secrets remain server-side. Provider and model IDs can be selected through trusted configuration without accepting an API key from a tenant or browser request. Unsupported IDs, malformed model IDs, and non-allowlisted models fail closed.

| Layer | Implemented today | Selection |
| --- | --- | --- |
| **Transcription (STT)** | Deepgram Nova-3, batch and live streaming | Intentionally fixed to Deepgram |
| **Voice (TTS)** | Rumik silk, Muga and Mulberry | `TTS_PROVIDER`, `TTS_MODEL` |
| **Brain (LLM)** | Groq and Google Gemini | `LLM_PROVIDER`, `LLM_MODEL` |
| **Telephony** | VoBiz through Dograh | `TELEPHONY_PROVIDER` |

`GET /api/providers` reports only adapters that actually ship in this repository. It never labels a placeholder as live. The response includes selected and configured state, model IDs, and required environment variable names, but never secret values.

To add another LLM or TTS vendor, implement the layer methods in `lib/providers.js`, register the adapter with `registerProvider`, and add mocked contract tests. A TTS adapter implements `synthesize` and `wsConnect`. An LLM adapter implements `chat`. STT remains Deepgram-only by product decision.

Rumik is the only TTS adapter implemented in this repository today. The contract is vendor-neutral, but the Settings screen does not claim that ElevenLabs, Sarvam, or another TTS works until its adapter and tests are shipped.

Example server defaults:

```dotenv
LLM_PROVIDER=gemini
LLM_MODEL=gemini-2.5-flash
TTS_PROVIDER=rumik
TTS_MODEL=mulberry
```

Optional `GROQ_ALLOWED_MODELS` and `GEMINI_ALLOWED_MODELS` comma-separated lists restrict model selection. When an allowlist exists, any model outside it is rejected before an upstream request.

### Browser and phone workflow authority

Dograh's published workflow is the authority for both browser WebRTC calls and phone calls. `LLM_PROVIDER` and `TTS_PROVIDER` configure dashboard-owned `/api/chat` and `/api/tts` requests. They do not rewrite an already published Dograh workflow. Per-agent or per-tenant switching inside a live call requires a distinct tenant-scoped Dograh workflow binding whose nodes use the chosen providers. Do not present a dashboard selection as active on an embed until that workflow binding exists.

## The economics

The whole pitch is the price. Rumik silk bills per character at promo rates that land a normal agent reply near **one rupee**, against roughly **twenty rupees** for the same on ElevenLabs. Usage is metered per tenant per day (characters, calls, LLM tokens) and surfaced as an INR cost in the dashboard, so the savings are visible, not a marketing claim.

## What you can do in the console

- **Overview** with live provider health, usage, and quick actions.
- **Agency overview** with invoice-backed revenue, outstanding receivables, client activity, lifecycle distribution, and Recharts visualizations for platform roles.
- **Clients** with lifecycle status, activity logs, wallet visibility, outstanding invoices, and explicit approach records.
- **Invoices** with tenant-scoped draft, issue, paid, overdue, and void states. Stored issue status does not claim that an email was sent.
- **Integrations** with truthful setup request states for WhatsApp Business Cloud and the Meta Ad Library API. No external connection is claimed until credentials and a live adapter exist.
- **Agency prompt** with a versioned, persistent operating instruction. It does not authorize messages, calls, payments, or other external actions.
- **Agents**: build an agent (persona, voice model, speaker, pitch, greeting, assigned phone number) and preview its real voice in one click.
- **Voice Studio**: type text, pick a model and voice, synthesize a real WAV, see the character count and cost.
- **Talk to it**: a direct browser voice call through Dograh SmallWebRTC, using the same published workflow and latency path as telephony. The Studio does not render transcript text in this mode.
- **Telephony**: live VoBiz configuration and number status from Dograh, plus a guarded outbound dial through Dograh.
- **SaaS controls**: isolated tenants, roles, presets, INR wallets, support tickets, privacy modes, BYON requests, audit history, and a super-admin workspace.
- **Billing**: PayU hosted-checkout signing and idempotent callbacks. Keep `PAYU_ENV=test` until the production checklist is complete.
- **HVAC Desk**: tenant-scoped call outcomes, dispatch routing, CSV export, and optional Cal.com availability and booking.
- **Settings**: the provider registry, tenant branding, and logout.

## Security notes

- All provider keys live in `.env`, which is gitignored. **Keys never reach the browser.** The authenticated backend proxies Deepgram live audio, talks to Groq and Rumik, and delegates VoBiz to Dograh.
- Passwords are hashed with `crypto.scryptSync` and a per-user random salt. Never stored in plaintext.
- Sessions are opaque random tokens in an httpOnly cookie, with a 7 day expiry.
- Strict tenant isolation: every read and write is scoped to the session's tenant. A cross-tenant access returns 403.
- Any user-supplied string (name, email, persona) is escaped before it is rendered into the DOM.
- Outbound phone calls are guarded. A real, paid call only goes out with an explicit confirm, never automatically.

## Deploy

Runs anywhere Node runs. The natural home is the Hostinger VPS so the secret keys stay server-side and close to users. Do not host the keys on a static site. Never run the realtime server under a file watcher, watchers fire restarts as the OS touches files and drop live sockets.

## Important production boundary

The bundled JSON store is suitable for local evaluation, demos, and one Node process. Before accepting customer money or running multiple replicas, move wallets, payment intents, memberships, and audit events to transactional PostgreSQL and complete the unchecked items in [`SAAS-QA-CHECKLIST.md`](SAAS-QA-CHECKLIST.md).

Built for GetQualify. MIT licensed. No em dashes anywhere in this codebase.
