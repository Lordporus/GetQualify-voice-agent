# GetQualify Voice Agent Stack - Production Deployment & Integration Guide

> **Target**: Reusable AI agency template for local service businesses.
> **Scale**: 1-3 clients initially, 50+ clients within 6 months.
> **Expected load**: 100-500 calls/month per client.

---

## TASK 1: TOP 3 CRITICAL FIXES

### FIX 1: JSON File DB Cannot Scale Past ~5 Clients

| Detail | Value |
|---|---|
| **File** | [core.js](file:///c:/Users/Sachin/OneDrive/Desktop/GetQualify-voice-agent-stack-main/getqualify-voice-agent-stack-main/dashboard/lib/core.js#L150-L256) |
| **Current behavior** | All data (tenants, agents, calls, sessions, ledger, invoices, audit) stored in a single `data/db.json` file. Every write serializes the entire DB to disk with `fs.writeFileSync`. |
| **Why it blocks** | At 10+ tenants with active call logs, `db.json` grows to 50MB+. Every mutation (session, usage bump, audit event) rewrites the whole file. Concurrent calls cause I/O bottleneck. A crash mid-write corrupts all tenant data. No query indexes, no backups, no ACID transactions. |
| **Effort** | 16-24 hours |

**Fix**: Migrate to PostgreSQL with the existing data model as tables.

```sql
-- Core schema (mirrors defaultDb() collections in core.js L165-L174)
CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  branding JSONB DEFAULT '{}',
  providers JSONB DEFAULT '{}',
  plan TEXT DEFAULT 'studio',
  status TEXT DEFAULT 'active',
  privacy_mode TEXT DEFAULT 'standard',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id),
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  pass_hash TEXT NOT NULL,
  role TEXT DEFAULT 'member',
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id),
  name TEXT NOT NULL,
  persona TEXT,
  tts JSONB DEFAULT '{}',
  greeting TEXT,
  telephony JSONB DEFAULT '{}',
  preset_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE calls (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id),
  agent_id TEXT REFERENCES agents(id),
  recording_url TEXT,
  transcript TEXT,
  duration_seconds INTEGER DEFAULT 0,
  cost_paise INTEGER DEFAULT 0,
  status TEXT DEFAULT 'completed',
  caller_number TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE usage (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id),
  day DATE NOT NULL,
  chars INTEGER DEFAULT 0,
  calls INTEGER DEFAULT 0,
  llm_tokens INTEGER DEFAULT 0,
  UNIQUE(tenant_id, day)
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  tenant_id TEXT REFERENCES tenants(id),
  exp BIGINT NOT NULL,
  impersonator_user_id TEXT,
  impersonation_reason TEXT
);

CREATE TABLE wallets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT UNIQUE REFERENCES tenants(id),
  currency TEXT DEFAULT 'INR',
  balance_paise INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE ledger (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id),
  type TEXT NOT NULL,
  amount_paise INTEGER NOT NULL,
  balance_after_paise INTEGER NOT NULL,
  idempotency_key TEXT UNIQUE,
  actor_user_id TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id),
  invoice_number TEXT UNIQUE,
  client_name TEXT,
  client_email TEXT,
  description TEXT,
  amount_paise INTEGER NOT NULL,
  currency TEXT DEFAULT 'INR',
  issue_date DATE,
  due_date DATE,
  status TEXT DEFAULT 'draft',
  delivery_status TEXT DEFAULT 'not_sent',
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id),
  actor_user_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for multi-tenant queries
CREATE INDEX idx_users_tenant ON users(tenant_id);
CREATE INDEX idx_agents_tenant ON agents(tenant_id);
CREATE INDEX idx_calls_tenant ON calls(tenant_id);
CREATE INDEX idx_usage_tenant_day ON usage(tenant_id, day);
CREATE INDEX idx_sessions_exp ON sessions(exp);
CREATE INDEX idx_invoices_tenant ON invoices(tenant_id);
CREATE INDEX idx_audit_tenant ON audit_events(tenant_id);
CREATE INDEX idx_ledger_tenant ON ledger(tenant_id);
```

**Migration strategy**: Create a `lib/db.js` adapter that wraps `pg` with the same `db()` and `mutate()` API. Keep `core.js` unchanged. Feature-flag with `DB_DRIVER=postgres|json`.

---

### FIX 2: No Client Templating / Onboarding Automation

| Detail | Value |
|---|---|
| **File** | [server.js L1292-L1320](file:///c:/Users/Sachin/OneDrive/Desktop/GetQualify-voice-agent-stack-main/getqualify-voice-agent-stack-main/dashboard/server.js#L1292-L1320) (`apiAdminTenantCreate`) |
| **Current behavior** | Creating a client workspace requires manual API call with name + owner email + password. No industry template, no business hours, no knowledge base, no greeting customization flow. |
| **Why it blocks** | Every new client (dental, legal, HVAC) needs manual agent creation, prompt writing, and voice config. No white-label, no self-service onboarding. At 10+ clients, this is a full-time job. |
| **Effort** | 12-16 hours |

**Fix**: Add an `industry_templates` system and a `POST /api/admin/tenants/provision` endpoint.

```js
// New endpoint: POST /api/admin/tenants/provision
// Body: { name, ownerEmail, password, industry, businessHours, knowledgeBase }

const INDUSTRY_TEMPLATES = {
  dental: {
    presetId: 'preset_dental_receptionist_v1',
    defaultGreeting: 'Thank you for calling {business_name}. How can I help you today?',
    defaultPersona: 'You are a friendly dental receptionist for {business_name}. ...',
    fields: ['caller_name', 'callback_number', 'reason', 'insurance', 'preferred_appointment'],
    defaultHours: { mon: '09:00-17:00', tue: '09:00-17:00', wed: '09:00-17:00',
                    thu: '09:00-17:00', fri: '09:00-14:00' },
  },
  legal: { presetId: 'preset_personal_injury_v1', /* ... */ },
  hvac: { /* reuse HVAC desk */ },
  real_estate: { presetId: 'preset_real_estate_v1', /* ... */ },
  restaurant: { presetId: 'preset_restaurant_v1', /* ... */ },
  med_spa: { /* new preset needed */ },
};

async function apiAdminTenantProvision(req, res, ctx) {
  const b = ctx.body || {};
  const template = INDUSTRY_TEMPLATES[b.industry];
  if (!template) return core.sendJson(res, 422, { error: 'unknown industry' });

  // 1. Create tenant (existing logic from apiAdminTenantCreate)
  // 2. Create owner user (existing logic)
  // 3. Auto-create agent from industry template with {business_name} substitution
  // 4. Store business_hours + knowledge_base in tenant settings
  // 5. Return { tenant, owner, agent, demoLink }
}
```

Add a `clientSettings` collection to the DB:
```js
// In defaultDb(), add:
clientSettings: [],

// Schema per entry:
{
  tenantId: 't_xxx',
  industry: 'dental',
  timezone: 'Asia/Kolkata',
  businessHours: { mon: '09:00-17:00', /* ... */ },
  knowledgeBase: 'We accept most dental insurance...',
  customFields: { /* client-specific */ },
}
```

---

### FIX 3: Hardcoded Indian Telephony (VoBiz-Only, +91 Only)

| Detail | Value |
|---|---|
| **File** | [providers.js L491-L500](file:///c:/Users/Sachin/OneDrive/Desktop/GetQualify-voice-agent-stack-main/getqualify-voice-agent-stack-main/dashboard/lib/providers.js#L491-L500) |
| **Current behavior** | `dial()` strips to 10 digits, hardcodes `+91` prefix. Only VoBiz through Dograh is supported. No Twilio, no US/UK numbers. |
| **Why it blocks** | Cannot serve US/UK clients. Cannot offer local numbers in other countries. The 10-digit validation rejects all non-Indian numbers. |
| **Effort** | 8-12 hours |

**Fix**: Make phone validation country-aware and add a Twilio adapter stub.

```diff
  // providers.js L491-L500
  async dial(rawNumber, options = {}) {
    if (!hasEnv(this.needs)) throw notConfigured(this.label, this.needs);
-   let num = String(rawNumber || '').replace(/[^0-9]/g, '');
-   if (num.length === 12 && num.startsWith('91')) num = num.slice(2);
-   if (num.length !== 10) {
-     throw new ProviderError('need a 10-digit Indian mobile (national format)', 422, 'bad_number');
-   }
+   let num = String(rawNumber || '').replace(/[^0-9+]/g, '');
+   // Normalize: if starts with country code, keep E.164. Otherwise assume India.
+   if (num.startsWith('+')) {
+     if (num.length < 10 || num.length > 16) {
+       throw new ProviderError('invalid phone number (E.164 format required)', 422, 'bad_number');
+     }
+   } else {
+     num = num.replace(/[^0-9]/g, '');
+     if (num.length === 12 && num.startsWith('91')) num = num.slice(2);
+     if (num.length !== 10) {
+       throw new ProviderError('need a 10-digit number or E.164 format (+countrycode...)', 422, 'bad_number');
+     }
+     num = '+91' + num;
+   }
    const result = await this.request('POST', '/api/v1/telephony/initiate-call', {
      workflow_id: ...,
      telephony_configuration_id: ...,
      from_phone_number_id: ...,
-     phone_number: '+91' + num,
+     phone_number: num,
    });
```

---

## TASK 2: FULL TECH STACK & DEPLOYMENT GUIDE

### A. Tech Stack

| Layer | Component | Tool | Version | Cost (USD/mo) | Purpose |
|---|---|---|---|---|---|
| **Voice** | Orchestration | Dograh | Self-hosted | VPS cost | Call flow, VAD, WebRTC |
| **Voice** | STT | Deepgram Nova-3 | API | ~$0.0043/min | Live transcription, Hinglish |
| **Voice** | LLM (Brain) | Groq (Llama 3.3 70B) | API | ~$0.59/1M tokens | Reasoning, conversation |
| **Voice** | LLM (Alt) | Google Gemini Flash | API | Free tier / $0.075/1M | Fallback brain |
| **Voice** | TTS | Rumik Silk (mulberry) | API | ~20x cheaper than 11Labs | Voice synthesis |
| **Voice** | Telephony | VoBiz (via Dograh) | API | Per-call (INR) | SIP, Indian numbers |
| **Backend** | Server | Node.js (zero-dep) | 18+ | - | API, auth, multi-tenant |
| **Backend** | WebSocket | ws | 8.21.2 | - | Deepgram STT proxy |
| **Backend** | DB (Current) | JSON file (db.json) | - | - | All state (migrate away) |
| **Backend** | DB (Target) | PostgreSQL 16 | - | Included in VPS | Relational, ACID |
| **Backend** | Payments | PayU India | API | Per-txn | INR credit packs |
| **Backend** | Calendar | Cal.com | API | Free/paid | HVAC appointment booking |
| **Frontend** | Marketing | Static HTML/CSS/JS | - | - | Landing page |
| **Frontend** | Dashboard | React 19 + Recharts | 19.1.1 | - | Agency OS console |
| **Frontend** | Build | esbuild | 0.25.9 | - | Chart bundle only |
| **DevOps** | VPS | Ubuntu 24.04 | 4GB RAM | $20-40 | Docker host |
| **DevOps** | Containers | Docker + Alpine Node | 20-alpine | - | Isolation |
| **DevOps** | SSL | sslip.io + Let's Encrypt | - | Free | HTTPS for mic access |
| **DevOps** | Deploy | Bash scripts (01-06) | - | - | Automated VPS setup |

### B. External Integrations (Phased)

#### PHASE 1: MVP (Week 1-4)

| Integration | API | Required Fields | Error Handling |
|---|---|---|---|
| **Google Calendar** | OAuth2 + Calendar API v3 | `client_id`, `client_secret`, `refresh_token` per tenant | Token refresh on 401, exponential backoff |
| **Email (SendGrid)** | REST API v3 | `SENDGRID_API_KEY`, template IDs | Retry 3x on 5xx, dead-letter queue |
| **PostgreSQL** | `pg` npm package | `DATABASE_URL` connection string | Connection pool (PgBouncer), auto-reconnect |
| **S3 (Call Recordings)** | AWS SDK v3 | `AWS_ACCESS_KEY`, `AWS_SECRET_KEY`, `S3_BUCKET` | Pre-signed URLs (24hr expiry), multipart upload |

- [ ] Google Calendar OAuth2 flow (get access token from client's Google account)
- [ ] Sync availability (GET `/calendars/{id}/freeBusy`)
- [ ] Auto-book appointments (POST `/calendars/{id}/events`)
- [ ] Handle timezone conversion (use `Intl.DateTimeFormat` with tenant timezone)
- [ ] SendGrid: booking confirmations, call transcripts, daily usage summary
- [ ] PostgreSQL: full schema (see Fix 1 above)
- [ ] S3: call recording upload with tenant-scoped prefix (`recordings/{tenantId}/{callId}.wav`)

#### PHASE 2: Scaling (Week 5-12)

| Integration | API | Purpose |
|---|---|---|
| **HubSpot CRM** | REST API v3 | Sync contacts, deals, call logs |
| **Razorpay** | REST API + Webhooks | Payment processing (INR) |
| **Twilio SMS** | REST API | Appointment reminders, follow-ups |

- [ ] CRM sync: POST call summary to HubSpot Engagements API after each call
- [ ] Razorpay: Replace PayU for auto-invoicing. Webhook `payment.captured` credits wallet
- [ ] SMS: Send appointment confirmations via Twilio Messaging API

#### PHASE 3: Enterprise (Week 13+)

| Integration | API | Purpose |
|---|---|---|
| **Outbound Calling** | Dograh initiate-call API | Proactive appointment reminders |
| **WhatsApp Business** | Cloud API v18 | Booking confirmations, follow-ups |
| **Zapier/n8n** | Webhooks | Client-managed automations |

- [ ] Outbound: scheduled call queue with rate limiting (5 calls/min/tenant)
- [ ] WhatsApp: template messages only (Meta approval required)
- [ ] Webhook system: POST events to client-configured URLs

### C. Deployment Checklist

#### 1. VPS Setup

- [ ] Ubuntu 24.04 LTS, 4GB RAM, 80GB SSD
- [ ] Ports open: 22 (SSH), 80 (HTTP), 443 (HTTPS), 3478 (TURN), 5349 (TURNS), 49152-49200/UDP (media)
- [ ] SSH key: `ssh-keygen -t ed25519 -f ~/.ssh/GetQualify_deploy`
- [ ] Swap: 4GB (auto-created by `deploy/01-deploy-dograh.sh`)
- [ ] UFW configured (auto by deploy script)

#### 2. SSL/HTTPS

- [ ] **Method**: sslip.io wildcard (auto, zero DNS setup)
  - Format: `<dashed-IP>.sslip.io` (e.g., `203-0-113-10.sslip.io`)
  - Dograh's installer handles Let's Encrypt cert via Caddy/Traefik
- [ ] **Production**: Point `voice.yourdomain.com` A record to VPS IP
- [ ] **Renewal**: Auto (Caddy/Certbot cron, 60-day cycle)
- [ ] **Browser mic**: Requires HTTPS. localhost exempted for dev only

#### 3. Environment Secrets

- [ ] Copy `.env.example` to `dashboard/.env` (NOT project root `.env`)
- [ ] Fill all required keys (see table below)
- [ ] **Rotation schedule**: API keys quarterly, session secret on breach

| Key | Source | Required |
|---|---|---|
| `DEEPGRAM_API_KEY` | console.deepgram.com | Yes |
| `GROQ_API_KEY` | console.groq.com | Yes |
| `RUMIK_API_KEY` | rumik.ai | Yes |
| `DOGRAH_BASE_URL` | Your VPS HTTPS URL | Yes |
| `DOGRAH_API_KEY` | Dograh org settings | Yes |
| `DOGRAH_WORKFLOW_ID` | Output of `deploy/03-configure.sh` | Yes |
| `DOGRAH_TELEPHONY_CONFIG_ID` | Output of `deploy/03-configure.sh` | Yes |
| `DOGRAH_PHONE_NUMBER_ID` | Output of `deploy/03-configure.sh` | Yes |
| `DOGRAH_EMBED_TOKEN` | Dograh published workflow | For browser calls |
| `VOBIZ_AUTH_ID` | console.vobiz.ai | For telephony |
| `VOBIZ_AUTH_TOKEN` | console.vobiz.ai | For telephony |
| `VOBIZ_NUMBER` | VoBiz panel | For caller ID |
| `GEMINI_API_KEY` | aistudio.google.com | Optional LLM |
| `PAYU_KEY` / `PAYU_SALT` | PayU merchant panel | For payments |
| `CALCOM_API_KEY` | Cal.com dashboard | For booking |

#### 4. Database

- [ ] **Current**: `data/db.json` (works for 1-3 clients)
- [ ] **Phase 1 migration**:
  ```bash
  sudo apt install postgresql-16 postgresql-client-16
  sudo -u postgres createuser GetQualify --pwprompt
  sudo -u postgres createdb GetQualify_voice --owner=GetQualify
  psql -U GetQualify -d GetQualify_voice -f schema.sql
  ```
- [ ] **Backup**: `pg_dump GetQualify_voice | gzip > /backups/GetQualify_$(date +%Y%m%d).sql.gz`
- [ ] **Cron**: `0 3 * * * /opt/GetQualify-voice/scripts/backup-db.sh`
- [ ] **PgBouncer**: Install when > 20 concurrent connections

#### 5. Docker & Orchestration

- [ ] **docker-compose.yml** for local dev:
  ```yaml
  services:
    app:
      build: ./dashboard
      ports: ["8787:8787"]
      env_file: ./dashboard/.env
      volumes: ["./dashboard/data:/app/data"]
      restart: always
    postgres:
      image: postgres:16-alpine
      environment:
        POSTGRES_DB: GetQualify_voice
        POSTGRES_USER: GetQualify
        POSTGRES_PASSWORD: ${DB_PASSWORD}
      volumes: ["pgdata:/var/lib/postgresql/data"]
      ports: ["5432:5432"]
  volumes:
    pgdata:
  ```
- [ ] **GitHub Actions CI/CD**:
  ```yaml
  # .github/workflows/deploy.yml
  on:
    push:
      branches: [main]
  jobs:
    test:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with: { node-version: 20 }
        - run: cd dashboard && npm ci && npm test
    deploy:
      needs: test
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - run: bash deploy/06-deploy-dashboard.sh
          env:
            VPS_IP: ${{ secrets.VPS_IP }}
            SSH_KEY: ${{ secrets.SSH_KEY_PATH }}
  ```

#### 6. Monitoring & Alerts

- [ ] **Error logging**: Sentry (free tier, 5K events/mo)
- [ ] **Uptime**: UptimeRobot (free, 5-min checks on `GET /api/health`)
- [ ] **Alerts**: Email on HTTP 5xx spike, provider MISSING status
- [ ] **Logs**: `docker logs GetQualify-voice --follow` or ship to Grafana Loki

#### 7. Security (Current Status)

| Control | Status | Location |
|---|---|---|
| Rate limiting (90 req/60s/IP) | Done | [core.js L410-L420](file:///c:/Users/Sachin/OneDrive/Desktop/GetQualify-voice-agent-stack-main/getqualify-voice-agent-stack-main/dashboard/lib/core.js#L410-L420) |
| Session expiry (7-day TTL) | Done | [core.js L288](file:///c:/Users/Sachin/OneDrive/Desktop/GetQualify-voice-agent-stack-main/getqualify-voice-agent-stack-main/dashboard/lib/core.js#L288) |
| scrypt password hashing | Done | [core.js L268-L286](file:///c:/Users/Sachin/OneDrive/Desktop/GetQualify-voice-agent-stack-main/getqualify-voice-agent-stack-main/dashboard/lib/core.js#L268-L286) |
| Origin validation (CORS) | Done | [server.js L977-L989](file:///c:/Users/Sachin/OneDrive/Desktop/GetQualify-voice-agent-stack-main/getqualify-voice-agent-stack-main/dashboard/server.js#L977-L989) |
| XSS (htmlEscape) | Done | [core.js L141-L148](file:///c:/Users/Sachin/OneDrive/Desktop/GetQualify-voice-agent-stack-main/getqualify-voice-agent-stack-main/dashboard/lib/core.js#L141-L148) |
| Path traversal guard | Done | [core.js L446-L454](file:///c:/Users/Sachin/OneDrive/Desktop/GetQualify-voice-agent-stack-main/getqualify-voice-agent-stack-main/dashboard/lib/core.js#L446-L454) |
| Security headers (HSTS, CSP, etc.) | Done | [core.js L52-L59](file:///c:/Users/Sachin/OneDrive/Desktop/GetQualify-voice-agent-stack-main/getqualify-voice-agent-stack-main/dashboard/lib/core.js#L52-L59) |
| Secure cookie flag in production | **TODO** | Set `NODE_ENV=production` |
| CSRF tokens | **TODO** | Add for state-changing POST routes |
| Request ID for log correlation | **TODO** | Add `X-Request-Id` header |

### D. Deployment Steps (Shell Script Ready)

```bash
#!/usr/bin/env bash
# =============================================================================
# GetQualify Voice - Local Setup & Health Check
# Run from project root: bash setup-local.sh
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo "========================================="
echo "  GetQualify Voice - Local Setup"
echo "========================================="

# ---- 1. Prerequisites Check ----
echo ""
echo "==> Checking prerequisites..."
command -v node >/dev/null 2>&1 || { echo "FAIL: Node.js not found. Install Node 18+"; exit 1; }
NODE_MAJOR=$(node -v | sed 's/^v//' | cut -d. -f1)
[ "$NODE_MAJOR" -ge 18 ] || { echo "FAIL: Node $NODE_MAJOR found, need 18+"; exit 1; }
echo "  ok  Node $(node -v)"

# ---- 2. Environment Setup ----
echo ""
echo "==> Setting up environment..."
cd dashboard

if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    echo "  Created .env from .env.example"
    echo ""
    echo "  IMPORTANT: Edit dashboard/.env with your real API keys before continuing."
    echo "  Required: DEEPGRAM_API_KEY, GROQ_API_KEY, RUMIK_API_KEY"
    exit 1
  else
    echo "FAIL: No .env.example found"
    exit 1
  fi
fi
echo "  ok  .env present"

# ---- 3. Install dependencies ----
echo ""
echo "==> Installing dependencies..."
npm install 2>/dev/null
echo "  ok  Dependencies installed"

# ---- 4. Create data directory ----
mkdir -p data
echo "  ok  data/ directory ready"

# ---- 5. Run tests ----
echo ""
echo "==> Running tests..."
npm test || echo "WARN: Some tests failed. Review output above."

# ---- 6. Start server ----
echo ""
echo "========================================="
echo "  Local setup complete."
echo ""
echo "  Start:     cd dashboard && node server.js"
echo "  Console:   http://localhost:8787/app.html"
echo "  Marketing: http://localhost:8787/"
echo ""
echo "  For VPS deployment, run in order:"
echo "    bash deploy/01-deploy-dograh.sh"
echo "    bash deploy/02-build-rumik-overlay.sh"
echo "    bash deploy/03-configure.sh"
echo "    bash deploy/04-check-interrupts.sh"
echo "    bash deploy/05-place-call.sh"
echo "    bash deploy/06-deploy-dashboard.sh"
echo "========================================="
```

#### VPS Deployment (Existing Scripts)

The repo ships 6 sequential deploy scripts in [`deploy/`](file:///c:/Users/Sachin/OneDrive/Desktop/GetQualify-voice-agent-stack-main/getqualify-voice-agent-stack-main/deploy). Run in order:

| Step | Script | What It Does |
|---|---|---|
| 1 | `01-deploy-dograh.sh` | SSH to VPS, add swap, open firewall, install Dograh |
| 2 | `02-build-rumik-overlay.sh` | Build Rumik custom voice overlay |
| 3 | `03-configure.sh` | Create VoBiz telephony config, attach phone number, set model pipeline, create workflow |
| 4 | `04-check-interrupts.sh` | Verify VAD and interruption handling |
| 5 | `05-place-call.sh` | Place a test call to `TEST_NUMBER` |
| 6 | `06-deploy-dashboard.sh` | rsync dashboard to VPS, create `.env` server-side, run in Docker |

> [!IMPORTANT]
> After step 3, save `TELEPHONY_CONFIG_ID`, `PHONE_NUMBER_ID`, `WORKFLOW_ID` to your `.env`.

---

## TASK 3: INTEGRATION ROADMAP

### Google Calendar Integration

```
Endpoint: POST /api/integrations/calendar/connect
Auth:     OAuth2 (Google Cloud Console project)
Flow:     1. Redirect to Google consent screen
          2. Exchange auth code for access_token + refresh_token
          3. Store encrypted refresh_token per tenant
          4. Use Calendar API v3 for slot lookup and booking
```

| Operation | API Call | Fields |
|---|---|---|
| Check availability | `GET /calendars/{id}/freeBusy` | `timeMin`, `timeMax`, `timeZone` |
| Book appointment | `POST /calendars/{id}/events` | `summary`, `start.dateTime`, `end.dateTime`, `attendees[].email` |
| Cancel | `DELETE /calendars/{id}/events/{eventId}` | - |

**Error handling**:
- 401: Refresh token, retry once. If still 401, mark integration as `needs_reauth`
- 403: Calendar permissions revoked, notify client
- 409: Slot already taken, return next 3 available slots

**Timezone**: Store `tenant.timezone` (e.g., `America/New_York`). Convert all agent-spoken times to tenant's zone using `Intl.DateTimeFormat`.

### Email Notifications (SendGrid)

```
Endpoint:     POST /api/notifications/send
Provider:     SendGrid v3 Mail Send API
Auth:         Bearer token (SENDGRID_API_KEY)
```

| Email Type | Trigger | Template Variables |
|---|---|---|
| Booking confirmation | Calendar event created | `{client_name}`, `{appointment_time}`, `{agent_name}` |
| Call transcript | Call completed | `{caller_name}`, `{transcript}`, `{duration}`, `{summary}` |
| Daily usage summary | Cron (9 AM tenant timezone) | `{calls_today}`, `{chars_used}`, `{cost_inr}` |
| Invoice issued | Invoice status -> issued | `{invoice_number}`, `{amount}`, `{due_date}` |

### PostgreSQL Schema (Additional Tables for Phase 1)

```sql
CREATE TABLE client_settings (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
  industry TEXT,
  timezone TEXT DEFAULT 'Asia/Kolkata',
  business_hours JSONB DEFAULT '{}',
  knowledge_base TEXT DEFAULT '',
  custom_fields JSONB DEFAULT '{}',
  calendar_provider TEXT,
  calendar_credentials_enc TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id),
  type TEXT NOT NULL,
  recipient_email TEXT,
  subject TEXT,
  status TEXT DEFAULT 'pending',
  sendgrid_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE call_recordings (
  id TEXT PRIMARY KEY,
  call_id TEXT REFERENCES calls(id),
  tenant_id TEXT REFERENCES tenants(id),
  s3_key TEXT NOT NULL,
  duration_seconds INTEGER,
  size_bytes BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Phase 2+ Roadmap

#### CRM Sync (HubSpot)

```
Trigger:    After each completed call
Endpoint:   POST /crm/v3/objects/calls  (HubSpot)
Payload:    { hs_call_body: transcript, hs_call_duration: duration_ms,
              hs_call_direction: "INBOUND", hs_call_status: "COMPLETED" }
Auth:       OAuth2 per tenant (Private App token)
Frequency:  Real-time (webhook) or batch (every 15 min)
```

#### Payment Processing (Razorpay)

```
Webhook:    POST /api/webhooks/razorpay
Event:      payment.captured
Verify:     HMAC-SHA256 of body with webhook secret
Action:     Credit wallet (addLedgerEntry), update invoice status
```

#### Outbound Calls

```
Endpoint:   POST /api/telephony/outbound/schedule
Auth:       requireRole('owner')
Body:       { agentId, phoneNumber, scheduledAt, maxRetries: 2 }
Queue:      Bull/BullMQ with Redis (rate-limited: 5 calls/min/tenant)
```

---

## ESTIMATED TIMELINE

| Phase | Deliverable | Effort (hrs) | Dependencies |
|---|---|---|---|
| **Week 1-2** | Fix 1: PostgreSQL migration | 24 | `pg` npm package |
| **Week 2-3** | Fix 2: Industry templates + onboarding | 16 | DB migration |
| **Week 3** | Fix 3: E.164 phone support | 12 | None |
| **Week 3-4** | Google Calendar integration | 16 | OAuth2 setup |
| **Week 4** | SendGrid email notifications | 8 | API key |
| **Week 4** | S3 call recording storage | 8 | AWS account |
| **Week 5-6** | Docker Compose + CI/CD | 12 | GitHub Actions |
| **Week 6-8** | Monitoring (Sentry + UptimeRobot) | 4 | Accounts |
| **Week 8-12** | CRM sync (HubSpot) | 16 | Phase 1 complete |
| **Week 8-12** | Razorpay payments | 12 | Merchant account |
| **Week 13+** | WhatsApp Business + Outbound | 24 | Meta verification |

**Total Phase 1 (production-ready for 3 clients)**: ~100 hours / 4-5 weeks
**Total Phase 2 (scaling to 50 clients)**: ~52 hours / 4-6 weeks
**Total Phase 3 (enterprise features)**: ~24 hours / ongoing

