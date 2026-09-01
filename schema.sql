-- Core schema for GetQualify Voice
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
  subject_user_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Client settings and notifications (Phase 1 Additions)
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

-- Extra tables needed based on legacy JSON schema
CREATE TABLE payment_intents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id),
  amount_paise INTEGER NOT NULL,
  currency TEXT DEFAULT 'INR',
  pack_id TEXT,
  status TEXT DEFAULT 'created',
  txnid TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE payment_events (
  id TEXT PRIMARY KEY,
  provider TEXT,
  tenant_id TEXT REFERENCES tenants(id),
  payment_intent_id TEXT,
  txnid TEXT,
  status TEXT,
  reason TEXT,
  payload JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE support_tickets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id),
  subject TEXT NOT NULL,
  status TEXT DEFAULT 'open',
  priority TEXT DEFAULT 'normal',
  assigned_to TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE support_messages (
  id TEXT PRIMARY KEY,
  ticket_id TEXT REFERENCES support_tickets(id),
  user_id TEXT,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE demo_links (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id),
  agent_id TEXT REFERENCES agents(id),
  preset_id TEXT,
  name TEXT NOT NULL,
  max_calls INTEGER DEFAULT 5,
  calls_made INTEGER DEFAULT 0,
  expires_at TIMESTAMPTZ,
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

-- =============================================================================
-- Extended tables (approved 2026-09-01): presets, byon_connections, hvac_jobs,
-- hvac_settings, invoice_events, integration_requests, agency_prompts,
-- tenant_status_events, client_activities
-- =============================================================================

CREATE TABLE presets (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT REFERENCES tenants(id),
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
CREATE INDEX idx_presets_tenant ON presets(tenant_id);

CREATE TABLE byon_connections (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT REFERENCES tenants(id),
  provider    TEXT NOT NULL,
  address     TEXT NOT NULL,
  label       TEXT,
  status      TEXT DEFAULT 'pending_verification',
  credentials JSONB DEFAULT '{}',
  created_by  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_byon_tenant ON byon_connections(tenant_id);

CREATE TABLE hvac_jobs (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT REFERENCES tenants(id),
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
CREATE INDEX idx_hvac_jobs_tenant ON hvac_jobs(tenant_id);

CREATE TABLE hvac_settings (
  tenant_id  TEXT PRIMARY KEY REFERENCES tenants(id),
  settings   JSONB DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE invoice_events (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT REFERENCES tenants(id),
  invoice_id    TEXT REFERENCES invoices(id),
  type          TEXT NOT NULL,
  actor_user_id TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_invoice_events_tenant  ON invoice_events(tenant_id);
CREATE INDEX idx_invoice_events_invoice ON invoice_events(invoice_id);

CREATE TABLE integration_requests (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT REFERENCES tenants(id),
  integration_id TEXT NOT NULL,
  status         TEXT DEFAULT 'requested',
  created_by     TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_integration_requests_tenant ON integration_requests(tenant_id);

CREATE TABLE agency_prompts (
  tenant_id  TEXT PRIMARY KEY REFERENCES tenants(id),
  text       TEXT NOT NULL,
  version    INTEGER DEFAULT 1,
  updated_by TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE tenant_status_events (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT REFERENCES tenants(id),
  from_status   TEXT,
  to_status     TEXT NOT NULL,
  reason        TEXT,
  actor_user_id TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_tenant_status_events_tenant ON tenant_status_events(tenant_id);

CREATE TABLE client_activities (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT REFERENCES tenants(id),
  type          TEXT NOT NULL,
  channel       TEXT,
  visibility    TEXT DEFAULT 'internal',
  summary       TEXT,
  actor_user_id TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_client_activities_tenant ON client_activities(tenant_id);
