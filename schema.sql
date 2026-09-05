-- Core schema for GetQualify Voice
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  branding JSONB DEFAULT '{}',
  providers JSONB DEFAULT '{}',
  plan TEXT DEFAULT 'studio',
  status TEXT DEFAULT 'active',
  privacy_mode TEXT DEFAULT 'standard',
  last_approached_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  pass_hash TEXT NOT NULL,
  role TEXT DEFAULT 'member',
  status TEXT DEFAULT 'active',
  verified BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  persona TEXT,
  tts JSONB DEFAULT '{}',
  greeting TEXT,
  telephony JSONB DEFAULT '{}',
  preset_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  recording_url TEXT,
  transcript TEXT,
  duration_seconds INTEGER DEFAULT 0,
  cost_paise INTEGER DEFAULT 0,
  status TEXT DEFAULT 'completed',
  caller_number TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS usage (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  chars INTEGER DEFAULT 0,
  calls INTEGER DEFAULT 0,
  llm_tokens INTEGER DEFAULT 0,
  UNIQUE(tenant_id, day)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  exp BIGINT NOT NULL,
  impersonator_user_id TEXT,
  impersonation_reason TEXT
);

CREATE TABLE IF NOT EXISTS wallets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  currency TEXT DEFAULT 'INR',
  balance_paise INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ledger (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  amount_paise INTEGER NOT NULL,
  balance_after_paise INTEGER NOT NULL,
  idempotency_key TEXT UNIQUE,
  actor_user_id TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
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

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  actor_user_id TEXT,
  subject_user_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Client settings and notifications (Phase 1 Additions)
CREATE TABLE IF NOT EXISTS client_settings (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  industry TEXT,
  timezone TEXT DEFAULT 'Asia/Kolkata',
  business_hours JSONB DEFAULT '{}',
  knowledge_base TEXT DEFAULT '',
  custom_fields JSONB DEFAULT '{}',
  calendar_provider TEXT,
  calendar_credentials_enc TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  recipient_email TEXT,
  subject TEXT,
  status TEXT DEFAULT 'pending',
  sendgrid_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS call_recordings (
  id TEXT PRIMARY KEY,
  call_id TEXT REFERENCES calls(id) ON DELETE CASCADE,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  s3_key TEXT NOT NULL,
  duration_seconds INTEGER,
  size_bytes BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Payment and billing tables
CREATE TABLE IF NOT EXISTS payment_intents (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  user_id         TEXT REFERENCES users(id) ON DELETE SET NULL,
  provider        TEXT DEFAULT 'payu',
  txnid           TEXT,
  pack_id         TEXT,
  product_info    TEXT,
  amount          NUMERIC(10, 2),
  amount_paise    INTEGER NOT NULL,
  credits         INTEGER DEFAULT 0,
  customer        JSONB DEFAULT '{}',
  gateway_payload JSONB DEFAULT '{}',
  intent_token    TEXT,
  payu_id         TEXT,
  status          TEXT DEFAULT 'created',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'payu';
ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS product_info TEXT;
ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS amount NUMERIC(10, 2);
ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS credits INTEGER DEFAULT 0;
ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS customer JSONB DEFAULT '{}';
ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS gateway_payload JSONB DEFAULT '{}';
ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS intent_token TEXT;
ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS payu_id TEXT;
ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE TABLE IF NOT EXISTS payment_events (
  id TEXT PRIMARY KEY,
  provider TEXT,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  payment_intent_id TEXT,
  txnid TEXT,
  status TEXT,
  reason TEXT,
  payload JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  status TEXT DEFAULT 'open',
  priority TEXT DEFAULT 'normal',
  assigned_to TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS support_messages (
  id TEXT PRIMARY KEY,
  ticket_id TEXT REFERENCES support_tickets(id) ON DELETE CASCADE,
  user_id TEXT,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS demo_links (
  id TEXT PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  starts INTEGER DEFAULT 0,
  max_starts INTEGER DEFAULT 25,
  max_session_seconds INTEGER DEFAULT 300,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_demo_links_tenant ON demo_links(tenant_id);

-- Indexes for multi-tenant queries
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_agents_tenant ON agents(tenant_id);
CREATE INDEX IF NOT EXISTS idx_calls_tenant ON calls(tenant_id);
CREATE INDEX IF NOT EXISTS idx_usage_tenant_day ON usage(tenant_id, day);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(exp);
CREATE INDEX IF NOT EXISTS idx_sessions_tenant ON sessions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_invoices_tenant ON invoices(tenant_id);
CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_events(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ledger_tenant ON ledger(tenant_id);
CREATE INDEX IF NOT EXISTS idx_notifications_tenant ON notifications(tenant_id);
CREATE INDEX IF NOT EXISTS idx_call_recordings_tenant ON call_recordings(tenant_id);
CREATE INDEX IF NOT EXISTS idx_call_recordings_call ON call_recordings(call_id);
CREATE INDEX IF NOT EXISTS idx_payment_intents_tenant ON payment_intents(tenant_id);
CREATE INDEX IF NOT EXISTS idx_payment_events_tenant ON payment_events(tenant_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_tenant ON support_tickets(tenant_id);
CREATE INDEX IF NOT EXISTS idx_support_messages_ticket ON support_messages(ticket_id);

-- =============================================================================
-- Extended tables (approved 2026-09-01): presets, byon_connections, hvac_jobs,
-- hvac_settings, invoice_events, integration_requests, agency_prompts,
-- tenant_status_events, client_activities
-- =============================================================================

CREATE TABLE IF NOT EXISTS presets (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  slug        TEXT,
  name        TEXT NOT NULL,
  category    TEXT,
  version     INTEGER DEFAULT 1,
  is_system   BOOLEAN DEFAULT FALSE,
  greeting    TEXT,
  persona     TEXT,
  fields      JSONB DEFAULT '[]',
  guardrails  JSONB DEFAULT '[]',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_presets_tenant ON presets(tenant_id);

CREATE TABLE IF NOT EXISTS byon_connections (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,
  address     TEXT NOT NULL,
  label       TEXT,
  status      TEXT DEFAULT 'pending_verification',
  credentials JSONB DEFAULT '{}',
  created_by  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_byon_tenant ON byon_connections(tenant_id);

CREATE TABLE IF NOT EXISTS hvac_jobs (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  caller_name  TEXT,
  phone        TEXT,
  email        TEXT,
  service      TEXT DEFAULT 'General HVAC',
  urgency      TEXT DEFAULT 'normal',
  outcome      TEXT DEFAULT 'new',
  assigned_to  TEXT,
  notes        TEXT,
  appointment  JSONB DEFAULT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hvac_jobs_tenant ON hvac_jobs(tenant_id);

CREATE TABLE IF NOT EXISTS hvac_settings (
  tenant_id  TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  settings   JSONB DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS invoice_events (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id    TEXT REFERENCES invoices(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  actor_user_id TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_invoice_events_tenant  ON invoice_events(tenant_id);
CREATE INDEX IF NOT EXISTS idx_invoice_events_invoice ON invoice_events(invoice_id);

CREATE TABLE IF NOT EXISTS integration_requests (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  integration_id TEXT NOT NULL,
  status         TEXT DEFAULT 'requested',
  created_by     TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_integration_requests_tenant ON integration_requests(tenant_id);

CREATE TABLE IF NOT EXISTS agency_prompts (
  tenant_id  TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  version    INTEGER DEFAULT 1,
  updated_by TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tenant_status_events (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  from_status   TEXT,
  to_status     TEXT NOT NULL,
  reason        TEXT,
  actor_user_id TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tenant_status_events_tenant ON tenant_status_events(tenant_id);

CREATE TABLE IF NOT EXISTS client_activities (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  channel       TEXT,
  visibility    TEXT DEFAULT 'internal',
  summary       TEXT,
  actor_user_id TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_client_activities_tenant ON client_activities(tenant_id);

CREATE TABLE IF NOT EXISTS leads (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  name         TEXT,
  phone        TEXT,
  email        TEXT,
  source       TEXT DEFAULT 'inbound_call',
  status       TEXT DEFAULT 'new',
  notes        TEXT DEFAULT '',
  assigned_to  TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_leads_tenant ON leads(tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_phone ON leads(tenant_id, phone);

ALTER TABLE calls     ADD COLUMN IF NOT EXISTS lead_id TEXT REFERENCES leads(id) ON DELETE SET NULL;
ALTER TABLE hvac_jobs ADD COLUMN IF NOT EXISTS lead_id TEXT REFERENCES leads(id) ON DELETE SET NULL;

-- =============================================================================
-- Phase 7: Enhanced CRM pipeline fields (additive ALTER, safe to re-run)
-- =============================================================================

ALTER TABLE leads ADD COLUMN IF NOT EXISTS pipeline_stage       TEXT DEFAULT 'new';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS pipeline_updated_at  TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS value_paise          INTEGER DEFAULT 0;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS expected_close_date  DATE;

CREATE INDEX IF NOT EXISTS idx_leads_pipeline_stage ON leads(tenant_id, pipeline_stage);
CREATE INDEX IF NOT EXISTS idx_leads_assigned_to    ON leads(tenant_id, assigned_to);

-- Per-lead activity timeline (notes, stage changes, assignments, calls, emails)
CREATE TABLE IF NOT EXISTS lead_activities (
  id            TEXT PRIMARY KEY,
  lead_id       TEXT REFERENCES leads(id) ON DELETE CASCADE,
  tenant_id     TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,       -- 'note' | 'call' | 'stage_change' | 'assignment' | 'email' | 'meeting'
  summary       TEXT,
  metadata      JSONB DEFAULT '{}',
  actor_user_id TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lead_activities_lead   ON lead_activities(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_activities_tenant ON lead_activities(tenant_id);

-- Zapier/n8n outbound webhook subscriptions per tenant
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  url           TEXT NOT NULL,
  events        TEXT[] DEFAULT '{}',
  secret        TEXT NOT NULL,
  status        TEXT DEFAULT 'active',
  failure_count INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_tenant ON webhook_endpoints(tenant_id);

-- BullMQ outbound call audit trail
CREATE TABLE IF NOT EXISTS outbound_jobs (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id     TEXT REFERENCES agents(id) ON DELETE SET NULL,
  phone_number TEXT NOT NULL,
  scheduled_at TIMESTAMPTZ,
  status       TEXT DEFAULT 'queued',
  attempts     INTEGER DEFAULT 0,
  last_error   TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_outbound_jobs_tenant ON outbound_jobs(tenant_id);

CREATE TABLE IF NOT EXISTS email_otps (
  email VARCHAR(255) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  otp_hash TEXT NOT NULL,
  exp BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
