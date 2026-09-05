/**
 * GetQualify. Zero-dependency Node server (the product, multi-tenant).
 *
 * Pure Node http/https/crypto/fs. No npm, no build step, no framework. Run with
 * `node server.js` and it serves the JSON API plus the static public/ site on
 * PORT (default 8787). Secrets stay server side, runtime state lives in data/.
 *
 * Routes are EXACTLY per SPEC section 4. Every agents/usage/telephony route is
 * tenant scoped through the session. The live provider calls (Deepgram, Groq, Rumik,
 * VoBiz through Dograh) are isolated in lib/providers.js.
 *
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const core = require('./lib/core');
core.loadEnv();

// ---- Sentry Error Tracking (optional) ----
let Sentry = null;
if (process.env.SENTRY_DSN) {
  try {
    Sentry = require('@sentry/node');
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV || 'development',
      tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.2 : 1.0,
      beforeSend(event) {
        if (event && event.request && event.request.headers) {
          delete event.request.headers['authorization'];
          delete event.request.headers['cookie'];
          delete event.request.headers['x-dograh-webhook-secret'];
        }
        return event;
      },
    });
  } catch (err) {
    console.error('Failed to initialize Sentry:', err.message);
  }
}

process.on('unhandledRejection', (err) => {
  if (Sentry) Sentry.captureException(err);
  console.error('Unhandled Rejection:', err);
});
process.on('uncaughtException', (err) => {
  if (Sentry) Sentry.captureException(err);
  console.error('Uncaught Exception:', err);
});

const providers = require('./lib/providers');
const payu = require('./lib/payu');
const demoLinks = require('./lib/demo-links');
const db = require('./lib/db');
const sms = require('./lib/sms');
const calendar = require('./lib/calendar');
const storage = require('./lib/storage');
const email = require('./lib/email');
const queue = require('./lib/queue');
const whatsapp = require('./lib/whatsapp');

const PORT = parseInt(process.env.PORT || '8787', 10);
const DEFAULT_PROVIDERS = Object.freeze({
  stt: providers.stt.id,
  tts: providers.tts.id,
  llm: providers.llm.id,
  telephony: providers.telephony.id,
});

/* ==========================================================================
   Boot: ensure data/ + db.json, seed the demo tenant, migrate legacy agents.
   ========================================================================== */

const DEMO_EMAIL = String(process.env.TEST_USER_EMAIL || '').trim().toLowerCase();
const DEMO_PASS = String(process.env.TEST_USER_PASSWORD || '');
const DEMO_TENANT = String(process.env.TEST_USER_TENANT || 'GetQualify Test');
const TRIAL_CREDIT_PAISE = 1000;
const CREDIT_PACKS = Object.freeze({
  starter: Object.freeze({ amount: '200.00', currency: 'INR', credits: 20000, productinfo: 'GetQualify Starter Credits' }),
  growth: Object.freeze({ amount: '500.00', currency: 'INR', credits: 50000, productinfo: 'GetQualify Growth Credits' }),
  scale: Object.freeze({ amount: '1000.00', currency: 'INR', credits: 100000, productinfo: 'GetQualify Scale Credits' }),
});

function payuConfig() {
  if (!process.env.PAYU_KEY || !process.env.PAYU_SALT) return null;
  return { key: process.env.PAYU_KEY, salt: process.env.PAYU_SALT, env: process.env.PAYU_ENV === 'production' ? 'production' : 'test' };
}

function readForm(req, cap = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (chunk) => { size += chunk.length; if (size > cap) { reject(new Error('payload too large')); req.destroy(); } else chunks.push(chunk); });
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')))));
    req.on('error', reject);
  });
}

const PRESET_LIBRARY = [
  {
    id: 'preset_personal_injury_v1', slug: 'personal-injury-intake', version: 1,
    name: 'Personal Injury Intake', category: 'legal', isSystem: true,
    greeting: 'Thank you for calling. I am an AI intake assistant and this call may be recorded. Are you in immediate danger or need emergency medical help?',
    fields: ['caller_name', 'callback_number', 'adverse_parties', 'incident_date', 'incident_location', 'incident_type', 'injuries', 'treatment', 'insurance', 'represented', 'deadline_risk', 'preferred_appointment'],
    guardrails: ['No legal advice', 'No case valuation', 'Escalate emergencies and deadline risk', 'Attorney decides case acceptance'],
  },
  {
    id: 'preset_dental_receptionist_v1', slug: 'dental-receptionist', version: 1,
    name: 'Dental Receptionist', category: 'healthcare', isSystem: true,
    greeting: 'Thank you for calling. I am the practice AI receptionist and this call may be recorded. How can I help today?',
    fields: ['caller_name', 'callback_number', 'new_or_existing_patient', 'reason', 'pain_level', 'emergency_signs', 'insurance', 'preferred_appointment'],
    guardrails: ['No diagnosis', 'Escalate breathing, bleeding, trauma, or severe swelling', 'Confirm booking details'],
  },
  {
    id: 'preset_real_estate_v1', slug: 'real-estate-lead', version: 1,
    name: 'Real Estate Lead Qualifier', category: 'real_estate', isSystem: true,
    greeting: 'Thanks for calling. I am the AI property assistant. Are you looking to buy, sell, rent, or schedule a viewing?',
    fields: ['caller_name', 'callback_number', 'intent', 'location', 'budget', 'timeline', 'financing', 'property_type', 'preferred_appointment'],
    guardrails: ['Do not promise availability or returns', 'Escalate fair housing questions', 'Confirm consent before follow-up'],
  },
  {
    id: 'preset_restaurant_v1', slug: 'restaurant-reservations', version: 1,
    name: 'Restaurant Reservations', category: 'hospitality', isSystem: true,
    greeting: 'Thank you for calling. I can help with a reservation, opening hours, directions, or a general question.',
    fields: ['caller_name', 'callback_number', 'party_size', 'date', 'time', 'dietary_needs', 'occasion', 'special_requests'],
    guardrails: ['Never confirm unavailable inventory', 'Escalate allergy questions to staff', 'Read back reservation details'],
  },
  {
    id: 'preset_appointment_v1', slug: 'appointment-booking', version: 1,
    name: 'Appointment Booking', category: 'scheduling', isSystem: true,
    greeting: 'Thanks for calling. I can help you schedule, move, or cancel an appointment.',
    fields: ['caller_name', 'callback_number', 'appointment_type', 'preferred_date', 'preferred_time', 'timezone', 'notes'],
    guardrails: ['Confirm timezone', 'Never invent calendar availability', 'Read back the final appointment'],
  },
  {
    id: 'preset_customer_support_v1', slug: 'customer-support', version: 1,
    name: 'Customer Support', category: 'support', isSystem: true,
    greeting: 'Thanks for contacting support. I am an AI assistant. Tell me what happened and I will help or route you to the right person.',
    fields: ['caller_name', 'callback_number', 'account_reference', 'issue_category', 'issue_summary', 'steps_tried', 'preferred_resolution'],
    guardrails: ['Never request passwords or full payment credentials', 'Escalate security incidents', 'Do not promise refunds'],
  },
  {
    id: 'preset_lead_qualification_v1', slug: 'lead-qualification', version: 1,
    name: 'Lead Qualification', category: 'sales', isSystem: true,
    greeting: 'Thanks for your interest. I am an AI assistant. I will ask a few quick questions and help you book the right next step.',
    fields: ['caller_name', 'company', 'callback_number', 'email', 'need', 'budget', 'authority', 'timeline', 'preferred_appointment'],
    guardrails: ['Disclose AI identity', 'Do not make unsupported product claims', 'Respect opt-out requests immediately'],
  },
  {
    id: 'preset_receptionist_v1', slug: 'general-receptionist', version: 1,
    name: 'AI Receptionist', category: 'reception', isSystem: true,
    greeting: 'Thank you for calling. I am the AI receptionist. How may I direct your call today?',
    fields: ['caller_name', 'callback_number', 'reason', 'department', 'urgency', 'message', 'preferred_follow_up'],
    guardrails: ['Disclose AI identity', 'Escalate emergencies', 'Do not reveal private staff or customer information'],
  },
];

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

// Pull legacy agents from _legacy/agents.legacy.json or root agents.json (first
// that exists). Returns an array, never throws.
function readLegacyAgents() {
  const candidates = [
    path.join(core.ROOT, '_legacy', 'agents.legacy.json'),
    path.join(core.ROOT, 'agents.json'),
  ];
  for (const f of candidates) {
    try {
      const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (Array.isArray(arr) && arr.length) return arr;
    } catch (_) { /* try next */ }
  }
  return [];
}

// Normalize a legacy agent (flat model/speaker/created) into the SPEC shape
// (nested tts object, createdAt ISO), scoped to the given tenant.
function migrateLegacyAgent(legacy, tenantId) {
  const model = legacy.model === 'muga' ? 'muga' : providers.tts.model;
  const speaker = providers.TTS_SPEAKERS.has(legacy.speaker) ? legacy.speaker : 'speaker_1';
  return {
    id: legacy.id || core.genId('ag_'),
    tenantId,
    name: String(legacy.name || 'Untitled Agent').slice(0, 60),
    persona: String(legacy.persona || '').slice(0, 1500),
    tts: {
      provider: providers.tts.id,
      model,
      speaker,
      f0_up_key: Number.isFinite(legacy.f0_up_key) ? legacy.f0_up_key : 0,
    },
    greeting: String(legacy.greeting || '').slice(0, 300),
    telephony: { did: String(legacy.did || providers.telephony.did) },
    createdAt: legacy.created ? new Date(legacy.created).toISOString() : new Date().toISOString(),
  };
}

async function boot() {
  // Force a load so a missing/corrupt db.json resolves to a clean default.
  const existing = core.db();
  await core.mutate((d) => {
    for (const preset of PRESET_LIBRARY) {
      if (!d.presets.some((p) => p.id === preset.id)) d.presets.push({ ...preset, createdAt: new Date().toISOString() });
    }
  });

  if (db.isPostgres) {
    for (const preset of PRESET_LIBRARY) {
      await db.query(
        `INSERT INTO presets (id, slug, name, category, version, is_system, greeting, persona, fields, guardrails, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
         ON CONFLICT (id) DO NOTHING`,
        [preset.id, preset.slug, preset.name, preset.category, preset.version || 1, true, preset.greeting, preset.persona || null, JSON.stringify(preset.fields || []), JSON.stringify(preset.guardrails || [])]
      ).catch(() => {});
    }
    await db.query(`
      CREATE TABLE IF NOT EXISTS email_otps (
        email VARCHAR(255) PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL,
        otp_hash TEXT NOT NULL,
        exp BIGINT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).catch(() => {});
  }

  const hasDemo = DEMO_EMAIL && existing.users.some((u) => u.email === DEMO_EMAIL);

  if (DEMO_EMAIL && DEMO_PASS.length >= 12 && !hasDemo) {
    const tenantId = core.genId('t_');
    const userId = core.genId('u_');
    const nowIso = new Date().toISOString();
    const legacy = readLegacyAgents();
    let finalSlug;
    let finalPassHash;

    await core.mutate((d) => {
      d.tenants.push({
        id: tenantId,
        name: DEMO_TENANT,
        slug: finalSlug = makeSlug(DEMO_TENANT, new Set(d.tenants.map((t) => t.slug))),
        createdAt: nowIso,
        branding: { color: '#6E7BFF' },
        providers: { ...DEFAULT_PROVIDERS },
        plan: 'studio',
        status: 'active', privacyMode: 'standard',
      });
      d.users.push({
        id: userId,
        tenantId,
        email: DEMO_EMAIL,
        name: 'GetQualify Demo',
        passHash: finalPassHash = core.hashPassword(DEMO_PASS),
        role: process.env.TEST_USER_SUPER_ADMIN === 'true' ? 'super_admin' : 'owner', status: 'active',
        createdAt: nowIso,
      });
      d.wallets.push({ id: core.genId('wal_'), tenantId, currency: 'INR', balancePaise: 0, createdAt: nowIso, updatedAt: nowIso });
      addLedgerEntry(d, tenantId, TRIAL_CREDIT_PAISE, 'trial_grant', `trial:${tenantId}`, userId, { amountInr: 10, source: 'test_bootstrap' });
      // Migrate any legacy agents into the demo tenant.
      for (const la of legacy) d.agents.push(migrateLegacyAgent(la, tenantId));
    });

    if (db.isPostgres) {
      try {
        await db.transaction(async (client) => {
          try {
            await client.query(
              `INSERT INTO tenants (id, name, slug, branding, providers, plan, status, privacy_mode, created_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              [tenantId, DEMO_TENANT, finalSlug, JSON.stringify({ color: '#6E7BFF' }), JSON.stringify(DEFAULT_PROVIDERS), 'studio', 'active', 'standard', nowIso]
            );
          } catch (err) {
            if (err.code === '23505') console.warn('boot: Postgres tenant slug conflict (will rollback and skip).');
            throw err;
          }

          try {
            await client.query(
              `INSERT INTO users (id, tenant_id, email, name, pass_hash, role, status, created_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
              [userId, tenantId, DEMO_EMAIL, 'GetQualify Demo', finalPassHash, process.env.TEST_USER_SUPER_ADMIN === 'true' ? 'super_admin' : 'owner', 'active', nowIso]
            );
          } catch (err) {
            if (err.code === '23505') console.warn('boot: Postgres user email conflict (will rollback and skip).');
            throw err;
          }

          await db.addLedgerEntrySql(client, tenantId, TRIAL_CREDIT_PAISE, 'trial_grant', `trial:${tenantId}`, userId, { amountInr: 10, source: 'test_bootstrap' });
        });
      } catch (err) {
        console.warn('boot: Skipping Postgres dual-write (JSON seed succeeded). Postgres Error:', err.message);
      }
    }

    console.log(`  Seeded env-configured test tenant "${DEMO_TENANT}" with ${legacy.length} migrated agent(s).`);
  }

  // Migrate the old provider selection without rewriting tenant data by hand.
  if (core.db().tenants.some((t) => t.providers && t.providers.telephony === 'voicelink')) {
    await core.mutate((d) => {
      d.tenants.forEach((t) => {
        if (t.providers && t.providers.telephony === 'voicelink') t.providers.telephony = 'vobiz';
      });
    });
  }

  // Fill missing or stale selections from the configured adapter defaults.
  // Existing valid selections remain intact so boot never forces a tenant back
  // to one specific LLM or TTS provider.
  if (core.db().tenants.some((t) => !t.providers || !t.providers.stt || !t.providers.tts || !t.providers.llm || !t.providers.telephony)) {
    await core.mutate((d) => {
      d.tenants.forEach((t) => {
        t.providers = { ...DEFAULT_PROVIDERS, ...(t.providers || {}) };
      });
    });
  }
}

/* ==========================================================================
   Public-facing serialization (never leak passHash, scope to tenant).
   ========================================================================== */
function publicUser(u) {
  return { id: u.id, tenantId: u.tenantId, email: u.email, name: u.name, role: u.role, status: u.status, createdAt: u.createdAt, verified: !!u.verified };
}
function publicTenant(t) {
  return {
    id: t.id, name: t.name, slug: t.slug, createdAt: t.createdAt,
    branding: t.branding, providers: t.providers, plan: t.plan,
    status: t.status, privacyMode: t.privacyMode,
  };
}
function publicAgent(a) {
  return {
    id: a.id, name: a.name, persona: a.persona, tts: a.tts,
    greeting: a.greeting, telephony: a.telephony, presetId: a.presetId || null, createdAt: a.createdAt,
  };
}

// Slugify a company name into a tenant slug, ensuring uniqueness.
function makeSlug(name, taken) {
  const base = String(name || 'tenant').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'tenant';
  let slug = base; let n = 2;
  while (taken.has(slug)) { slug = `${base}-${n++}`; }
  return slug;
}

// Bump a usage counter for today for a tenant. field in {chars, calls, llmTokens}.
async function bumpUsage(tenantId, field, amount) {
  const day = todayUtc();
  if (db.isPostgres) {
    const col = field === 'llmTokens' ? 'llm_tokens' : field;
    if (!['chars', 'calls', 'llm_tokens'].includes(col)) return;
    await db.query(
      `INSERT INTO usage (tenant_id, day, chars, calls, llm_tokens)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, day)
       DO UPDATE SET ${col} = usage.${col} + EXCLUDED.${col}`,
      [tenantId, day, col === 'chars' ? amount : 0, col === 'calls' ? amount : 0, col === 'llm_tokens' ? amount : 0]
    ).catch((err) => console.error('bumpUsage Postgres error:', err));
    return;
  }
  await core.mutate((d) => {
    let row = d.usage.find((r) => r.tenantId === tenantId && r.day === day);
    if (!row) { row = { tenantId, day, chars: 0, calls: 0, llmTokens: 0 }; d.usage.push(row); }
    row[field] = (row[field] || 0) + amount;
  });
}

function publicWallet(w) {
  return { id: w.id, tenantId: w.tenantId, currency: w.currency, balancePaise: w.balancePaise, balanceInr: w.balancePaise / 100, updatedAt: w.updatedAt };
}

function addLedgerEntry(d, tenantId, amountPaise, type, reference, actorUserId, metadata = {}) {
  const key = String(reference || '');
  if (key && d.ledger.some((x) => x.tenantId === tenantId && x.idempotencyKey === key)) return null;
  let wallet = d.wallets.find((w) => w.tenantId === tenantId);
  const now = new Date().toISOString();
  if (!wallet) {
    wallet = { id: core.genId('wal_'), tenantId, currency: 'INR', balancePaise: 0, createdAt: now, updatedAt: now };
    d.wallets.push(wallet);
  }
  if (!Number.isInteger(amountPaise) || wallet.balancePaise + amountPaise < 0) throw new Error('invalid wallet adjustment');
  wallet.balancePaise += amountPaise;
  wallet.updatedAt = now;
  const entry = { id: core.genId('led_'), tenantId, type, amountPaise, balanceAfterPaise: wallet.balancePaise, idempotencyKey: key || core.genId('idem_'), actorUserId, metadata, createdAt: now };
  d.ledger.push(entry);
  return entry;
}

function addAudit(d, ctx, action, targetType, targetId, metadata = {}) {
  d.auditEvents.push({ id: core.genId('aud_'), tenantId: ctx.tenant.id, actorUserId: ctx.impersonator ? ctx.impersonator.id : ctx.user.id, subjectUserId: ctx.impersonator ? ctx.user.id : null, action, targetType, targetId, metadata, createdAt: new Date().toISOString() });
}

function rejectImpersonated(res, ctx) {
  if (!ctx.impersonator) return false;
  core.sendJson(res, 403, { error: 'This action is blocked while viewing as another user', code: 'impersonation_read_only' });
  return true;
}

/* ==========================================================================
   Auth routes
   ========================================================================== */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function apiSignup(req, res, body) {
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const name = String(body.name || '').trim().slice(0, 80) || 'Owner';
  const company = String(body.company || '').trim().slice(0, 80) || `${name}'s Workspace`;

  if (!EMAIL_RE.test(email)) return core.sendJson(res, 422, { error: 'valid email required', code: 'bad_email' });
  if (password.length < 12) return core.sendJson(res, 422, { error: 'password must be at least 12 characters', code: 'weak_password' });

  // Email uniqueness check via SQL (replaces core.db().users.some()).
  const emailCheck = await db.query('SELECT 1 FROM users WHERE email = $1', [email]);
  if (emailCheck.rowCount > 0) {
    return core.sendJson(res, 409, { error: 'an account with this email already exists', code: 'email_taken' });
  }

  const tenantId = core.genId('t_');
  const userId   = core.genId('u_');
  const passHash = core.hashPassword(password);
  const nowIso   = new Date().toISOString();
  let tenant; let user;

  await db.transaction(async (client) => {
    // Read existing slugs to generate a unique one inside the transaction.
    const slugRows = await client.query('SELECT slug FROM tenants');
    const taken    = new Set(slugRows.rows.map((r) => r.slug));
    const slug     = makeSlug(company, taken);

    tenant = {
      id: tenantId, name: company, slug, createdAt: nowIso,
      branding: { color: '#6E7BFF' },
      providers: { ...DEFAULT_PROVIDERS },
      plan: 'studio', status: 'active', privacyMode: 'standard',
    };
    user = {
      id: userId, tenantId, email, name,
      passHash, role: 'owner', status: 'active', createdAt: nowIso,
      verified: false,
    };

    try {
      await client.query(
        `INSERT INTO tenants (id, name, slug, branding, providers, plan, status, privacy_mode, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [tenantId, company, slug, JSON.stringify(tenant.branding), JSON.stringify(tenant.providers),
         'studio', 'active', 'standard', nowIso]
      );
    } catch (err) {
      if (err.code === '23505') {
        // TODO: retry with a suffixed slug (e.g. slug-2, slug-3) instead of failing.
        throw Object.assign(new Error('slug conflict on tenant insert'), { statusCode: 409, code: 'slug_conflict' });
      }
      throw err;
    }

    try {
      await client.query(
        `INSERT INTO users (id, tenant_id, email, name, pass_hash, role, status, created_at, verified)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [userId, tenantId, email, name, passHash, 'owner', 'active', nowIso, false]
      );
    } catch (err) {
      if (err.code === '23505') {
        // Race: another signup with the same email committed between our check and this insert.
        throw Object.assign(new Error('email already registered'), { statusCode: 409, code: 'email_taken' });
      }
      throw err;
    }

    // addLedgerEntrySql creates the wallet row when none exists yet.
    await db.addLedgerEntrySql(client, tenantId, TRIAL_CREDIT_PAISE, 'trial_grant',
      `trial:${tenantId}`, userId, { amountInr: 10 });

    await db.addAuditSql(client, { tenant, user }, 'auth.signup', 'tenant', tenantId);

    // Generate 6-digit OTP, store in database, and trigger email via Resend
    const otp = generateOtp();
    const otpHash = core.hashPassword(otp);
    const otpExp = Date.now() + 10 * 60 * 1000;
    await storeOtp(email, userId, otpHash, otpExp);
    sendOtpEmail(email, otp).catch((err) => {
      console.error('[auth] Failed to send verification email:', err.message);
    });
  });

  // Session creation stays on core.js path (not migrated in this group).
  const token = await core.createSession(userId, tenantId);
  const csrfToken = core.generateCsrfToken();
  core.send(res, 200, JSON.stringify({ user: publicUser(user), tenant: publicTenant(tenant) }), {
    'Content-Type': 'application/json',
    'Set-Cookie': core.authCookies(token, csrfToken),
  });
}

async function apiLogin(req, res, body) {
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  
  let user;
  if (db.isPostgres) {
    const userRes = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    user = userRes.rows[0];
  } else {
    const d = core.db();
    user = d.users.find((u) => u.email === email);
  }

  // Same generic error whether the user is missing or the password is wrong.
  if (!user || !core.verifyPassword(password, user.passHash)) {
    console.error('DEBUG apiLogin: auth failed', { email, userExists: !!user, hasPassHash: user ? !!user.passHash : false });
    return core.sendJson(res, 401, { error: 'invalid email or password', code: 'bad_creds' });
  }

  let tenant;
  if (db.isPostgres) {
    const tenantRes = await db.query('SELECT * FROM tenants WHERE id = $1', [user.tenantId]);
    tenant = tenantRes.rows[0];
  } else {
    const d = core.db();
    tenant = d.tenants.find((t) => t.id === user.tenantId);
  }

  if (!tenant) {
    console.error('DEBUG apiLogin: tenant not found', { tenantId: user.tenantId });
    return core.sendJson(res, 401, { error: 'invalid email or password', code: 'bad_creds' });
  }

  const token = await core.createSession(user.id, user.tenantId);
  const csrfToken = core.generateCsrfToken();
  core.send(res, 200, JSON.stringify({ user: publicUser(user), tenant: publicTenant(tenant) }), {
    'Content-Type': 'application/json',
    'Set-Cookie': core.authCookies(token, csrfToken),
  });
}

async function apiLogout(req, res) {
  await core.destroySession(req);
  core.send(res, 200, JSON.stringify({ ok: true }), {
    'Content-Type': 'application/json',
    'Set-Cookie': core.clearAuthCookies(),
  });
}

// ---- Email Verification (OTP) Helpers & Endpoints ----

function generateOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

async function storeOtp(email, userId, otpHash, exp) {
  if (db.isPostgres) {
    await db.query(
      `INSERT INTO email_otps (email, user_id, otp_hash, exp)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET otp_hash = EXCLUDED.otp_hash, exp = EXCLUDED.exp`,
      [email, userId, otpHash, exp]
    ).catch((err) => console.error('[auth] Error storing OTP in Postgres:', err.message));
  } else {
    await core.mutate((d) => {
      d.email_otps = (d.email_otps || []).filter((o) => o.email !== email);
      d.email_otps.push({ email, userId, otpHash, exp });
    });
  }
}

async function getOtp(email) {
  if (db.isPostgres) {
    const res = await db.query('SELECT * FROM email_otps WHERE email = $1', [email]);
    if (!res.rows[0]) return null;
    return { email: res.rows[0].email, userId: res.rows[0].user_id, otpHash: res.rows[0].otp_hash, exp: Number(res.rows[0].exp) };
  } else {
    const d = core.db();
    return (d.email_otps || []).find((o) => o.email === email) || null;
  }
}

async function deleteOtp(email) {
  if (db.isPostgres) {
    await db.query('DELETE FROM email_otps WHERE email = $1', [email]).catch(() => {});
  } else {
    await core.mutate((d) => {
      d.email_otps = (d.email_otps || []).filter((o) => o.email !== email);
    });
  }
}

async function sendOtpEmail(email, otp) {
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL || 'noreply@hello.getqualify.in';
  if (!apiKey) {
    console.warn(`[email] RESEND_API_KEY missing. Verification OTP for ${email}: ${otp}`);
    return;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [email],
        subject: 'Verify your GetQualify account - OTP Code',
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background: #ffffff;">
            <h2 style="color: #6E7BFF; margin-top: 0; font-size: 20px;">GetQualify Verification</h2>
            <p style="color: #334155; font-size: 14px; line-height: 1.5;">Use the following 6-digit code to verify your email address:</p>
            <div style="font-size: 32px; font-weight: 700; letter-spacing: 6px; padding: 18px; background: #f8fafc; text-align: center; border-radius: 8px; color: #0f172a; margin: 20px 0; border: 1px dashed #cbd5e1;">
              ${otp}
            </div>
            <p style="color: #64748b; font-size: 12px; margin-bottom: 0;">This code is valid for 10 minutes. If you did not request this, please ignore this email.</p>
          </div>
        `,
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error('[email] Resend API error:', res.status, errText);
    }
  } catch (err) {
    console.error('[email] Failed to send OTP email via Resend:', err.message);
  }
}

async function apiVerifyOtp(req, res, body) {
  const email = String(body.email || '').trim().toLowerCase();
  const otp = String(body.otp || '').trim();

  if (!email || !EMAIL_RE.test(email)) {
    return core.sendJson(res, 422, { error: 'valid email required', code: 'bad_email' });
  }
  if (!/^\d{6}$/.test(otp)) {
    return core.sendJson(res, 422, { error: '6-digit OTP code required', code: 'bad_otp' });
  }

  const record = await getOtp(email);
  if (!record) {
    return core.sendJson(res, 400, { error: 'no verification code found. Please request a new code.', code: 'otp_not_found' });
  }

  if (Date.now() > record.exp) {
    await deleteOtp(email);
    return core.sendJson(res, 410, { error: 'verification code has expired. Please request a new one.', code: 'otp_expired' });
  }

  const isValid = core.verifyPassword(otp, record.otpHash);
  if (!isValid) {
    return core.sendJson(res, 401, { error: 'invalid verification code', code: 'bad_otp' });
  }

  if (db.isPostgres) {
    await db.query('UPDATE users SET verified = true WHERE id = $1', [record.userId]);
  } else {
    await core.mutate((d) => {
      const u = (d.users || []).find((user) => user.id === record.userId);
      if (u) u.verified = true;
    });
  }

  await deleteOtp(email);
  return core.sendJson(res, 200, { ok: true, message: 'email verified successfully' });
}

async function apiResendOtp(req, res, body) {
  const email = String(body.email || '').trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email)) {
    return core.sendJson(res, 422, { error: 'valid email required', code: 'bad_email' });
  }

  let user;
  if (db.isPostgres) {
    const userRes = await db.query('SELECT id, verified FROM users WHERE email = $1', [email]);
    user = userRes.rows[0];
  } else {
    user = (core.db().users || []).find((u) => u.email === email);
  }

  if (!user) {
    return core.sendJson(res, 200, { ok: true, message: 'if this account exists, a new verification code has been sent.' });
  }

  if (user.verified) {
    return core.sendJson(res, 400, { error: 'this email is already verified', code: 'already_verified' });
  }

  const otp = generateOtp();
  const otpHash = core.hashPassword(otp);
  const otpExp = Date.now() + 10 * 60 * 1000;

  await storeOtp(email, user.id, otpHash, otpExp);
  await sendOtpEmail(email, otp);

  return core.sendJson(res, 200, { ok: true, message: 'verification code resent successfully' });
}

/* ==========================================================================
   Authed routes (ctx = { user, tenant, session, body })
   ========================================================================== */

function apiMe(req, res, ctx) {
  core.sendJson(res, 200, { user: publicUser(ctx.user), tenant: publicTenant(ctx.tenant), impersonation: ctx.impersonator ? { actor: publicUser(ctx.impersonator), reason: ctx.session.impersonationReason, expiresAt: new Date(ctx.session.exp).toISOString() } : null });
}

const HVAC_TIMEZONE = 'Asia/Kolkata';
const HVAC_OUTCOMES = new Set(['new', 'booked', 'routed', 'follow_up', 'closed', 'abandoned']);
function calHeaders(version) {
  if (!process.env.CALCOM_API_KEY) throw new providers.ProviderError('Cal.com is not configured', 503, 'calendar_not_configured');
  return { Authorization: `Bearer ${process.env.CALCOM_API_KEY}`, 'cal-api-version': version, Accept: 'application/json' };
}
function calRequest(method, pathname, version, payload) {
  return new Promise((resolve, reject) => {
    const data = payload ? Buffer.from(JSON.stringify(payload)) : null;
    const headers = calHeaders(version);
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(data.length); }
    const upstream = require('https').request({ host: 'api.cal.com', path: pathname, method, headers }, (resp) => {
      const parts = []; resp.on('data', (part) => parts.push(part)); resp.on('end', () => {
        let body = {}; try { body = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); } catch (_) {}
        if (resp.statusCode < 200 || resp.statusCode >= 300) return reject(new providers.ProviderError(body.message || body.error || 'Cal.com request failed', resp.statusCode || 502, 'calendar_upstream'));
        resolve(body);
      });
    });
    upstream.on('error', reject); upstream.setTimeout(20000, () => upstream.destroy(new Error('Cal.com timeout')));
    if (data) upstream.write(data); upstream.end();
  });
}
function tenantHvacJobs(tenantId) { return core.db().hvacJobs.filter((job) => job.tenantId === tenantId); }
function publicHvacJob(job) {
  return {
    id: job.id,
    callerName: job.callerName || job.caller_name || '',
    phone: job.phone,
    email: job.email || '',
    service: job.service,
    urgency: job.urgency,
    outcome: job.outcome,
    assignedTo: job.assignedTo || job.assigned_to || '',
    notes: job.notes || '',
    appointment: job.appointment || null,
    leadId: job.leadId || job.lead_id || null,
    createdAt: toIso(job.createdAt || job.created_at),
    updatedAt: toIso(job.updatedAt || job.updated_at),
  };
}

async function apiHvacDesk(req, res, ctx) {
  if (db.isPostgres) {
    const { rows } = await db.query('SELECT * FROM hvac_jobs WHERE tenant_id = $1 ORDER BY updated_at DESC', [ctx.tenant.id]);
    const jobs = rows.map(publicHvacJob);
    const count = (outcome) => jobs.filter((job) => job.outcome === outcome).length;
    return core.sendJson(res, 200, { timezone: HVAC_TIMEZONE, calendarConfigured: Boolean(process.env.CALCOM_API_KEY), jobs, stats: { calls: jobs.length, booked: count('booked'), routed: count('routed'), followUp: count('follow_up') } });
  }
  const jobs = tenantHvacJobs(ctx.tenant.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const count = (outcome) => jobs.filter((job) => job.outcome === outcome).length;
  core.sendJson(res, 200, { timezone: HVAC_TIMEZONE, calendarConfigured: Boolean(process.env.CALCOM_API_KEY), jobs: jobs.map(publicHvacJob), stats: { calls: jobs.length, booked: count('booked'), routed: count('routed'), followUp: count('follow_up') } });
}
async function apiHvacEventTypes(req, res) {
  try { const result = await calRequest('GET', '/v2/event-types', '2024-06-14'); core.sendJson(res, 200, { eventTypes: (result.data || []).map((event) => ({ id: event.id, title: event.title, slug: event.slug, lengthInMinutes: event.lengthInMinutes, locations: event.locations || [] })) }); }
  catch (e) { handleProviderError(res, e); }
}
async function apiHvacSlots(req, res) {
  try {
    const q = new URL(req.url, 'http://local').searchParams; const eventTypeId = Number(q.get('eventTypeId')); const start = String(q.get('start') || ''); const end = String(q.get('end') || '');
    if (!Number.isInteger(eventTypeId) || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return core.sendJson(res, 422, { error: 'event type and date range required', code: 'bad_calendar_query' });
    const result = await calRequest('GET', `/v2/slots?eventTypeId=${eventTypeId}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&timeZone=${encodeURIComponent(HVAC_TIMEZONE)}&format=range`, '2024-09-04');
    core.sendJson(res, 200, { timezone: HVAC_TIMEZONE, slots: result.data || {} });
  } catch (e) { handleProviderError(res, e); }
}
async function apiHvacJobSave(req, res, ctx) {
  const b = ctx.body || {};
  const callerName = String(b.callerName || '').trim().slice(0, 100);
  const phone = String(b.phone || '').trim().slice(0, 32);
  if (!callerName || !phone) return core.sendJson(res, 422, { error: 'caller name and phone are required', code: 'missing_contact' });
  const outcome = HVAC_OUTCOMES.has(b.outcome) ? b.outcome : 'new';
  const email = String(b.email || '').trim().slice(0, 180);
  const service = String(b.service || 'General HVAC').trim().slice(0, 80);
  const urgency = String(b.urgency || 'normal').trim().slice(0, 30);
  const assignedTo = String(b.assignedTo || '').trim().slice(0, 80);
  const notes = String(b.notes || '').trim().slice(0, 2000);
  const now = new Date().toISOString();
  let job;

  if (db.isPostgres) {
    const jobId = b.id ? String(b.id) : core.genId('hvac_');
    const existing = b.id ? await db.query('SELECT * FROM hvac_jobs WHERE id = $1 AND tenant_id = $2', [jobId, ctx.tenant.id]) : { rowCount: 0 };

    await db.transaction(async (client) => {
      let leadId = null;
      if (phone) {
        const leadRes = await client.query(
          `INSERT INTO leads (id, tenant_id, name, phone, email, source, status, notes, assigned_to, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'hvac_job', $6, $7, $8, $9, $9)
           ON CONFLICT (tenant_id, phone) DO UPDATE SET
             name = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE leads.name END,
             email = CASE WHEN EXCLUDED.email <> '' THEN EXCLUDED.email ELSE leads.email END,
             status = CASE WHEN EXCLUDED.status = 'booked' THEN 'booked' ELSE leads.status END,
             notes = CASE WHEN EXCLUDED.notes <> '' THEN EXCLUDED.notes ELSE leads.notes END,
             assigned_to = CASE WHEN EXCLUDED.assigned_to <> '' THEN EXCLUDED.assigned_to ELSE leads.assigned_to END,
             updated_at = EXCLUDED.updated_at
           RETURNING id`,
          [core.genId('lead_'), ctx.tenant.id, callerName, phone, email, outcome === 'booked' ? 'booked' : 'new', notes, assignedTo, now]
        );
        leadId = leadRes.rows[0].id;
      }

      if (existing.rowCount > 0) {
        const uRes = await client.query(
          `UPDATE hvac_jobs
           SET caller_name = $1, phone = $2, email = $3, service = $4, urgency = $5, outcome = $6, assigned_to = $7, notes = $8, updated_at = $9, lead_id = COALESCE($12, lead_id)
           WHERE id = $10 AND tenant_id = $11
           RETURNING *`,
          [callerName, phone, email, service, urgency, outcome, assignedTo, notes, now, jobId, ctx.tenant.id, leadId]
        );
        job = uRes.rows[0];
      } else {
        const iRes = await client.query(
          `INSERT INTO hvac_jobs (id, tenant_id, caller_name, phone, email, service, urgency, outcome, assigned_to, notes, appointment, created_at, updated_at, lead_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           RETURNING *`,
          [jobId, ctx.tenant.id, callerName, phone, email, service, urgency, outcome, assignedTo, notes, null, now, now, leadId]
        );
        job = iRes.rows[0];
      }
      await db.addAuditSql(client, ctx, 'hvac.job.saved', 'hvac_job', job.id, { outcome: job.outcome });
    });

    return core.sendJson(res, 200, { job: publicHvacJob(job) });
  }

  await core.mutate((d) => {
    let leadId = null;
    if (phone) {
      let lead = d.leads.find((l) => (l.tenantId === ctx.tenant.id || l.tenant_id === ctx.tenant.id) && l.phone === phone);
      if (lead) {
        if (callerName) lead.name = callerName;
        if (b.email) lead.email = String(b.email).trim().slice(0, 180);
        if (outcome === 'booked') lead.status = 'booked';
        if (notes) lead.notes = notes;
        if (assignedTo) lead.assignedTo = assignedTo;
        lead.updatedAt = now;
      } else {
        lead = {
          id: core.genId('lead_'),
          tenantId: ctx.tenant.id,
          name: callerName,
          phone,
          email: String(b.email || '').trim().slice(0, 180),
          source: 'hvac_job',
          status: outcome === 'booked' ? 'booked' : 'new',
          notes,
          assignedTo,
          createdAt: now,
          updatedAt: now,
        };
        d.leads.push(lead);
      }
      leadId = lead.id;
    }

    job = b.id ? d.hvacJobs.find((item) => item.id === String(b.id) && item.tenantId === ctx.tenant.id) : null;
    if (!job) { job = { id: core.genId('hvac_'), tenantId: ctx.tenant.id, createdAt: now, appointment: null }; d.hvacJobs.push(job); }
    Object.assign(job, { callerName, phone, email: String(b.email || '').trim().slice(0, 180), service: String(b.service || 'General HVAC').trim().slice(0, 80), urgency: String(b.urgency || 'normal').trim().slice(0, 30), outcome, assignedTo: String(b.assignedTo || '').trim().slice(0, 80), notes: String(b.notes || '').trim().slice(0, 2000), updatedAt: now });
    if (leadId) job.leadId = leadId;
    addAudit(d, ctx, 'hvac.job.saved', 'hvac_job', job.id, { outcome: job.outcome });
  });
  core.sendJson(res, 200, { job: publicHvacJob(job) });
}
async function apiHvacBook(req, res, ctx) {
  const b = ctx.body || {}; const eventTypeId = Number(b.eventTypeId); const start = String(b.start || ''); const attendee = b.attendee || {};
  if (!Number.isInteger(eventTypeId) || Number(eventTypeId) <= 0 || !/^\d{4}-\d{2}-\d{2}T/.test(start)) return core.sendJson(res, 422, { error: 'event type and appointment time are required', code: 'bad_booking' });
  const name = String(attendee.name || '').trim(); const email = String(attendee.email || '').trim().toLowerCase(); const phone = String(attendee.phone || '').trim();
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !phone) return core.sendJson(res, 422, { error: 'attendee name, email and phone are required for Cal.com booking', code: 'missing_booking_contact' });
  try {
    const booking = await calRequest('POST', '/v2/bookings', '2026-02-25', { eventTypeId, start: new Date(start).toISOString(), attendee: { name, email, phoneNumber: phone, timeZone: HVAC_TIMEZONE, language: 'en' }, metadata: { source: 'rumik_hvac_desk', service: String(b.service || 'General HVAC').slice(0, 80), urgency: String(b.urgency || 'normal').slice(0, 30), jobId: String(b.jobId || '') } });
    const now = new Date().toISOString(); let job;
    const appointment = { calBookingUid: booking.data && booking.data.uid, eventTypeId, start: booking.data && booking.data.start, end: booking.data && booking.data.end, status: booking.data && booking.data.status, timezone: HVAC_TIMEZONE };

    if (db.isPostgres) {
      const jobId = b.jobId ? String(b.jobId) : core.genId('hvac_');
      const existing = b.jobId ? await db.query('SELECT * FROM hvac_jobs WHERE id = $1 AND tenant_id = $2', [jobId, ctx.tenant.id]) : { rowCount: 0 };
      await db.transaction(async (client) => {
        let leadId = null;
        if (phone) {
          const leadRes = await client.query(
            `INSERT INTO leads (id, tenant_id, name, phone, email, source, status, notes, assigned_to, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, 'hvac_job', 'booked', '', '', $6, $6)
             ON CONFLICT (tenant_id, phone) DO UPDATE SET
               name = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE leads.name END,
               email = CASE WHEN EXCLUDED.email <> '' THEN EXCLUDED.email ELSE leads.email END,
               status = 'booked',
               updated_at = EXCLUDED.updated_at
             RETURNING id`,
            [core.genId('lead_'), ctx.tenant.id, name, phone, email, now]
          );
          leadId = leadRes.rows[0].id;
        }

        if (existing.rowCount > 0) {
          const uRes = await client.query(
            `UPDATE hvac_jobs
             SET outcome = 'booked', updated_at = $1, appointment = $2, lead_id = COALESCE($5, lead_id)
             WHERE id = $3 AND tenant_id = $4
             RETURNING *`,
            [now, JSON.stringify(appointment), jobId, ctx.tenant.id, leadId]
          );
          job = uRes.rows[0];
        } else {
          const iRes = await client.query(
            `INSERT INTO hvac_jobs (id, tenant_id, caller_name, phone, email, service, urgency, assigned_to, notes, outcome, appointment, created_at, updated_at, lead_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'booked', $10, $11, $12, $13)
             RETURNING *`,
            [jobId, ctx.tenant.id, name, phone, email, String(b.service || 'General HVAC').slice(0, 80), String(b.urgency || 'normal').slice(0, 30), '', '', JSON.stringify(appointment), now, now, leadId]
          );
          job = iRes.rows[0];
        }
        await db.addAuditSql(client, ctx, 'hvac.booking.created', 'hvac_job', job.id, { eventTypeId, bookingUid: appointment.calBookingUid || '' });
      });
      return core.sendJson(res, 201, { booking: booking.data, job: publicHvacJob(job) });
    }

    await core.mutate((d) => {
      let leadId = null;
      if (phone) {
        let lead = d.leads.find((l) => (l.tenantId === ctx.tenant.id || l.tenant_id === ctx.tenant.id) && l.phone === phone);
        if (lead) {
          if (name) lead.name = name;
          if (email) lead.email = email;
          lead.status = 'booked';
          lead.updatedAt = now;
        } else {
          lead = {
            id: core.genId('lead_'),
            tenantId: ctx.tenant.id,
            name,
            phone,
            email,
            source: 'hvac_job',
            status: 'booked',
            notes: '',
            assignedTo: '',
            createdAt: now,
            updatedAt: now,
          };
          d.leads.push(lead);
        }
        leadId = lead.id;
      }

      job = b.jobId ? d.hvacJobs.find((item) => item.id === String(b.jobId) && item.tenantId === ctx.tenant.id) : null;
      if (!job) { job = { id: core.genId('hvac_'), tenantId: ctx.tenant.id, callerName: name, phone, email, service: String(b.service || 'General HVAC').slice(0, 80), urgency: String(b.urgency || 'normal').slice(0, 30), assignedTo: '', notes: '', createdAt: now }; d.hvacJobs.push(job); }
      job.outcome = 'booked'; job.updatedAt = now; job.appointment = appointment;
      if (leadId) job.leadId = leadId;
      addAudit(d, ctx, 'hvac.booking.created', 'hvac_job', job.id, { eventTypeId, bookingUid: job.appointment.calBookingUid || '' });
    });
    core.sendJson(res, 201, { booking: booking.data, job: publicHvacJob(job) });
  } catch (e) { handleProviderError(res, e); }
}

/* ==========================================================================
   Leads / Lightweight CRM
   ========================================================================== */

// Phase 7: Fixed pipeline stages (system-wide, not tenant-configurable)
const PIPELINE_STAGES = ['new', 'contacted', 'qualified', 'proposal', 'negotiation', 'won', 'lost', 'closed'];

function publicLead(lead) {
  if (!lead) return null;
  return {
    id: lead.id,
    tenantId: lead.tenantId || lead.tenant_id,
    name: lead.name || '',
    phone: lead.phone || '',
    email: lead.email || '',
    source: lead.source || 'inbound_call',
    status: lead.status || 'new',
    pipelineStage: lead.pipelineStage || lead.pipeline_stage || 'new',
    pipelineUpdatedAt: toIso(lead.pipelineUpdatedAt || lead.pipeline_updated_at),
    valuePaise: typeof lead.valuePaise === 'number' ? lead.valuePaise : (typeof lead.value_paise === 'number' ? lead.value_paise : 0),
    expectedCloseDate: lead.expectedCloseDate || lead.expected_close_date || null,
    notes: lead.notes || '',
    assignedTo: lead.assignedTo || lead.assigned_to || '',
    createdAt: toIso(lead.createdAt || lead.created_at),
    updatedAt: toIso(lead.updatedAt || lead.updated_at),
  };
}

async function apiLeadsList(req, res, ctx) {
  const q = new URL(req.url, 'http://local').searchParams;
  const status = q.get('status') ? String(q.get('status')).trim() : null;
  const source = q.get('source') ? String(q.get('source')).trim() : null;
  // Phase 7: new filters
  const pipelineStage = q.get('pipeline_stage') ? String(q.get('pipeline_stage')).trim() : null;
  const assignedTo = q.get('assigned_to') ? String(q.get('assigned_to')).trim() : null;
  const search = q.get('search') ? String(q.get('search')).trim() : null;
  const sortBy = ['created_at', 'updated_at', 'pipeline_updated_at'].includes(q.get('sort_by')) ? q.get('sort_by') : 'created_at';
  const page = Math.max(1, parseInt(q.get('page') || '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(q.get('limit') || '50', 10) || 50));
  const offset = (page - 1) * limit;

  if (db.isPostgres) {
    const conditions = ['tenant_id = $1'];
    const params = [ctx.tenant.id];
    if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
    if (source) { params.push(source); conditions.push(`source = $${params.length}`); }
    if (pipelineStage) { params.push(pipelineStage); conditions.push(`pipeline_stage = $${params.length}`); }
    if (assignedTo) { params.push(assignedTo); conditions.push(`assigned_to = $${params.length}`); }
    if (search) {
      const s = `%${search}%`;
      params.push(s);
      conditions.push(`(name ILIKE $${params.length} OR phone ILIKE $${params.length} OR email ILIKE $${params.length})`);
    }
    const where = conditions.join(' AND ');
    const { rows } = await db.query(`SELECT * FROM leads WHERE ${where} ORDER BY ${sortBy} DESC`, params);
    const paged = rows.slice(offset, offset + limit);
    return core.sendJson(res, 200, { leads: paged.map(publicLead), page, limit, total: rows.length });
  }

  let list = core.db().leads.filter((l) => (l.tenantId === ctx.tenant.id || l.tenant_id === ctx.tenant.id));
  if (status) list = list.filter((l) => l.status === status);
  if (source) list = list.filter((l) => l.source === source);
  if (pipelineStage) list = list.filter((l) => (l.pipelineStage || l.pipeline_stage || 'new') === pipelineStage);
  if (assignedTo) list = list.filter((l) => (l.assignedTo || l.assigned_to || '') === assignedTo);
  if (search) {
    const s = search.toLowerCase();
    list = list.filter((l) =>
      (l.name || '').toLowerCase().includes(s) ||
      (l.phone || '').toLowerCase().includes(s) ||
      (l.email || '').toLowerCase().includes(s)
    );
  }
  const sortKey = sortBy === 'pipeline_updated_at' ? ['pipelineUpdatedAt', 'pipeline_updated_at'] :
                  sortBy === 'updated_at' ? ['updatedAt', 'updated_at'] : ['createdAt', 'created_at'];
  list.sort((a, b) => new Date(b[sortKey[0]] || b[sortKey[1]] || 0) - new Date(a[sortKey[0]] || a[sortKey[1]] || 0));

  const paged = list.slice(offset, offset + limit);
  core.sendJson(res, 200, { leads: paged.map(publicLead), page, limit, total: list.length });
}

async function apiLeadsCreate(req, res, ctx) {
  const b = ctx.body || {};
  const phone = String(b.phone || '').trim().slice(0, 32);
  if (!phone) {
    return core.sendJson(res, 422, { error: 'phone is required', code: 'missing_phone' });
  }

  const name = String(b.name || '').trim().slice(0, 120);
  const email = String(b.email || '').trim().toLowerCase().slice(0, 180);
  const source = String(b.source || 'inbound_call').trim().slice(0, 40);
  const status = String(b.status || 'new').trim().slice(0, 40);
  const notes = String(b.notes || '').trim().slice(0, 2000);
  const assignedTo = String(b.assignedTo || b.assigned_to || '').trim().slice(0, 80);
  const now = new Date().toISOString();

  if (db.isPostgres) {
    const leadId = b.id ? String(b.id) : core.genId('lead_');
    const { rows } = await db.query(
      `INSERT INTO leads (id, tenant_id, name, phone, email, source, status, notes, assigned_to, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (tenant_id, phone) DO UPDATE SET
         name = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE leads.name END,
         email = CASE WHEN EXCLUDED.email <> '' THEN EXCLUDED.email ELSE leads.email END,
         status = CASE WHEN EXCLUDED.status <> 'new' THEN EXCLUDED.status ELSE leads.status END,
         notes = CASE WHEN EXCLUDED.notes <> '' THEN EXCLUDED.notes ELSE leads.notes END,
         assigned_to = CASE WHEN EXCLUDED.assigned_to <> '' THEN EXCLUDED.assigned_to ELSE leads.assigned_to END,
         updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [leadId, ctx.tenant.id, name, phone, email, source, status, notes, assignedTo, now, now]
    );
    const lead = rows[0];
    return core.sendJson(res, 200, { lead: publicLead(lead) });
  }

  let lead;
  await core.mutate((d) => {
    lead = d.leads.find((l) => (l.tenantId === ctx.tenant.id || l.tenant_id === ctx.tenant.id) && l.phone === phone);
    if (lead) {
      if (name) lead.name = name;
      if (email) lead.email = email;
      if (status && status !== 'new') lead.status = status;
      if (notes) lead.notes = notes;
      if (assignedTo) lead.assignedTo = assignedTo;
      lead.updatedAt = now;
    } else {
      lead = {
        id: b.id ? String(b.id) : core.genId('lead_'),
        tenantId: ctx.tenant.id,
        name,
        phone,
        email,
        source,
        status,
        notes,
        assignedTo,
        createdAt: now,
        updatedAt: now,
      };
      d.leads.push(lead);
    }
  });

  core.sendJson(res, 200, { lead: publicLead(lead) });
}

async function apiLeadsGet(req, res, ctx, id) {
  if (db.isPostgres) {
    const leadRes = await db.query('SELECT * FROM leads WHERE id = $1 AND tenant_id = $2', [id, ctx.tenant.id]);
    if (leadRes.rowCount === 0) {
      return core.sendJson(res, 404, { error: 'lead not found', code: 'not_found' });
    }
    const lead = leadRes.rows[0];
    const callsRes = await db.query('SELECT * FROM calls WHERE lead_id = $1 ORDER BY created_at DESC', [id]);
    const jobsRes = await db.query('SELECT * FROM hvac_jobs WHERE lead_id = $1 ORDER BY created_at DESC', [id]);
    return core.sendJson(res, 200, {
      lead: publicLead(lead),
      calls: callsRes.rows,
      hvacJobs: jobsRes.rows.map(publicHvacJob),
    });
  }

  const d = core.db();
  const lead = d.leads.find((l) => l.id === id && (l.tenantId === ctx.tenant.id || l.tenant_id === ctx.tenant.id));
  if (!lead) {
    return core.sendJson(res, 404, { error: 'lead not found', code: 'not_found' });
  }
  const calls = (d.calls || []).filter((c) => (c.leadId === id || c.lead_id === id));
  const hvacJobs = (d.hvacJobs || []).filter((j) => (j.leadId === id || j.lead_id === id));

  core.sendJson(res, 200, {
    lead: publicLead(lead),
    calls,
    hvacJobs: hvacJobs.map(publicHvacJob),
  });
}

async function apiLeadsPatch(req, res, ctx, id) {
  const b = ctx.body || {};
  const now = new Date().toISOString();

  if (db.isPostgres) {
    const existing = await db.query('SELECT * FROM leads WHERE id = $1 AND tenant_id = $2', [id, ctx.tenant.id]);
    if (existing.rowCount === 0) {
      return core.sendJson(res, 404, { error: 'lead not found', code: 'not_found' });
    }
    const current = existing.rows[0];
    const status = b.status !== undefined ? String(b.status).trim().slice(0, 40) : current.status;
    const notes = b.notes !== undefined ? String(b.notes).trim().slice(0, 2000) : current.notes;
    const name = b.name !== undefined ? String(b.name).trim().slice(0, 120) : current.name;
    const email = b.email !== undefined ? String(b.email).trim().toLowerCase().slice(0, 180) : current.email;
    const oldAssigned = current.assigned_to || '';
    const assignedTo = (b.assignedTo !== undefined || b.assigned_to !== undefined)
      ? String(b.assignedTo !== undefined ? b.assignedTo : b.assigned_to).trim().slice(0, 80)
      : oldAssigned;
    // Phase 7: pipeline fields
    const oldStage = current.pipeline_stage || 'new';
    const newStage = b.pipelineStage !== undefined ? String(b.pipelineStage).trim().slice(0, 40) : (b.pipeline_stage !== undefined ? String(b.pipeline_stage).trim().slice(0, 40) : oldStage);
    const stageChanged = newStage !== oldStage;
    const pipelineUpdatedAt = stageChanged ? now : (current.pipeline_updated_at || null);
    const valuePaise = b.valuePaise !== undefined ? Math.max(0, parseInt(b.valuePaise, 10) || 0) : (b.value_paise !== undefined ? Math.max(0, parseInt(b.value_paise, 10) || 0) : (current.value_paise || 0));
    const expectedCloseDate = b.expectedCloseDate !== undefined ? (b.expectedCloseDate || null) : (b.expected_close_date !== undefined ? (b.expected_close_date || null) : (current.expected_close_date || null));

    if (newStage && !PIPELINE_STAGES.includes(newStage)) {
      return core.sendJson(res, 422, { error: `invalid pipeline_stage. Must be one of: ${PIPELINE_STAGES.join(', ')}`, code: 'invalid_pipeline_stage' });
    }

    const { rows } = await db.query(
      `UPDATE leads
       SET status = $1, notes = $2, assigned_to = $3, name = $4, email = $5, updated_at = $6,
           pipeline_stage = $7, pipeline_updated_at = $8, value_paise = $9, expected_close_date = $10
       WHERE id = $11 AND tenant_id = $12
       RETURNING *`,
      [status, notes, assignedTo, name, email, now, newStage, pipelineUpdatedAt, valuePaise, expectedCloseDate, id, ctx.tenant.id]
    );
    const updatedLead = rows[0];
    // Auto-log stage change activity
    if (stageChanged) {
      const actId = core.genId('lact_');
      await db.query(
        `INSERT INTO lead_activities (id, lead_id, tenant_id, type, summary, metadata, actor_user_id, created_at)
         VALUES ($1, $2, $3, 'stage_change', $4, $5, $6, $7)`,
        [actId, id, ctx.tenant.id, `Stage changed from ${oldStage} to ${newStage}`, JSON.stringify({ from: oldStage, to: newStage }), ctx.user.id, now]
      );
    }
    // Auto-log assignment change
    if (assignedTo !== oldAssigned) {
      const actId = core.genId('lact_');
      await db.query(
        `INSERT INTO lead_activities (id, lead_id, tenant_id, type, summary, metadata, actor_user_id, created_at)
         VALUES ($1, $2, $3, 'assignment', $4, $5, $6, $7)`,
        [actId, id, ctx.tenant.id, `Assigned to ${assignedTo || 'unassigned'}`, JSON.stringify({ from: oldAssigned, to: assignedTo }), ctx.user.id, now]
      );
    }
    return core.sendJson(res, 200, { lead: publicLead(updatedLead) });
  }

  let lead;
  await core.mutate((d) => {
    lead = d.leads.find((l) => l.id === id && (l.tenantId === ctx.tenant.id || l.tenant_id === ctx.tenant.id));
    if (!lead) return;
    const oldStage = lead.pipelineStage || lead.pipeline_stage || 'new';
    const oldAssigned = lead.assignedTo || lead.assigned_to || '';
    if (b.status !== undefined) lead.status = String(b.status).trim().slice(0, 40);
    if (b.notes !== undefined) lead.notes = String(b.notes).trim().slice(0, 2000);
    if (b.name !== undefined) lead.name = String(b.name).trim().slice(0, 120);
    if (b.email !== undefined) lead.email = String(b.email).trim().toLowerCase().slice(0, 180);
    if (b.assignedTo !== undefined || b.assigned_to !== undefined) {
      lead.assignedTo = String(b.assignedTo !== undefined ? b.assignedTo : b.assigned_to).trim().slice(0, 80);
    }
    if (b.pipelineStage !== undefined || b.pipeline_stage !== undefined) {
      const ns = String(b.pipelineStage !== undefined ? b.pipelineStage : b.pipeline_stage).trim().slice(0, 40);
      if (PIPELINE_STAGES.includes(ns)) {
        if (ns !== oldStage) lead.pipelineUpdatedAt = now;
        lead.pipelineStage = ns;
      }
    }
    if (b.valuePaise !== undefined) lead.valuePaise = Math.max(0, parseInt(b.valuePaise, 10) || 0);
    if (b.value_paise !== undefined) lead.valuePaise = Math.max(0, parseInt(b.value_paise, 10) || 0);
    if (b.expectedCloseDate !== undefined) lead.expectedCloseDate = b.expectedCloseDate || null;
    if (b.expected_close_date !== undefined) lead.expectedCloseDate = b.expected_close_date || null;
    lead.updatedAt = now;
    // Auto-log activities in JSON mode (in-memory store)
    if (!d.leadActivities) d.leadActivities = [];
    const newStageVal = lead.pipelineStage || 'new';
    if (newStageVal !== oldStage) {
      d.leadActivities.push({ id: core.genId('lact_'), leadId: id, tenantId: ctx.tenant.id, type: 'stage_change', summary: `Stage changed from ${oldStage} to ${newStageVal}`, metadata: { from: oldStage, to: newStageVal }, actorUserId: ctx.user.id, createdAt: now });
    }
    const newAssigned = lead.assignedTo || '';
    if (newAssigned !== oldAssigned) {
      d.leadActivities.push({ id: core.genId('lact_'), leadId: id, tenantId: ctx.tenant.id, type: 'assignment', summary: `Assigned to ${newAssigned || 'unassigned'}`, metadata: { from: oldAssigned, to: newAssigned }, actorUserId: ctx.user.id, createdAt: now });
    }
  });

  if (!lead) {
    return core.sendJson(res, 404, { error: 'lead not found', code: 'not_found' });
  }
  core.sendJson(res, 200, { lead: publicLead(lead) });
}

async function apiLeadsDelete(req, res, ctx, id) {
  const now = new Date().toISOString();

  if (db.isPostgres) {
    const { rows, rowCount } = await db.query(
      `UPDATE leads
       SET status = 'closed', updated_at = $1
       WHERE id = $2 AND tenant_id = $3
       RETURNING *`,
      [now, id, ctx.tenant.id]
    );
    if (rowCount === 0) {
      return core.sendJson(res, 404, { error: 'lead not found', code: 'not_found' });
    }
    return core.sendJson(res, 200, { success: true, lead: publicLead(rows[0]) });
  }

  let lead;
  await core.mutate((d) => {
    lead = d.leads.find((l) => l.id === id && (l.tenantId === ctx.tenant.id || l.tenant_id === ctx.tenant.id));
    if (!lead) return;
    lead.status = 'closed';
    lead.updatedAt = now;
  });

  if (!lead) {
    return core.sendJson(res, 404, { error: 'lead not found', code: 'not_found' });
  }
  core.sendJson(res, 200, { success: true, lead: publicLead(lead) });
}

// Phase 7: Bulk update pipeline_stage or assigned_to for multiple leads
async function apiLeadsBulkUpdate(req, res, ctx) {
  const b = ctx.body || {};
  const ids = Array.isArray(b.ids) ? b.ids.map((i) => String(i)).filter(Boolean).slice(0, 200) : [];
  if (!ids.length) return core.sendJson(res, 422, { error: 'ids array is required', code: 'missing_ids' });

  const updates = {};
  const now = new Date().toISOString();
  if (b.pipelineStage !== undefined || b.pipeline_stage !== undefined) {
    const ns = String(b.pipelineStage !== undefined ? b.pipelineStage : b.pipeline_stage).trim();
    if (!PIPELINE_STAGES.includes(ns)) {
      return core.sendJson(res, 422, { error: `invalid pipeline_stage. Must be one of: ${PIPELINE_STAGES.join(', ')}`, code: 'invalid_pipeline_stage' });
    }
    updates.pipeline_stage = ns;
    updates.pipeline_updated_at = now;
  }
  if (b.assignedTo !== undefined || b.assigned_to !== undefined) {
    updates.assigned_to = String(b.assignedTo !== undefined ? b.assignedTo : b.assigned_to).trim().slice(0, 80);
  }
  if (!Object.keys(updates).length) return core.sendJson(res, 422, { error: 'no updatable fields provided', code: 'no_fields' });

  if (db.isPostgres) {
    const setClauses = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`).join(', ');
    const vals = Object.values(updates);
    // Build placeholders for ids (start after now + vals + tenant_id)
    const idPlaceholders = ids.map((_, i) => `$${vals.length + 3 + i}`).join(', ');
    const { rowCount } = await db.query(
      `UPDATE leads SET ${setClauses}, updated_at = $1 WHERE tenant_id = $${vals.length + 2} AND id IN (${idPlaceholders})`,
      [now, ...vals, ctx.tenant.id, ...ids]
    );
    return core.sendJson(res, 200, { updated: rowCount });
  }

  let updated = 0;
  await core.mutate((d) => {
    for (const lead of d.leads) {
      if ((lead.tenantId === ctx.tenant.id || lead.tenant_id === ctx.tenant.id) && ids.includes(lead.id)) {
        if (updates.pipeline_stage) { lead.pipelineStage = updates.pipeline_stage; lead.pipelineUpdatedAt = now; }
        if (updates.assigned_to !== undefined) lead.assignedTo = updates.assigned_to;
        lead.updatedAt = now;
        updated++;
      }
    }
  });
  core.sendJson(res, 200, { updated });
}

// Phase 7: CRM pipeline kanban summary — counts + total value by stage
async function apiCrmPipeline(req, res, ctx) {
  const byStage = {};
  for (const s of PIPELINE_STAGES) byStage[s] = { count: 0, totalValuePaise: 0 };

  if (db.isPostgres) {
    const { rows } = await db.query(
      `SELECT COALESCE(pipeline_stage, 'new') AS pipeline_stage,
              COUNT(*) AS count,
              COALESCE(SUM(value_paise), 0) AS total_value_paise
       FROM leads WHERE tenant_id = $1 AND status != 'closed'
       GROUP BY COALESCE(pipeline_stage, 'new')`,
      [ctx.tenant.id]
    );
    for (const r of rows) {
      const stage = PIPELINE_STAGES.includes(r.pipeline_stage) ? r.pipeline_stage : 'new';
      const c = parseInt(r.count, 10) || 0;
      const val = Math.max(0, parseInt(r.total_value_paise, 10) || 0);
      if (byStage[stage]) {
        byStage[stage].count += c;
        byStage[stage].totalValuePaise += val;
      }
    }
    return core.sendJson(res, 200, { pipeline: byStage, stages: PIPELINE_STAGES });
  }

  const leads = core.db().leads.filter((l) => (l.tenantId === ctx.tenant.id || l.tenant_id === ctx.tenant.id) && (l.status !== 'closed'));
  for (const l of leads) {
    const rawStage = l.pipelineStage || l.pipeline_stage;
    const s = PIPELINE_STAGES.includes(rawStage) ? rawStage : 'new';
    if (byStage[s]) {
      byStage[s].count++;
      byStage[s].totalValuePaise += Math.max(0, parseInt(l.valuePaise !== undefined ? l.valuePaise : l.value_paise, 10) || 0);
    }
  }
  core.sendJson(res, 200, { pipeline: byStage, stages: PIPELINE_STAGES });
}

// Phase 7: CRM analytics — conversion rates, team perf, source breakdown, trend
async function apiCrmAnalytics(req, res, ctx) {
  if (db.isPostgres) {
    const [stageRes, assigneeRes, sourceRes, monthRes, wonTimeRes] = await Promise.all([
      db.query(`SELECT pipeline_stage, COUNT(*) AS count, COALESCE(SUM(value_paise),0) AS total_value FROM leads WHERE tenant_id=$1 GROUP BY pipeline_stage`, [ctx.tenant.id]),
      db.query(`SELECT assigned_to, COUNT(*) AS count FROM leads WHERE tenant_id=$1 AND assigned_to IS NOT NULL AND assigned_to!='' GROUP BY assigned_to ORDER BY count DESC LIMIT 10`, [ctx.tenant.id]),
      db.query(`SELECT source, COUNT(*) AS count FROM leads WHERE tenant_id=$1 GROUP BY source ORDER BY count DESC`, [ctx.tenant.id]),
      db.query(`SELECT DATE_TRUNC('month', created_at) AS month, COUNT(*) AS count FROM leads WHERE tenant_id=$1 AND created_at > NOW()-INTERVAL '6 months' GROUP BY month ORDER BY month ASC`, [ctx.tenant.id]),
      db.query(`SELECT AVG(EXTRACT(EPOCH FROM (pipeline_updated_at - created_at))/3600) AS avg_hours FROM leads WHERE tenant_id=$1 AND pipeline_stage='won' AND pipeline_updated_at IS NOT NULL`, [ctx.tenant.id]),
    ]);
    const total = stageRes.rows.reduce((sum, r) => sum + parseInt(r.count, 10), 0);
    const won = (stageRes.rows.find((r) => r.pipeline_stage === 'won') || {}).count || 0;
    const nonNew = stageRes.rows.filter((r) => r.pipeline_stage !== 'new').reduce((sum, r) => sum + parseInt(r.count, 10), 0);
    return core.sendJson(res, 200, {
      totalLeads: total,
      byStage: Object.fromEntries(stageRes.rows.map((r) => [r.pipeline_stage, { count: parseInt(r.count, 10), totalValuePaise: parseInt(r.total_value, 10) }])),
      conversionRate: nonNew > 0 ? Math.round((parseInt(won, 10) / nonNew) * 10000) / 100 : 0,
      avgTimeToWonHours: wonTimeRes.rows[0]?.avg_hours ? Math.round(parseFloat(wonTimeRes.rows[0].avg_hours) * 10) / 10 : null,
      topAssignees: assigneeRes.rows.map((r) => ({ assignedTo: r.assigned_to, count: parseInt(r.count, 10) })),
      bySource: Object.fromEntries(sourceRes.rows.map((r) => [r.source, parseInt(r.count, 10)])),
      monthlyTrend: monthRes.rows.map((r) => ({ month: r.month, count: parseInt(r.count, 10) })),
    });
  }
  // JSON driver fallback
  const leads = core.db().leads.filter((l) => (l.tenantId === ctx.tenant.id || l.tenant_id === ctx.tenant.id));
  const byStage = {};
  const bySource = {};
  const byAssignee = {};
  for (const l of leads) {
    const s = l.pipelineStage || l.pipeline_stage || 'new';
    const src = l.source || 'inbound_call';
    const asgn = l.assignedTo || l.assigned_to || '';
    byStage[s] = byStage[s] || { count: 0, totalValuePaise: 0 };
    byStage[s].count++; byStage[s].totalValuePaise += (l.valuePaise || l.value_paise || 0);
    bySource[src] = (bySource[src] || 0) + 1;
    if (asgn) byAssignee[asgn] = (byAssignee[asgn] || 0) + 1;
  }
  const total = leads.length;
  const won = (byStage.won || {}).count || 0;
  const nonNew = Object.entries(byStage).filter(([k]) => k !== 'new').reduce((s, [, v]) => s + v.count, 0);
  core.sendJson(res, 200, {
    totalLeads: total,
    byStage,
    conversionRate: nonNew > 0 ? Math.round((won / nonNew) * 10000) / 100 : 0,
    avgTimeToWonHours: null,
    topAssignees: Object.entries(byAssignee).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => ({ assignedTo: k, count: v })),
    bySource,
    monthlyTrend: [],
  });
}

// Phase 7: Lead activity timeline — list
async function apiLeadActivitiesList(req, res, ctx, leadId) {
  const q = new URL(req.url, 'http://local').searchParams;
  const page = Math.max(1, parseInt(q.get('page') || '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(q.get('limit') || '20', 10) || 20));
  const offset = (page - 1) * limit;

  if (db.isPostgres) {
    const exists = await db.query('SELECT id FROM leads WHERE id=$1 AND tenant_id=$2', [leadId, ctx.tenant.id]);
    if (exists.rowCount === 0) return core.sendJson(res, 404, { error: 'lead not found', code: 'not_found' });
    const { rows } = await db.query(
      'SELECT * FROM lead_activities WHERE lead_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [leadId, limit, offset]
    );
    const total = await db.query('SELECT COUNT(*) AS c FROM lead_activities WHERE lead_id=$1', [leadId]);
    return core.sendJson(res, 200, { activities: rows, page, limit, total: parseInt(total.rows[0].c, 10) });
  }
  const d = core.db();
  const lead = (d.leads || []).find((l) => l.id === leadId && (l.tenantId === ctx.tenant.id || l.tenant_id === ctx.tenant.id));
  if (!lead) return core.sendJson(res, 404, { error: 'lead not found', code: 'not_found' });
  const acts = ((d.leadActivities || []).filter((a) => a.leadId === leadId)).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  core.sendJson(res, 200, { activities: acts.slice(offset, offset + limit), page, limit, total: acts.length });
}

// Phase 7: Lead activity timeline — create (manual note/call/email/meeting)
async function apiLeadActivitiesCreate(req, res, ctx, leadId) {
  const b = ctx.body || {};
  const allowedTypes = ['note', 'call', 'email', 'meeting'];
  const type = String(b.type || '').trim();
  if (!allowedTypes.includes(type)) {
    return core.sendJson(res, 422, { error: `type must be one of: ${allowedTypes.join(', ')}`, code: 'invalid_type' });
  }
  const summary = String(b.summary || '').trim().slice(0, 2000);
  const metadata = (b.metadata && typeof b.metadata === 'object') ? b.metadata : {};
  const now = new Date().toISOString();
  const actId = core.genId('lact_');

  if (db.isPostgres) {
    const exists = await db.query('SELECT id FROM leads WHERE id=$1 AND tenant_id=$2', [leadId, ctx.tenant.id]);
    if (exists.rowCount === 0) return core.sendJson(res, 404, { error: 'lead not found', code: 'not_found' });
    const { rows } = await db.query(
      `INSERT INTO lead_activities (id, lead_id, tenant_id, type, summary, metadata, actor_user_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [actId, leadId, ctx.tenant.id, type, summary, JSON.stringify(metadata), ctx.user.id, now]
    );
    return core.sendJson(res, 201, { activity: rows[0] });
  }
  let activity;
  await core.mutate((d) => {
    const lead = (d.leads || []).find((l) => l.id === leadId && (l.tenantId === ctx.tenant.id || l.tenant_id === ctx.tenant.id));
    if (!lead) return;
    if (!d.leadActivities) d.leadActivities = [];
    activity = { id: actId, leadId, tenantId: ctx.tenant.id, type, summary, metadata, actorUserId: ctx.user.id, createdAt: now };
    d.leadActivities.push(activity);
  });
  if (!activity) return core.sendJson(res, 404, { error: 'lead not found', code: 'not_found' });
  core.sendJson(res, 201, { activity });
}

async function apiAgentsList(req, res, ctx) {
  if (db.isPostgres) {
    const { rows } = await db.query('SELECT * FROM agents WHERE tenant_id = $1 ORDER BY created_at DESC', [ctx.tenant.id]);
    const agents = rows.map((a) => publicAgent({ ...a, tenantId: a.tenant_id, presetId: a.preset_id, createdAt: a.created_at.toISOString() }));
    return core.sendJson(res, 200, { agents });
  }
  const agents = core.db().agents
    .filter((a) => a.tenantId === ctx.tenant.id)
    .map(publicAgent);
  core.sendJson(res, 200, { agents });
}

async function apiAgentsCreate(req, res, ctx) {
  const b = ctx.body || {};
  let preset = null;
  if (db.isPostgres) {
    if (b.presetId) {
      const pRes = await db.query('SELECT * FROM presets WHERE id = $1 AND (is_system = true OR tenant_id = $2)', [String(b.presetId), ctx.tenant.id]);
      if (pRes.rowCount === 0) return core.sendJson(res, 404, { error: 'preset not found', code: 'not_found' });
      const pRow = pRes.rows[0];
      preset = { ...pRow, isSystem: pRow.is_system, tenantId: pRow.tenant_id, fields: pRow.fields || [], guardrails: pRow.guardrails || [] };
    }
  } else {
    preset = b.presetId ? core.db().presets.find((p) => p.id === String(b.presetId) && (p.isSystem || p.tenantId === ctx.tenant.id)) : null;
    if (b.presetId && !preset) return core.sendJson(res, 404, { error: 'preset not found', code: 'not_found' });
  }
  const ttsIn = b.tts || {};
  const model = ttsIn.model === 'muga' ? 'muga' : providers.tts.model;
  const speaker = providers.TTS_SPEAKERS.has(ttsIn.speaker) ? ttsIn.speaker : 'speaker_1';
  const f0 = Number.isFinite(ttsIn.f0_up_key) ? Math.max(-12, Math.min(12, ttsIn.f0_up_key | 0)) : 0;

  const agent = {
    id: core.genId('ag_'),
    tenantId: ctx.tenant.id,
    name: String(b.name || (preset && preset.name) || 'Untitled Agent').slice(0, 60),
    persona: String(b.persona || (preset ? `${preset.name}. Collect: ${(preset.fields||[]).join(', ')}. Guardrails: ${(preset.guardrails||[]).join('; ')}.` : '')).slice(0, 1500),
    tts: { provider: providers.tts.id, model, speaker, f0_up_key: f0 },
    greeting: String(b.greeting || (preset && preset.greeting) || '').slice(0, 300),
    presetId: preset ? preset.id : null,
    telephony: { did: String(b.did || providers.telephony.did).replace(/[^0-9]/g, '') || providers.telephony.did },
    createdAt: new Date().toISOString(),
  };

  if (db.isPostgres) {
    await db.query(
      'INSERT INTO agents (id, tenant_id, name, persona, tts, greeting, telephony, preset_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [agent.id, agent.tenantId, agent.name, agent.persona, agent.tts, agent.greeting, agent.telephony, agent.presetId, agent.createdAt]
    );
  } else {
    await core.mutate((d) => { d.agents.push(agent); });
  }
  core.sendJson(res, 200, { agent: publicAgent(agent) });
}

async function apiAgentsUpdate(req, res, ctx) {
  const b = ctx.body || {};
  const id = String(b.id || '');
  let updated;
  
  if (db.isPostgres) {
    const aRes = await db.query('SELECT * FROM agents WHERE id = $1', [id]);
    if (aRes.rowCount === 0) return core.sendJson(res, 404, { error: 'agent not found', code: 'not_found' });
    const aRow = aRes.rows[0];
    if (aRow.tenant_id !== ctx.tenant.id) return core.sendJson(res, 403, { error: 'not your agent', code: 'forbidden' });
    
    let tts = aRow.tts || { provider: providers.tts.id };
    if (b.tts && typeof b.tts === 'object') {
      if (b.tts.model != null) tts.model = b.tts.model === 'muga' ? 'muga' : providers.tts.model;
      if (providers.TTS_SPEAKERS.has(b.tts.speaker)) tts.speaker = b.tts.speaker;
      if (Number.isFinite(b.tts.f0_up_key)) tts.f0_up_key = Math.max(-12, Math.min(12, b.tts.f0_up_key | 0));
      tts.provider = providers.tts.id;
    }
    
    let telephony = aRow.telephony || {};
    if (b.did != null) telephony.did = String(b.did).replace(/[^0-9]/g, '') || providers.telephony.did;
    
    const name = b.name != null ? String(b.name).slice(0, 60) : aRow.name;
    const persona = b.persona != null ? String(b.persona).slice(0, 1500) : aRow.persona;
    const greeting = b.greeting != null ? String(b.greeting).slice(0, 300) : aRow.greeting;
    
    const upRes = await db.query(
      'UPDATE agents SET name = $1, persona = $2, greeting = $3, telephony = $4, tts = $5 WHERE id = $6 RETURNING *',
      [name, persona, greeting, telephony, tts, id]
    );
    const row = upRes.rows[0];
    updated = { ...row, tenantId: row.tenant_id, presetId: row.preset_id, createdAt: row.created_at.toISOString() };
  } else {
    const d = core.db();
    const agent = d.agents.find((a) => a.id === id);
    if (!agent) return core.sendJson(res, 404, { error: 'agent not found', code: 'not_found' });
    if (agent.tenantId !== ctx.tenant.id) {
      return core.sendJson(res, 403, { error: 'not your agent', code: 'forbidden' });
    }
    await core.mutate((dd) => {
      const a = dd.agents.find((x) => x.id === id);
      if (b.name != null) a.name = String(b.name).slice(0, 60);
      if (b.persona != null) a.persona = String(b.persona).slice(0, 1500);
      if (b.greeting != null) a.greeting = String(b.greeting).slice(0, 300);
      if (b.did != null) {
        const did = String(b.did).replace(/[^0-9]/g, '');
        a.telephony = { ...(a.telephony || {}), did: did || providers.telephony.did };
      }
      if (b.tts && typeof b.tts === 'object') {
        const t = a.tts || { provider: providers.tts.id };
        if (b.tts.model != null) t.model = b.tts.model === 'muga' ? 'muga' : providers.tts.model;
        if (providers.TTS_SPEAKERS.has(b.tts.speaker)) t.speaker = b.tts.speaker;
        if (Number.isFinite(b.tts.f0_up_key)) t.f0_up_key = Math.max(-12, Math.min(12, b.tts.f0_up_key | 0));
        t.provider = providers.tts.id;
        a.tts = t;
      }
      updated = a;
    });
  }
  core.sendJson(res, 200, { agent: publicAgent(updated) });
}

async function apiAgentsDelete(req, res, ctx) {
  const id = String((ctx.body || {}).id || '');
  if (db.isPostgres) {
    const aRes = await db.query('SELECT tenant_id FROM agents WHERE id = $1', [id]);
    if (aRes.rowCount === 0) return core.sendJson(res, 404, { error: 'agent not found', code: 'not_found' });
    if (aRes.rows[0].tenant_id !== ctx.tenant.id) return core.sendJson(res, 403, { error: 'not your agent', code: 'forbidden' });
    await db.query('DELETE FROM agents WHERE id = $1', [id]);
  } else {
    const agent = core.db().agents.find((a) => a.id === id);
    if (!agent) return core.sendJson(res, 404, { error: 'agent not found', code: 'not_found' });
    if (agent.tenantId !== ctx.tenant.id) {
      return core.sendJson(res, 403, { error: 'not your agent', code: 'forbidden' });
    }
    await core.mutate((d) => { d.agents = d.agents.filter((a) => a.id !== id); });
  }
  core.sendJson(res, 200, { ok: true });
}

// POST /api/tts -> Rumik WAV bytes. Increments tenant usage.chars.
async function apiTts(req, res, ctx) {
  const b = ctx.body || {};
  try {
    const selected = providers.resolveSelection('tts', { provider: b.provider, model: b.model });
    const out = await selected.adapter.synthesize({
      text: b.text,
      model: selected.model,
      speaker: b.speaker,
      f0_up_key: b.f0_up_key,
      description: b.description,
    });
    // Count usage only on a real synthesis.
    bumpUsage(ctx.tenant.id, 'chars', out.chars).catch(() => {});
    core.send(res, 200, out.buffer, {
      'Content-Type': 'audio/wav',
      'Content-Length': out.buffer.length,
      'X-Credits-Used': out.credits,
      'X-Chars': String(out.chars),
    });
  } catch (e) {
    handleProviderError(res, e);
  }
}

// POST /api/ws-connect -> { ws_url, token } (Rumik streaming mint).
async function apiWsConnect(req, res, ctx) {
  const b = ctx.body || {};
  try {
    const selected = providers.resolveSelection('tts', { provider: b.provider, model: b.model });
    const data = await selected.adapter.wsConnect({ text: b.text, model: selected.model });
    core.sendJson(res, 200, { ...data, provider: selected.provider, model: selected.model });
  } catch (e) {
    handleProviderError(res, e);
  }
}

// POST /api/chat -> { text, finish, provider, model, latency_ms } (Groq brain).
async function apiChat(req, res, ctx) {
  const b = ctx.body || {};
  try {
    const selected = providers.resolveSelection('llm', { provider: b.provider, model: b.model });
    const out = await selected.adapter.chat({ messages: b.messages, system: b.system, model: selected.model });
    // Rough token accounting for the usage view (4 chars ~= 1 token).
    const approxTokens = Math.ceil((out.text || '').length / 4);
    bumpUsage(ctx.tenant.id, 'llmTokens', approxTokens).catch(() => {});
    core.sendJson(res, 200, out);
  } catch (e) {
    handleProviderError(res, e);
  }
}

// POST /api/stt -> { text, provider, model, latency_ms } (Deepgram Nova-3).
async function apiStt(req, res, ctx) {
  const b = ctx.body || {};
  try {
    const out = await providers.stt.transcribe({ audio: b.audio, mime: b.mime });
    core.sendJson(res, 200, out);
  } catch (e) {
    handleProviderError(res, e);
  }
}

async function mintDograhVoiceSession(req, context) {
  const token = String(process.env.DOGRAH_EMBED_TOKEN || '').trim();
  const base = String(process.env.DOGRAH_BASE_URL || '').replace(/\/$/, '');
  if (!token || !base) {
    const error = new Error('realtime voice session is not configured');
    error.status = 503; error.code = 'voice_session_unavailable'; throw error;
  }
  const requestOrigin = String(req.headers.origin || `https://${req.headers.host || ''}`);
  const upstream = await fetch(base + '/api/v1/public/embed/init', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: requestOrigin },
    body: JSON.stringify({ token, context_variables: {
      source: String(context.source || 'rumik_studio'),
      tenant_id: String(context.tenantId || ''),
      agent_id: String(context.agentId || ''),
      demo_link_id: String(context.demoLinkId || ''),
      max_session_seconds: String(context.maxSessionSeconds || ''),
    } }),
    signal: AbortSignal.timeout(12000),
  });
  const text = await upstream.text(); let data = {};
  try { data = JSON.parse(text); } catch (_) {}
  if (!upstream.ok) {
    const error = new Error(String(data.detail || 'Dograh could not start the realtime voice session'));
    error.status = upstream.status; error.code = 'voice_session_failed'; throw error;
  }
  const sessionToken = String(data.session_token || '');
  let turnCredentials = null;
  if (sessionToken) {
    try {
      const turnUpstream = await fetch(base + '/api/v1/public/embed/turn-credentials/' + encodeURIComponent(sessionToken), {
        method: 'GET', headers: { Origin: requestOrigin }, signal: AbortSignal.timeout(8000),
      });
      if (turnUpstream.ok) {
        const turnData = await turnUpstream.json();
        if (Array.isArray(turnData.uris) && turnData.uris.length && turnData.username && turnData.password) {
          turnCredentials = {
            uris: turnData.uris,
            username: String(turnData.username),
            password: String(turnData.password),
            ttl: Number(turnData.ttl || 0),
          };
        }
      }
    } catch (_) {}
  }
  return {
    sessionToken: data.session_token, workflowRunId: data.workflow_run_id,
    workflowId: data.config && data.config.workflow_id,
    signalingUrl: base.replace(/^http/, 'ws') + '/api/v1/ws/public/signaling/' + encodeURIComponent(data.session_token),
    turnCredentials,
    runtime: 'Dograh SmallWebRTC',
  };
}

async function apiVoiceSession(req, res, ctx) {
  try {
    const session = await mintDograhVoiceSession(req, {
      source: 'rumik_studio', tenantId: ctx.tenant.id, agentId: (ctx.body || {}).agentId,
    });
    core.sendJson(res, 200, session);
  } catch (error) {
    core.sendJson(res, error.status || 502, { error: error.message || 'Dograh realtime voice session failed', code: error.code || 'voice_session_failed' });
  }
}

function tenantDemoLinks(tenantId) {
  return core.db().demoLinks.filter((link) => link.tenantId === tenantId);
}

async function apiDemoLinksList(req, res, ctx) {
  if (db.isPostgres) {
    const { rows } = await db.query('SELECT * FROM demo_links WHERE tenant_id = $1 ORDER BY created_at DESC', [ctx.tenant.id]);
    const links = rows.map(r => demoLinks.publicDemoLink({
      ...r, tenantId: r.tenant_id, agentId: r.agent_id, tokenHash: r.token_hash, maxStarts: r.max_starts, maxSessionSeconds: r.max_session_seconds, expiresAt: r.expires_at ? r.expires_at.toISOString() : null, revokedAt: r.revoked_at ? r.revoked_at.toISOString() : null, revokedBy: r.revoked_by, createdBy: r.created_by, createdAt: r.created_at.toISOString()
    }));
    return core.sendJson(res, 200, { demoLinks: links });
  }
  const links = tenantDemoLinks(ctx.tenant.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((link) => demoLinks.publicDemoLink(link));
  core.sendJson(res, 200, { demoLinks: links });
}

async function apiDemoLinksCreate(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const body = ctx.body || {};
  let agent;
  
  if (db.isPostgres) {
    const aRes = await db.query('SELECT id, name FROM agents WHERE id = $1 AND tenant_id = $2', [String(body.agentId || ''), ctx.tenant.id]);
    if (aRes.rowCount === 0) return core.sendJson(res, 404, { error: 'agent not found', code: 'not_found' });
    agent = aRes.rows[0];
  } else {
    agent = core.db().agents.find((item) => item.id === String(body.agentId || '') && item.tenantId === ctx.tenant.id);
    if (!agent) return core.sendJson(res, 404, { error: 'agent not found', code: 'not_found' });
  }
  
  const generated = demoLinks.createDemoToken();
  const limits = demoLinks.normalizeDemoLimits(body);
  const link = {
    id: generated.id, tokenHash: generated.tokenHash, tenantId: ctx.tenant.id, agentId: agent.id,
    label: String(body.label || `${agent.name} demo`).trim().slice(0, 80) || `${agent.name} demo`,
    status: 'active', starts: 0, createdBy: ctx.user.id, createdAt: new Date().toISOString(),
    ...limits,
  };
  
  if (db.isPostgres) {
    await db.transaction(async (client) => {
      await client.query(
        'INSERT INTO demo_links (id, token_hash, tenant_id, agent_id, label, status, starts, max_starts, max_session_seconds, expires_at, revoked_at, revoked_by, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)',
        [link.id, link.tokenHash, link.tenantId, link.agentId, link.label, link.status, link.starts, link.maxStarts, link.maxSessionSeconds, link.expiresAt, link.revokedAt, link.revokedBy, link.createdBy, link.createdAt]
      );
      await db.addAuditSql(client, ctx, 'demo_link.created', 'demo_link', link.id, { agentId: agent.id, expiresAt: link.expiresAt, maxStarts: link.maxStarts });
    });
  } else {
    await core.mutate((database) => {
      database.demoLinks.push(link);
      addAudit(database, ctx, 'demo_link.created', 'demo_link', link.id, { agentId: agent.id, expiresAt: link.expiresAt, maxStarts: link.maxStarts });
    });
  }
  core.sendJson(res, 201, { demoLink: demoLinks.publicDemoLink(link), sharePath: `/demo/${generated.token}` });
}

async function apiDemoLinksRevoke(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const id = String((ctx.body || {}).id || '');
  
  if (db.isPostgres) {
    const lRes = await db.query('SELECT agent_id FROM demo_links WHERE id = $1 AND tenant_id = $2', [id, ctx.tenant.id]);
    if (lRes.rowCount === 0) return core.sendJson(res, 404, { error: 'demo link not found', code: 'not_found' });
    await db.transaction(async (client) => {
      await client.query('UPDATE demo_links SET status = $1, revoked_at = $2, revoked_by = $3 WHERE id = $4', ['revoked', new Date().toISOString(), ctx.user.id, id]);
      await db.addAuditSql(client, ctx, 'demo_link.revoked', 'demo_link', id, { agentId: lRes.rows[0].agent_id });
    });
  } else {
    const link = core.db().demoLinks.find((item) => item.id === id && item.tenantId === ctx.tenant.id);
    if (!link) return core.sendJson(res, 404, { error: 'demo link not found', code: 'not_found' });
    await core.mutate((database) => {
      const target = database.demoLinks.find((item) => item.id === id && item.tenantId === ctx.tenant.id);
      target.status = 'revoked'; target.revokedAt = new Date().toISOString(); target.revokedBy = ctx.user.id;
      addAudit(database, ctx, 'demo_link.revoked', 'demo_link', id, { agentId: target.agentId });
    });
  }
  core.sendJson(res, 200, { ok: true });
}

function publicDemoContext(token) {
  const database = core.db();
  const link = demoLinks.findDemoLink(database, token);
  if (!link) return null;
  const tenant = database.tenants.find((item) => item.id === link.tenantId && item.status === 'active');
  const agent = database.agents.find((item) => item.id === link.agentId && item.tenantId === link.tenantId);
  if (!tenant || !agent) return null;
  const color = String((tenant.branding || {}).color || '#B88A2D');
  return { link, tenant, agent, color: /^#[0-9A-Fa-f]{6}$/.test(color) ? color : '#B88A2D' };
}

function apiPublicDemoMeta(req, res, token) {
  const context = publicDemoContext(token);
  if (!context) return core.sendJson(res, 404, { error: 'demo link not found', code: 'not_found' });
  const status = demoLinks.demoLinkStatus(context.link);
  core.sendJson(res, 200, {
    demo: { id: context.link.id, label: context.link.label, status, expiresAt: context.link.expiresAt, maxSessionSeconds: context.link.maxSessionSeconds },
    brand: { name: context.tenant.name, color: context.color },
    agent: { name: context.agent.name, greeting: String(context.agent.greeting || '').slice(0, 300) },
  });
}

async function apiPublicDemoSession(req, res, token) {
  const context = publicDemoContext(token);
  if (!context) return core.sendJson(res, 404, { error: 'demo link not found', code: 'not_found' });
  let reserved = false;
  try {
    await core.mutate((database) => {
      const target = database.demoLinks.find((item) => item.id === context.link.id);
      const status = demoLinks.demoLinkStatus(target);
      if (status !== 'active') {
        const error = new Error(`this demo link is ${status}`);
        error.status = 410; error.code = `demo_${status}`; throw error;
      }
      target.starts = Number(target.starts || 0) + 1;
      target.lastStartedAt = new Date().toISOString();
      reserved = true;
    });
    const session = await mintDograhVoiceSession(req, {
      source: 'public_demo', tenantId: context.tenant.id, agentId: context.agent.id,
      demoLinkId: context.link.id, maxSessionSeconds: context.link.maxSessionSeconds,
    });
    core.sendJson(res, 200, { ...session, maxSessionSeconds: context.link.maxSessionSeconds });
  } catch (error) {
    if (reserved) await core.mutate((database) => {
      const target = database.demoLinks.find((item) => item.id === context.link.id);
      if (target) target.starts = Math.max(0, Number(target.starts || 0) - 1);
    }).catch(() => {});
    core.sendJson(res, error.status || 502, { error: error.message || 'realtime demo failed', code: error.code || 'voice_session_failed' });
  }
}

// GET /api/telephony/status -> VoBiz configuration status from Dograh.
async function apiTelephonyStatus(req, res) {
  try {
    const status = await providers.telephony.status();
    core.sendJson(res, 200, { ...status, provider: 'vobiz', orchestrator: 'dograh' });
  } catch (e) {
    handleProviderError(res, e);
  }
}

// POST /api/telephony/dial -> places a REAL paid call. GUARDED behind confirm.
// Body: { number: string, confirm: true }
// Accepts standard E.164 format (e.g. +14155552671, +447911123456) or bare 10-digit Indian mobile.
async function apiTelephonyDial(req, res, ctx) {
  const b = ctx.body || {};
  if (b.confirm !== true) {
    return core.sendJson(res, 400, {
      error: 'confirm required: this places a REAL paid call',
      code: 'needs_confirm',
    });
  }
  let workflowId;
  if (ctx.tenant.privacyMode === 'no_recording') {
    workflowId = Number(process.env.DOGRAH_NO_RECORDING_WORKFLOW_ID || 0);
    if (!Number.isInteger(workflowId) || workflowId <= 0) {
      return core.sendJson(res, 409, {
        error: 'HIPAA mode blocks phone calls until a verified no-recording Dograh workflow is configured',
        code: 'privacy_workflow_required',
      });
    }
  }
  try {
    const r = await providers.telephony.dial(b.number, { workflowId });
    // Count the dial attempt against today's usage.
    bumpUsage(ctx.tenant.id, 'calls', 1).catch(() => {});
    core.sendJson(res, r.status, r.data);
  } catch (e) {
    handleProviderError(res, e);
  }
}

// POST /api/webhooks/dograh/call-completed -> Trigger engine for post-call automations.
async function apiWebhookDograhCallCompleted(req, res, body = {}) {
  const expectedSecret = process.env.DOGRAH_WEBHOOK_SECRET;
  if (expectedSecret) {
    const headerSecret = req.headers['x-dograh-webhook-secret'] || req.headers['x-webhook-secret'];
    if (!headerSecret || headerSecret !== expectedSecret) {
      return core.sendJson(res, 401, { error: 'invalid or missing webhook secret', code: 'unauthorized_webhook' });
    }
  }

  const callId = String(body.call_id || body.workflow_run_id || core.genId('call_')).trim();
  const callerNumber = String(body.caller_number || body.from || body.caller || '').trim();
  const calledNumber = String(body.called_number || body.to || body.did || '').trim();
  const duration = Math.max(0, Math.round(Number(body.duration || body.call_duration_seconds || 0)));
  const rawDisposition = String(body.disposition || body.status || 'completed').trim().toLowerCase();
  const isMissed = ['no-answer', 'busy', 'failed', 'missed', 'canceled', 'cancelled'].includes(rawDisposition);
  const status = isMissed ? 'missed' : 'completed';
  const recordingUrl = String(body.recording_url || '').trim();
  const transcript = String(body.transcript || body.text || '').trim();
  const gatheredContext = (body.gathered_context && typeof body.gathered_context === 'object') ? body.gathered_context : {};
  const callerName = String(gatheredContext.name || body.caller_name || 'Caller').trim();

  let tenantId = body.tenant_id;
  if (!tenantId) {
    const urlParts = (req.url || '').split('?');
    if (urlParts[1]) {
      const q = new URLSearchParams(urlParts[1]);
      tenantId = q.get('tenant_id');
    }
  }

  if (db.isPostgres) {
    if (!tenantId) {
      const byonRes = await db.query(
        'SELECT tenant_id FROM byon_connections WHERE address = $1 OR address = $2 LIMIT 1',
        [calledNumber, callerNumber]
      ).catch(() => ({ rows: [] }));
      if (byonRes.rows.length > 0) {
        tenantId = byonRes.rows[0].tenantId;
      } else {
        const tenantRes = await db.query(
          'SELECT id FROM tenants WHERE status = $1 ORDER BY created_at ASC LIMIT 1',
          ['active']
        ).catch(() => ({ rows: [] }));
        if (tenantRes.rows.length > 0) tenantId = tenantRes.rows[0].id;
      }
    }
  } else {
    const d = core.loadDb();
    if (!tenantId) {
      const byon = (d.byonConnections || []).find((c) => c.address === calledNumber || c.address === callerNumber);
      if (byon) tenantId = byon.tenantId || byon.tenant_id;
      else if ((d.tenants || []).length > 0) tenantId = d.tenants[0].id;
    }
  }

  if (!tenantId) {
    return core.sendJson(res, 422, { error: 'cannot resolve tenant for call', code: 'unknown_tenant' });
  }

  const now = new Date().toISOString();
  let leadId = null;

  if (callerNumber) {
    if (db.isPostgres) {
      try {
        const leadRes = await db.query(
          `INSERT INTO leads (id, tenant_id, name, phone, source, status, notes, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'inbound_call', $5, $6, $7, $7)
           ON CONFLICT (tenant_id, phone) DO UPDATE SET
             status = CASE WHEN leads.status = 'booked' THEN 'booked' ELSE EXCLUDED.status END,
             notes = CASE WHEN EXCLUDED.notes <> '' THEN EXCLUDED.notes ELSE leads.notes END,
             updated_at = EXCLUDED.updated_at
           RETURNING id`,
          [
            core.genId('lead_'),
            tenantId,
            callerName,
            callerNumber,
            isMissed ? 'new' : 'contacted',
            `Call disposition: ${rawDisposition}, duration: ${duration}s`,
            now,
          ]
        );
        if (leadRes.rows.length > 0) leadId = leadRes.rows[0].id;
      } catch (err) {
        console.error('[webhook] lead upsert error:', err.message);
      }
    } else {
      await core.mutate((database) => {
        if (!Array.isArray(database.leads)) database.leads = [];
        let existing = database.leads.find((l) => (l.tenantId === tenantId || l.tenant_id === tenantId) && l.phone === callerNumber);
        if (!existing) {
          leadId = core.genId('lead_');
          database.leads.push({
            id: leadId,
            tenantId,
            name: callerName,
            phone: callerNumber,
            source: 'inbound_call',
            status: isMissed ? 'new' : 'contacted',
            notes: `Call disposition: ${rawDisposition}, duration: ${duration}s`,
            createdAt: now,
            updatedAt: now,
          });
        } else {
          leadId = existing.id;
          if (existing.status !== 'booked') existing.status = isMissed ? existing.status : 'contacted';
          existing.updatedAt = now;
        }
      }).catch(() => {});
    }
  }

  const costPaise = Math.round(duration * 1.5);
  if (db.isPostgres) {
    await db.query(
      `INSERT INTO calls (id, tenant_id, agent_id, recording_url, transcript, duration_seconds, cost_paise, status, caller_number, lead_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         duration_seconds = EXCLUDED.duration_seconds,
         recording_url = EXCLUDED.recording_url,
         transcript = EXCLUDED.transcript`,
      [callId, tenantId, body.agent_id || null, recordingUrl, transcript, duration, costPaise, status, callerNumber, leadId, now]
    ).catch((err) => console.error('[webhook] call insert error:', err.message));
  } else {
    await core.mutate((database) => {
      if (!Array.isArray(database.calls)) database.calls = [];
      const existing = database.calls.find((c) => c.id === callId);
      if (existing) {
        existing.status = status;
        existing.durationSeconds = duration;
        existing.recordingUrl = recordingUrl;
        existing.transcript = transcript;
      } else {
        database.calls.push({
          id: callId,
          tenantId,
          agentId: body.agent_id || null,
          recordingUrl,
          transcript,
          durationSeconds: duration,
          costPaise,
          status,
          callerNumber,
          leadId,
          createdAt: now,
        });
      }
    }).catch(() => {});
  }

  bumpUsage(tenantId, 'calls', 1).catch(() => {});

  if (isMissed && callerNumber) {
    let businessName = 'GetQualify';
    if (db.isPostgres) {
      const tRes = await db.query('SELECT name FROM tenants WHERE id = $1', [tenantId]).catch(() => ({ rows: [] }));
      if (tRes.rows.length > 0 && tRes.rows[0].name) businessName = tRes.rows[0].name;
    } else {
      const t = (core.loadDb().tenants || []).find((row) => row.id === tenantId);
      if (t && t.name) businessName = t.name;
    }

    sms.sendMissedCallTextBack(callerNumber, {
      businessName,
      callbackNumber: calledNumber || process.env.VOBIZ_NUMBER || '',
    }).catch((err) => {
      console.error('[webhook] missed-call text-back error:', err.message);
    });
  }

  return core.sendJson(res, 200, {
    ok: true,
    call_id: callId,
    status,
    lead_id: leadId,
  });
}

// ---- Google Calendar & Storage Integration Routes ----
async function apiCalendarAuthUrl(req, res, ctx) {
  try {
    const url = calendar.getAuthUrl(ctx.tenant.id);
    return core.sendJson(res, 200, { ok: true, authUrl: url });
  } catch (err) {
    return core.sendJson(res, err.status || 500, { error: err.message, code: err.code || 'calendar_error' });
  }
}

async function apiCalendarCallback(req, res) {
  const urlObj = new URL(req.url, 'http://localhost');
  const code = urlObj.searchParams.get('code');
  const stateRaw = urlObj.searchParams.get('state');
  const error = urlObj.searchParams.get('error');

  if (error) {
    res.writeHead(302, { Location: `/app.html#settings?calendar_error=${encodeURIComponent(error)}` });
    return res.end();
  }
  if (!code || !stateRaw) {
    return core.sendJson(res, 400, { error: 'Missing code or state parameter', code: 'bad_oauth_callback' });
  }

  let tenantId = null;
  try {
    const stateParsed = JSON.parse(Buffer.from(stateRaw, 'base64url').toString('utf8'));
    tenantId = stateParsed.tenantId;
  } catch (_) {
    return core.sendJson(res, 400, { error: 'Invalid state parameter', code: 'bad_state' });
  }

  try {
    await calendar.exchangeCode(tenantId, code);
    res.writeHead(302, { Location: `/app.html#settings?calendar=connected` });
    return res.end();
  } catch (err) {
    res.writeHead(302, { Location: `/app.html#settings?calendar_error=${encodeURIComponent(err.message)}` });
    return res.end();
  }
}

async function apiCalendarDisconnect(req, res, ctx) {
  try {
    await calendar.disconnect(ctx.tenant.id);
    return core.sendJson(res, 200, { ok: true, disconnected: true });
  } catch (err) {
    return core.sendJson(res, err.status || 500, { error: err.message, code: err.code || 'calendar_error' });
  }
}

async function apiCalendarStatus(req, res, ctx) {
  try {
    const connected = await calendar.isConnected(ctx.tenant.id);
    return core.sendJson(res, 200, { ok: true, connected, provider: connected ? 'google' : null });
  } catch (err) {
    return core.sendJson(res, err.status || 500, { error: err.message, code: err.code || 'calendar_error' });
  }
}

async function apiCalendarAvailability(req, res, ctx) {
  const urlObj = new URL(req.url, 'http://localhost');
  const timeMin = urlObj.searchParams.get('timeMin') || new Date().toISOString();
  const timeMax = urlObj.searchParams.get('timeMax') || new Date(Date.now() + 7 * 86400000).toISOString();

  try {
    const availability = await calendar.getAvailability(ctx.tenant.id, { timeMin, timeMax });
    return core.sendJson(res, 200, availability);
  } catch (err) {
    return core.sendJson(res, err.status || 500, { error: err.message, code: err.code || 'calendar_error' });
  }
}

async function apiCalendarBook(req, res, ctx, body = {}) {
  const { summary, description, start, end, attendeeEmail, attendeeName, attendeePhone, leadId } = body;
  if (!start || !end) {
    return core.sendJson(res, 422, { error: 'start and end datetime are required', code: 'missing_time' });
  }

  try {
    const booking = await calendar.bookAppointment(ctx.tenant.id, {
      summary,
      description,
      start,
      end,
      attendeeEmail,
      attendeeName,
      attendeePhone,
      leadId,
    });
    return core.sendJson(res, 200, booking);
  } catch (err) {
    return core.sendJson(res, err.status || 500, { error: err.message, code: err.code || 'calendar_error' });
  }
}

async function apiCallRecordingGet(req, res, ctx, callId) {
  try {
    const recording = await storage.getPresignedUrl(ctx.tenant.id, callId);
    return core.sendJson(res, 200, { ok: true, ...recording });
  } catch (err) {
    return core.sendJson(res, err.status || 500, { error: err.message, code: err.code || 'storage_error' });
  }
}

// GET /api/usage -> tenant scoped daily rows + totals, with a rough INR cost.
async function apiUsage(req, res, ctx) {
  const INR_PER_1K_CHARS = 0.12;
  const INR_PER_CALL = 0.9;

  let days;
  if (db.isPostgres) {
    const { rows } = await db.query(
      'SELECT day, chars, calls, llm_tokens FROM usage WHERE tenant_id = $1 ORDER BY day ASC',
      [ctx.tenant.id]
    );
    days = rows.map((r) => ({
      day: toIso(r.day).slice(0, 10),
      chars: r.chars || 0,
      calls: r.calls || 0,
      llmTokens: r.llm_tokens || 0,
      costInr: Math.round(((r.chars || 0) / 1000 * INR_PER_1K_CHARS + (r.calls || 0) * INR_PER_CALL) * 100) / 100,
    }));
  } else {
    const rows = core.db().usage
      .filter((u) => u.tenantId === ctx.tenant.id)
      .sort((a, b) => (a.day < b.day ? -1 : 1));
    days = rows.map((r) => ({
      day: r.day,
      chars: r.chars || 0,
      calls: r.calls || 0,
      llmTokens: r.llmTokens || 0,
      costInr: Math.round(((r.chars || 0) / 1000 * INR_PER_1K_CHARS + (r.calls || 0) * INR_PER_CALL) * 100) / 100,
    }));
  }

  const totals = days.reduce((acc, d) => ({
    chars: acc.chars + d.chars,
    calls: acc.calls + d.calls,
    llmTokens: acc.llmTokens + d.llmTokens,
    costInr: Math.round((acc.costInr + d.costInr) * 100) / 100,
  }), { chars: 0, calls: 0, llmTokens: 0, costInr: 0 });
  core.sendJson(res, 200, { days, totals });
}

async function apiPresets(req, res, ctx) {
  if (db.isPostgres) {
    const { rows } = await db.query(
      'SELECT * FROM presets WHERE is_system = true OR tenant_id = $1 ORDER BY created_at ASC',
      [ctx.tenant.id]
    );
    const presets = rows.map((p) => ({
      id: p.id,
      tenantId: p.tenant_id,
      slug: p.slug,
      name: p.name,
      category: p.category,
      version: p.version,
      isSystem: p.is_system,
      greeting: p.greeting,
      persona: p.persona,
      fields: p.fields || [],
      guardrails: p.guardrails || [],
      createdAt: toIso(p.created_at),
    }));
    return core.sendJson(res, 200, { presets });
  }
  const presets = core.db().presets.filter((p) => p.isSystem || p.tenantId === ctx.tenant.id);
  core.sendJson(res, 200, { presets });
}

function apiWallet(req, res, ctx) {
  const d = core.db();
  const wallet = d.wallets.find((w) => w.tenantId === ctx.tenant.id);
  const ledger = d.ledger.filter((x) => x.tenantId === ctx.tenant.id).slice(-100).reverse();
  core.sendJson(res, 200, { wallet: publicWallet(wallet || { id: null, tenantId: ctx.tenant.id, currency: 'INR', balancePaise: 0 }), ledger });
}

function apiPaymentIntents(req, res, ctx) {
  const intents = core.db().paymentIntents.filter((x) => x.tenantId === ctx.tenant.id).map((x) => ({ ...x, gatewayPayload: undefined, intentToken: undefined, customer: undefined }));
  core.sendJson(res, 200, { paymentIntents: intents });
}

async function apiPaymentIntentCreate(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  const packId = String(b.packId || '');
  let base;
  try { base = payu.createPaymentIntent({ packId, packs: CREDIT_PACKS, tenantId: ctx.tenant.id, userId: ctx.user.id }); }
  catch (e) { return core.sendJson(res, 422, { error: e.message, code: 'bad_pack' }); }
  const customer = { firstname: String(b.firstname || ctx.user.name || 'Customer').trim().slice(0, 60), email: ctx.user.email, phone: String(b.phone || '').trim().slice(0, 20) };
  const intent = { id: core.genId('pay_'), provider: 'payu', ...base, customer, amountPaise: Math.round(Number(base.amount) * 100), updatedAt: base.createdAt };
  let checkout = null; const cfg = payuConfig();
  if (cfg && process.env.GETQUALIFY_PUBLIC_URL) {
    try {
      const origin = String(process.env.GETQUALIFY_PUBLIC_URL).replace(/\/$/, '');
      checkout = payu.buildCheckout({ intent, customer, successUrl: `${origin}/api/payu/callback`, failureUrl: `${origin}/api/payu/return`, config: cfg });
    } catch (e) { return core.sendJson(res, 503, { error: 'PayU checkout configuration is invalid', code: 'payu_config' }); }
  }

  if (db.isPostgres) {
    await db.transaction(async (client) => {
      await client.query(
        `INSERT INTO payment_intents (id, tenant_id, user_id, provider, txnid, pack_id, product_info, amount, amount_paise, credits, customer, gateway_payload, intent_token, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [intent.id, ctx.tenant.id, ctx.user.id, intent.provider, intent.txnid, packId, intent.productinfo, base.amount, intent.amountPaise, intent.credits, JSON.stringify(customer), JSON.stringify(intent.gatewayPayload || {}), intent.intentToken || null, intent.status || 'pending', base.createdAt, intent.updatedAt]
      );
      await db.addAuditSql(client, ctx, 'billing.payment_intent.created', 'payment_intent', intent.id, { packId, amountPaise: intent.amountPaise });
    });
  } else {
    await core.mutate((d) => { d.paymentIntents.push(intent); addAudit(d, ctx, 'billing.payment_intent.created', 'payment_intent', intent.id, { packId, amountPaise: intent.amountPaise }); });
  }

  core.sendJson(res, 201, { paymentIntent: { ...intent, intentToken: undefined, customer: undefined }, checkoutReady: !!checkout, checkout, message: checkout ? undefined : 'PayU is not configured. The intent is saved but cannot be paid yet.' });
}

async function apiPayuCallback(req, res, payload) {
  const cfg = payuConfig();
  if (!cfg) return core.sendJson(res, 503, { error: 'PayU is not configured', code: 'payu_unavailable' });
  const intent = core.db().paymentIntents.find((x) => x.txnid === String(payload.txnid || ''));
  const eventId = core.genId('pevt_');
  const safePayload = Object.fromEntries(Object.entries(payload || {}).filter(([k]) => !/hash|salt|key|card|token/i.test(k)).map(([k, v]) => [k, String(v).slice(0, 500)]));
  if (!intent) {
    await core.mutate((d) => d.paymentEvents.push({ id: eventId, provider: 'payu', txnid: String(payload.txnid || ''), status: 'rejected', reason: 'intent_not_found', payload: safePayload, createdAt: new Date().toISOString() }));
    return core.sendJson(res, 404, { error: 'payment intent not found', code: 'not_found' });
  }
  const callback = payu.verifyCallback({ payload, intent, customer: intent.customer, config: cfg });
  await core.mutate((d) => d.paymentEvents.push({ id: eventId, provider: 'payu', tenantId: intent.tenantId, paymentIntentId: intent.id, txnid: intent.txnid, status: callback.valid ? 'verified_hash' : 'rejected', reason: callback.reason, payload: safePayload, createdAt: new Date().toISOString() }));
  if (!callback.valid || !callback.creditable) return core.sendJson(res, 400, { error: callback.reason, code: 'payu_callback_rejected' });
  let verification;
  try { verification = await payu.verifyPayment({ intent, config: cfg }); }
  catch (_) { return core.sendJson(res, 502, { error: 'PayU verification unavailable', code: 'payu_verify_failed' }); }
  if (!verification.verified) return core.sendJson(res, 409, { error: verification.reason, code: 'payu_not_verified' });

  let entry; let duplicate = false;

  if (db.isPostgres) {
    try {
      await db.transaction(async (client) => {
        const now = new Date().toISOString();

        // Lock payment_intent row to prevent concurrent webhook processing.
        const intentRes = await client.query(
          'SELECT id, tenant_id, status, credits, user_id, txnid, pack_id FROM payment_intents WHERE id = $1 FOR UPDATE',
          [intent.id]
        );
        if (intentRes.rowCount === 0) {
          throw Object.assign(new Error('payment intent not found in transaction'), { statusCode: 404, code: 'not_found' });
        }
        const stored = intentRes.rows[0];

        // Duplicate detection: if already credited, skip the credit operation.
        if (stored.status === 'credited') {
          duplicate = true;
          return;
        }

        // addLedgerEntrySql locks the wallet FOR UPDATE and inserts ledger atomically.
        entry = await db.addLedgerEntrySql(
          client,
          stored.tenant_id,
          stored.credits,
          'payment_credit',
          `payu:${stored.txnid}`,
          stored.user_id,
          { paymentIntentId: stored.id, payuId: verification.payuId, packId: stored.pack_id }
        );

        if (!entry) {
          // Idempotency key already exists (ledger dedup), treat as duplicate.
          duplicate = true;
          await client.query(
            'UPDATE payment_intents SET status = $1, updated_at = $2 WHERE id = $3',
            ['credited', now, stored.id]
          );
          return;
        }

        // Update payment_intents with credited status and payuId.
        await client.query(
          'UPDATE payment_intents SET status = $1, payu_id = $2, updated_at = $3 WHERE id = $4',
          ['credited', verification.payuId, now, stored.id]
        );

        // Insert audit event.
        await client.query(
          `INSERT INTO audit_events (id, tenant_id, actor_user_id, subject_user_id, action, target_type, target_id, metadata, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [core.genId('aud_'), stored.tenant_id, stored.user_id, null, 'billing.payment.credited', 'payment_intent', stored.id, JSON.stringify({ ledgerId: entry.id }), now]
        );
      });
    } catch (err) {
      if (err.statusCode) return core.sendJson(res, err.statusCode, { error: err.message, code: err.code });
      console.error('apiPayuCallback transaction error:', err);
      return core.sendJson(res, 500, { error: 'payment credit failed', code: 'transaction_failed' });
    }
  } else {
    // JSON fallback path (no Postgres).
    await core.mutate((d) => {
      const stored = d.paymentIntents.find((x) => x.id === intent.id);
      if (stored.status === 'credited') { duplicate = true; return; }
      entry = addLedgerEntry(d, stored.tenantId, stored.credits, 'payment_credit', `payu:${stored.txnid}`, stored.userId, { paymentIntentId: stored.id, payuId: verification.payuId, packId: stored.packId });
      if (!entry) { duplicate = true; stored.status = 'credited'; return; }
      stored.status = 'credited'; stored.payuId = verification.payuId; stored.updatedAt = new Date().toISOString();
      d.auditEvents.push({ id: core.genId('aud_'), tenantId: stored.tenantId, actorUserId: stored.userId, action: 'billing.payment.credited', targetType: 'payment_intent', targetId: stored.id, metadata: { ledgerId: entry.id }, createdAt: stored.updatedAt });
    });
  }

  core.sendJson(res, 200, { ok: true, credited: !duplicate, duplicate });
}

function apiPayuReturn(req, res, payload) {
  const result = payu.classifyBrowserReturn(payload);
  core.sendJson(res, 202, { ...result, message: 'Payment is pending server verification. A browser return never credits the wallet.' });
}

async function apiSupportList(req, res, ctx) {
  if (db.isPostgres) {
    const ticketsRes = await db.query('SELECT * FROM support_tickets WHERE tenant_id = $1 ORDER BY created_at DESC', [ctx.tenant.id]);
    const tickets = ticketsRes.rows;
    if (tickets.length > 0) {
      const ticketIds = tickets.map((t) => t.id);
      const msgsRes = await db.query(
        'SELECT * FROM support_messages WHERE ticket_id = ANY($1::text[]) ORDER BY created_at ASC',
        [ticketIds]
      );
      const messagesByTicket = {};
      for (const m of msgsRes.rows) {
        if (!messagesByTicket[m.ticketId]) messagesByTicket[m.ticketId] = [];
        messagesByTicket[m.ticketId].push({
          id: m.id,
          ticketId: m.ticketId,
          tenantId: ctx.tenant.id,
          authorUserId: m.userId,
          body: m.body,
          internal: false,
          createdAt: m.createdAt,
        });
      }
      for (const t of tickets) {
        t.messages = messagesByTicket[t.id] || [];
      }
    }
    return core.sendJson(res, 200, { tickets });
  }

  const d = core.db();
  const tickets = d.supportTickets.filter((x) => x.tenantId === ctx.tenant.id).map((t) => ({ ...t, messages: d.supportMessages.filter((m) => m.ticketId === t.id && m.tenantId === ctx.tenant.id && !m.internal) }));
  core.sendJson(res, 200, { tickets });
}

async function apiSupportCreate(req, res, ctx) {
  const b = ctx.body || {};
  const subject = String(b.subject || '').trim().slice(0, 120);
  const message = String(b.message || '').trim().slice(0, 5000);
  if (!subject || !message) return core.sendJson(res, 422, { error: 'subject and message required', code: 'bad_ticket' });
  const priority = ['low', 'normal', 'high', 'urgent'].includes(b.priority) ? b.priority : 'normal';
  const now = new Date().toISOString();
  const ticketId = core.genId('tic_');
  const msgId = core.genId('msg_');

  if (db.isPostgres) {
    await db.transaction(async (client) => {
      await client.query(
        `INSERT INTO support_tickets (id, tenant_id, subject, status, priority, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [ticketId, ctx.tenant.id, subject, 'open', priority, ctx.user.id, now, now]
      );
      await client.query(
        `INSERT INTO support_messages (id, ticket_id, user_id, body, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [msgId, ticketId, ctx.user.id, message, now]
      );
      await db.addAuditSql(client, ctx, 'support.ticket.created', 'ticket', ticketId);
    });
    const ticket = {
      id: ticketId,
      tenantId: ctx.tenant.id,
      createdBy: ctx.user.id,
      subject,
      priority,
      status: 'open',
      createdAt: now,
      updatedAt: now,
      messages: [{ id: msgId, ticketId, tenantId: ctx.tenant.id, authorUserId: ctx.user.id, body: message, internal: false, createdAt: now }],
    };
    return core.sendJson(res, 201, { ticket });
  }

  const ticket = { id: ticketId, tenantId: ctx.tenant.id, createdBy: ctx.user.id, subject, priority, status: 'open', createdAt: now, updatedAt: now };
  const first = { id: msgId, ticketId: ticket.id, tenantId: ctx.tenant.id, authorUserId: ctx.user.id, body: message, internal: false, createdAt: now };
  await core.mutate((d) => { d.supportTickets.push(ticket); d.supportMessages.push(first); addAudit(d, ctx, 'support.ticket.created', 'ticket', ticket.id); });
  core.sendJson(res, 201, { ticket: { ...ticket, messages: [first] } });
}

async function apiSupportReply(req, res, ctx) {
  const b = ctx.body || {};
  const ticketId = String(b.ticketId || '');

  if (db.isPostgres) {
    // Tenant-scoped lookup. 404 preserves the JSON handler's cross-tenant safety.
    const tRes = await db.query('SELECT id, tenant_id, status FROM support_tickets WHERE id = $1 AND tenant_id = $2', [ticketId, ctx.tenant.id]);
    if (tRes.rowCount === 0) return core.sendJson(res, 404, { error: 'ticket not found', code: 'not_found' });
    const text = String(b.message || '').trim().slice(0, 5000);
    if (!text) return core.sendJson(res, 422, { error: 'message required', code: 'bad_message' });
    const msg = { id: core.genId('msg_'), ticketId, tenantId: ctx.tenant.id, authorUserId: ctx.user.id, body: text, internal: false, createdAt: new Date().toISOString() };
    await db.transaction(async (client) => {
      await client.query('UPDATE support_tickets SET updated_at = $1 WHERE id = $2', [msg.createdAt, ticketId]);
      await client.query(
        'INSERT INTO support_messages (id, ticket_id, user_id, body, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [msg.id, ticketId, ctx.user.id, text, msg.createdAt]
      );
      await db.addAuditSql(client, ctx, 'support.ticket.replied', 'ticket', ticketId);
    });
    return core.sendJson(res, 201, { message: msg });
  }

  const ticket = core.db().supportTickets.find((t) => t.id === ticketId && t.tenantId === ctx.tenant.id);
  if (!ticket) return core.sendJson(res, 404, { error: 'ticket not found', code: 'not_found' });
  const text = String(b.message || '').trim().slice(0, 5000);
  if (!text) return core.sendJson(res, 422, { error: 'message required', code: 'bad_message' });
  const msg = { id: core.genId('msg_'), ticketId: ticket.id, tenantId: ctx.tenant.id, authorUserId: ctx.user.id, body: text, internal: false, createdAt: new Date().toISOString() };
  await core.mutate((d) => { d.supportMessages.push(msg); const t = d.supportTickets.find((x) => x.id === ticket.id); t.updatedAt = msg.createdAt; addAudit(d, ctx, 'support.ticket.replied', 'ticket', ticket.id); });
  core.sendJson(res, 201, { message: msg });
}

async function apiByonList(req, res, ctx) {
  if (db.isPostgres) {
    const { rows } = await db.query(
      'SELECT id, tenant_id, provider, address, label, status, created_by, created_at FROM byon_connections WHERE tenant_id = $1 ORDER BY created_at DESC',
      [ctx.tenant.id]
    );
    const connections = rows.map((x) => ({
      id: x.id,
      tenantId: x.tenant_id,
      provider: x.provider,
      address: x.address,
      label: x.label,
      status: x.status,
      createdBy: x.created_by,
      createdAt: toIso(x.created_at),
    }));
    return core.sendJson(res, 200, { connections });
  }
  const connections = core.db().byonConnections.filter((x) => x.tenantId === ctx.tenant.id).map((x) => ({ ...x, credentials: undefined }));
  core.sendJson(res, 200, { connections });
}

function apiPrivacyGet(req, res, ctx) { core.sendJson(res, 200, { mode: ctx.tenant.privacyMode || 'standard' }); }

async function apiByonSave(req, res, ctx) {
  const b = ctx.body || {};
  const provider = String(b.provider || '').toLowerCase();
  if (!['vobiz', 'twilio', 'telnyx', 'plivo', 'vonage', 'sip'].includes(provider)) return core.sendJson(res, 422, { error: 'unsupported BYON provider', code: 'bad_provider' });
  const address = String(b.address || '').replace(/[^0-9+]/g, '').slice(0, 32);
  if (!address) return core.sendJson(res, 422, { error: 'phone address required', code: 'bad_address' });
  const label = String(b.label || '').slice(0, 64);
  const now = new Date().toISOString();
  const connectionId = core.genId('byon_');

  if (db.isPostgres) {
    await db.transaction(async (client) => {
      await client.query(
        `INSERT INTO byon_connections (id, tenant_id, provider, address, label, status, credentials, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [connectionId, ctx.tenant.id, provider, address, label, 'pending_verification', JSON.stringify({}), ctx.user.id, now]
      );
      await db.addAuditSql(client, ctx, 'telephony.byon.created', 'byon_connection', connectionId, { provider, address });
    });
    return core.sendJson(res, 201, {
      connection: {
        id: connectionId,
        tenantId: ctx.tenant.id,
        provider,
        address,
        label,
        status: 'pending_verification',
        createdBy: ctx.user.id,
        createdAt: now,
      }
    });
  }

  const connection = { id: connectionId, tenantId: ctx.tenant.id, provider, address, label, status: 'pending_verification', createdBy: ctx.user.id, createdAt: now };
  await core.mutate((d) => { d.byonConnections.push(connection); addAudit(d, ctx, 'telephony.byon.created', 'byon_connection', connection.id, { provider, address }); });
  core.sendJson(res, 201, { connection });
}

async function apiPrivacyMode(req, res, ctx) {
  const mode = String((ctx.body || {}).mode || '');
  if (!['standard', 'metadata_only', 'no_recording'].includes(mode)) return core.sendJson(res, 422, { error: 'invalid privacy mode', code: 'bad_privacy_mode' });
  if (db.isPostgres) {
    await db.transaction(async (client) => {
      await client.query('UPDATE tenants SET privacy_mode = $1 WHERE id = $2', [mode, ctx.tenant.id]);
      await db.addAuditSql(client, ctx, 'tenant.privacy_mode.updated', 'tenant', ctx.tenant.id, { mode });
    });
  } else {
    await core.mutate((d) => { const t = d.tenants.find((x) => x.id === ctx.tenant.id); t.privacyMode = mode; addAudit(d, ctx, 'tenant.privacy_mode.updated', 'tenant', t.id, { mode }); });
  }
  core.sendJson(res, 200, { mode });
}

async function apiMembers(req, res, ctx) {
  if (db.isPostgres) {
    const rows = await db.query('SELECT * FROM users WHERE tenant_id = $1 ORDER BY created_at ASC', [ctx.tenant.id]);
    return core.sendJson(res, 200, { users: rows.rows.map(publicUser) });
  }
  core.sendJson(res, 200, { users: core.db().users.filter((u) => u.tenantId === ctx.tenant.id).map(publicUser) });
}

async function apiAudit(req, res, ctx) {
  if (db.isPostgres) {
    const rows = await db.query('SELECT * FROM audit_events WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 200', [ctx.tenant.id]);
    return core.sendJson(res, 200, { auditEvents: rows.rows });
  }
  core.sendJson(res, 200, { auditEvents: core.db().auditEvents.filter((e) => e.tenantId === ctx.tenant.id).slice(-200).reverse() });
}

const INVOICE_STATUSES = new Set(['draft', 'issued', 'paid', 'void']);
const APPROACH_CHANNELS = new Set(['whatsapp', 'email', 'phone', 'linkedin', 'meeting', 'other']);
const INTEGRATION_CATALOG = [
  {
    id: 'whatsapp-business',
    name: 'WhatsApp Business Cloud',
    category: 'Messaging',
    description: 'Manage consent-safe conversations, templates, delivery state, and client replies from one workspace.',
    capabilities: ['Shared inbox', 'Approved templates', 'Delivery events', 'Conversation activity'],
    setup: ['Meta business verification', 'WhatsApp phone number', 'Access token', 'Signed webhook'],
  },
  {
    id: 'meta-ad-library',
    name: 'Meta Ad Library',
    category: 'Research',
    description: 'Track public competitor ads and save research context without presenting sample records as live campaign data.',
    capabilities: ['Public ad search', 'Competitor watchlists', 'Creative snapshots', 'Research notes'],
    setup: ['Meta developer app', 'Permitted API access', 'Rate-limit policy', 'Health check'],
  },
];

function isPlatformUser(user) {
  return user && (user.role === 'super_admin' || user.role === 'admin');
}

function requestOriginAllowed(req) {
  const rawOrigin = String(req.headers.origin || '').trim();
  if (!rawOrigin) return true;
  let origin;
  try { origin = new URL(rawOrigin); } catch (_) { return false; }
  if (!['http:', 'https:'].includes(origin.protocol)) return false;
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const requestHost = forwardedHost || String(req.headers.host || '').trim();
  const configuredOrigin = String(process.env.PUBLIC_ORIGIN || '').trim().replace(/\/$/, '');
  if (configuredOrigin) return rawOrigin === configuredOrigin;
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const requestProto = forwardedProto || (req.socket.encrypted ? 'https' : 'http');
  return !!requestHost && origin.origin === `${requestProto}://${requestHost}`;
}

function requestRateKey(req) {
  const peer = String(req.socket.remoteAddress || 'local').replace(/^::ffff:/, '');
  if (process.env.TRUST_PROXY !== '1') return peer;
  const privatePeer = peer === '127.0.0.1' || peer === '::1' || peer.startsWith('10.') || peer.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(peer);
  if (!privatePeer) return peer;
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return net.isIP(forwarded) ? forwarded : peer;
}

function invoiceState(invoice, now = Date.now()) {
  if (invoice.status === 'issued' && invoice.dueDate && new Date(`${invoice.dueDate}T23:59:59Z`).getTime() < now) return 'overdue';
  return invoice.status;
}

function validDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function toIso(d) {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString();
  return String(d);
}

function publicInvoice(invoice) {
  return {
    id: invoice.id,
    tenantId: invoice.tenantId,
    invoiceNumber: invoice.invoiceNumber,
    clientName: invoice.clientName,
    clientEmail: invoice.clientEmail || '',
    description: invoice.description,
    amountPaise: invoice.amountPaise,
    currency: invoice.currency || 'INR',
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    status: invoiceState(invoice),
    storedStatus: invoice.status,
    deliveryStatus: invoice.deliveryStatus || 'not_sent',
    createdAt: invoice.createdAt,
    updatedAt: invoice.updatedAt,
    issuedAt: invoice.issuedAt || null,
    paidAt: invoice.paidAt || null,
  };
}

function scopedInvoices(ctx) {
  const rows = core.db().invoices || [];
  return (isPlatformUser(ctx.user) ? rows : rows.filter((row) => row.tenantId === ctx.tenant.id));
}

function apiInvoices(req, res, ctx) {
  core.sendJson(res, 200, { invoices: scopedInvoices(ctx).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicInvoice) });
}

async function apiInvoiceCreate(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  const requestedTenantId = String(b.tenantId || '');
  let tenant;
  if (db.isPostgres) {
    const targetId = isPlatformUser(ctx.user) ? requestedTenantId : ctx.tenant.id;
    const tRes = await db.query('SELECT * FROM tenants WHERE id = $1', [targetId]);
    tenant = tRes.rows[0];
  } else {
    const d = core.db();
    tenant = isPlatformUser(ctx.user)
      ? d.tenants.find((row) => row.id === requestedTenantId)
      : d.tenants.find((row) => row.id === ctx.tenant.id);
  }
  if (!tenant) return core.sendJson(res, 422, { error: 'valid client workspace required', code: 'bad_tenant' });
  const amountPaise = Number(b.amountPaise);
  const description = String(b.description || '').trim().slice(0, 500);
  const clientName = String(b.clientName || tenant.name || '').trim().slice(0, 120);
  const clientEmail = String(b.clientEmail || '').trim().toLowerCase().slice(0, 160);
  const dueDate = String(b.dueDate || '').trim();
  const issueDate = String(b.issueDate || todayUtc()).trim();
  const initialStatus = b.issueNow === true ? 'issued' : 'draft';
  if (!Number.isInteger(amountPaise) || amountPaise < 100 || amountPaise > 1000000000) return core.sendJson(res, 422, { error: 'amount must be between ₹1 and ₹10,000,000', code: 'bad_amount' });
  if (!description || !clientName) return core.sendJson(res, 422, { error: 'client name and description required', code: 'bad_invoice' });
  if (clientEmail && !EMAIL_RE.test(clientEmail)) return core.sendJson(res, 422, { error: 'client email is invalid', code: 'bad_email' });
  if (!validDateOnly(issueDate) || !validDateOnly(dueDate)) return core.sendJson(res, 422, { error: 'valid issue and due dates are required', code: 'bad_date' });
  if (dueDate < issueDate) return core.sendJson(res, 422, { error: 'due date cannot be before issue date', code: 'bad_date' });
  let invoice;
  await core.mutate((store) => {
    const year = issueDate.slice(0, 4);
    const sequence = store.invoices.filter((row) => String(row.invoiceNumber || '').startsWith(`RX-${year}-`)).length + 1;
    const now = new Date().toISOString();
    invoice = {
      id: core.genId('inv_'), tenantId: tenant.id, invoiceNumber: `RX-${year}-${String(sequence).padStart(4, '0')}`,
      clientName, clientEmail, description, amountPaise, currency: 'INR', issueDate, dueDate,
      status: initialStatus, deliveryStatus: 'not_sent', createdBy: ctx.user.id, createdAt: now, updatedAt: now,
      issuedAt: initialStatus === 'issued' ? now : null,
    };
    store.invoices.push(invoice);
    store.invoiceEvents.push({ id: core.genId('ine_'), tenantId: tenant.id, invoiceId: invoice.id, type: initialStatus === 'issued' ? 'issued' : 'created', actorUserId: ctx.user.id, createdAt: now });
    store.clientActivities.push({ id: core.genId('act_'), tenantId: tenant.id, type: initialStatus === 'issued' ? 'invoice_issued' : 'invoice_created', channel: 'internal', visibility: 'internal', summary: `${invoice.invoiceNumber} ${initialStatus === 'issued' ? 'issued' : 'created'} for ₹${(amountPaise / 100).toLocaleString('en-IN')}.`, actorUserId: ctx.user.id, createdAt: now });
    addAudit(store, ctx, initialStatus === 'issued' ? 'invoice.issued' : 'invoice.created', 'invoice', invoice.id, { invoiceNumber: invoice.invoiceNumber, tenantId: tenant.id, amountPaise });
  });
  core.sendJson(res, 201, { invoice: publicInvoice(invoice), note: 'The invoice is stored in Agency OS. No email was sent.' });
}

async function apiInvoiceStatus(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  const requested = String(b.status || '');
  if (!INVOICE_STATUSES.has(requested)) return core.sendJson(res, 422, { error: 'invalid invoice status', code: 'bad_status' });
  const current = scopedInvoices(ctx).find((row) => row.id === String(b.invoiceId || ''));
  if (!current) return core.sendJson(res, 404, { error: 'invoice not found', code: 'not_found' });
  const transitions = { draft: new Set(['issued', 'void']), issued: new Set(['paid', 'void']), paid: new Set(), void: new Set() };
  if (!transitions[current.status] || !transitions[current.status].has(requested)) {
    const final = current.status === 'void' || current.status === 'paid';
    return core.sendJson(res, 409, {
      error: final ? 'paid and void invoices are final' : `invoice cannot move from ${current.status} to ${requested}`,
      code: final ? 'invoice_final' : 'invalid_transition',
    });
  }
  let updated;
  await core.mutate((store) => {
    const invoice = store.invoices.find((row) => row.id === current.id);
    if (!invoice || !transitions[invoice.status] || !transitions[invoice.status].has(requested)) return;
    const now = new Date().toISOString();
    invoice.status = requested; invoice.updatedAt = now;
    if (requested === 'issued' && !invoice.issuedAt) invoice.issuedAt = now;
    if (requested === 'paid') invoice.paidAt = now;
    if (requested === 'void') invoice.voidedAt = now;
    store.invoiceEvents.push({ id: core.genId('ine_'), tenantId: invoice.tenantId, invoiceId: invoice.id, type: requested, actorUserId: ctx.user.id, createdAt: now });
    store.clientActivities.push({ id: core.genId('act_'), tenantId: invoice.tenantId, type: `invoice_${requested}`, channel: 'internal', visibility: 'internal', summary: `${invoice.invoiceNumber} marked ${requested}.`, actorUserId: ctx.user.id, createdAt: now });
    addAudit(store, ctx, `invoice.${requested}`, 'invoice', invoice.id, { invoiceNumber: invoice.invoiceNumber, tenantId: invoice.tenantId });
    updated = { ...invoice };
  });
  if (!updated) return core.sendJson(res, 409, { error: 'invoice state changed before this update', code: 'invoice_conflict' });
  core.sendJson(res, 200, { invoice: publicInvoice(updated) });
}

async function apiAgencyOverview(req, res, ctx) {
  const platform = isPlatformUser(ctx.user);
  let tenants, invoices, usage, activities, audit;

  if (db.isPostgres) {
    const tenantsRes = await db.query(platform ? 'SELECT * FROM tenants' : 'SELECT * FROM tenants WHERE id = $1', platform ? [] : [ctx.tenant.id]);
    tenants = tenantsRes.rows;
    const tenantIds = new Set(tenants.map((t) => t.id));

    const d = core.db();
    invoices = (d.invoices || []).filter((row) => tenantIds.has(row.tenantId));
    usage = (d.usage || []).filter((row) => tenantIds.has(row.tenantId));
    const [actRes, audRes] = await Promise.all([
      db.query(platform ? 'SELECT * FROM client_activities' : 'SELECT * FROM client_activities WHERE tenant_id = $1', platform ? [] : [ctx.tenant.id]),
      db.query(platform ? 'SELECT * FROM audit_events' : 'SELECT * FROM audit_events WHERE tenant_id = $1', platform ? [] : [ctx.tenant.id]),
    ]);
    activities = actRes.rows.filter((row) => platform || row.visibility === 'tenant');
    audit = audRes.rows;
  } else {
    const d = core.db();
    const tenantIds = platform ? new Set(d.tenants.map((t) => t.id)) : new Set([ctx.tenant.id]);
    tenants = d.tenants.filter((t) => tenantIds.has(t.id));
    invoices = d.invoices.filter((row) => tenantIds.has(row.tenantId));
    usage = d.usage.filter((row) => tenantIds.has(row.tenantId));
    activities = d.clientActivities.filter((row) => tenantIds.has(row.tenantId) && (platform || row.visibility === 'tenant'));
    audit = d.auditEvents.filter((row) => tenantIds.has(row.tenantId));
  }

  const days = [];
  for (let i = 29; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const dayInvoices = invoices.filter((row) => (toIso(row.issueDate) || '').slice(0, 10) === date && row.status !== 'draft' && row.status !== 'void');
    const dayPaid = invoices.filter((row) => toIso(row.paidAt) && toIso(row.paidAt).slice(0, 10) === date);
    const dayUsage = usage.filter((row) => (toIso(row.day) || '').slice(0, 10) === date);
    const dayActivities = activities.filter((row) => (toIso(row.createdAt) || '').slice(0, 10) === date);
    days.push({
      date,
      invoicedPaise: dayInvoices.reduce((sum, row) => sum + Number(row.amountPaise || 0), 0),
      paidPaise: dayPaid.reduce((sum, row) => sum + Number(row.amountPaise || 0), 0),
      calls: dayUsage.reduce((sum, row) => sum + Number(row.calls || 0), 0),
      activity: dayActivities.length + audit.filter((row) => toIso(row.createdAt) && toIso(row.createdAt).slice(0, 10) === date).length,
    });
  }
  const issued = invoices.filter((row) => row.status === 'issued' || row.status === 'paid');
  const paid = invoices.filter((row) => row.status === 'paid');
  const outstanding = invoices.filter((row) => row.status === 'issued');
  const comparisons = tenants.map((tenant) => ({
    tenantId: tenant.id,
    name: tenant.name,
    status: tenant.status || 'active',
    calls: usage.filter((row) => row.tenantId === tenant.id).reduce((sum, row) => sum + Number(row.calls || 0), 0),
    activity: activities.filter((row) => row.tenantId === tenant.id).length + audit.filter((row) => row.tenantId === tenant.id).length,
    outstandingPaise: outstanding.filter((row) => row.tenantId === tenant.id).reduce((sum, row) => sum + Number(row.amountPaise || 0), 0),
  })).sort((a, b) => (b.calls + b.activity) - (a.calls + a.activity)).slice(0, 8);
  const portfolio = ['active', 'onboarding', 'suspended', 'closed'].map((status) => ({ status, count: tenants.filter((t) => (t.status || 'active') === status).length }));
  const recent = activities.slice().sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 12).map((row) => ({ id: row.id, tenantId: row.tenantId, tenantName: (tenants.find((t) => t.id === row.tenantId) || {}).name || 'Workspace', type: row.type, channel: row.channel, summary: row.summary, createdAt: toIso(row.createdAt) }));
  core.sendJson(res, 200, {
    dataMode: 'live_staging', currency: 'INR', asOf: new Date().toISOString(),
    kpis: {
      clients: tenants.length,
      activeClients: tenants.filter((t) => (t.status || 'active') === 'active').length,
      closedClients: tenants.filter((t) => t.status === 'closed').length,
      invoicedPaise: issued.reduce((sum, row) => sum + Number(row.amountPaise || 0), 0),
      paidPaise: paid.reduce((sum, row) => sum + Number(row.amountPaise || 0), 0),
      outstandingPaise: outstanding.reduce((sum, row) => sum + Number(row.amountPaise || 0), 0),
      calls: usage.reduce((sum, row) => sum + Number(row.calls || 0), 0),
      activity: activities.length + audit.length,
    },
    days, comparisons, portfolio, recent,
  });
}

async function apiClientApproach(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  if (!isPlatformUser(ctx.user)) return core.sendJson(res, 403, { error: 'platform admin required', code: 'forbidden' });
  const b = ctx.body || {};
  const channel = String(b.channel || '').toLowerCase();
  const summary = String(b.summary || '').trim().slice(0, 500);
  
  if (db.isPostgres) {
    const tRes = await db.query('SELECT id FROM tenants WHERE id = $1', [String(b.tenantId || '')]);
    if (tRes.rowCount === 0 || !APPROACH_CHANNELS.has(channel) || !summary) return core.sendJson(res, 422, { error: 'valid client, channel, and summary required', code: 'bad_activity' });
    
    const tenantId = tRes.rows[0].id;
    const now = new Date().toISOString();
    let activity;

    await db.transaction(async (client) => {
      const actRes = await client.query(
        `INSERT INTO client_activities (id, tenant_id, type, channel, visibility, summary, actor_user_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id, tenant_id, type, channel, visibility, summary, actor_user_id, created_at`,
        [core.genId('act_'), tenantId, 'approach', channel, 'internal', summary, ctx.user.id, now]
      );
      const row = actRes.rows[0];
      activity = { id: row.id, tenantId: row.tenant_id, type: row.type, channel: row.channel, visibility: row.visibility, summary: row.summary, actorUserId: row.actor_user_id, createdAt: row.created_at };

      await client.query('UPDATE tenants SET last_approached_at = $1 WHERE id = $2', [now, tenantId]);
      await db.addAuditSql(client, ctx, 'client.approached', 'tenant', tenantId, { channel });
    });

    await core.mutate((store) => {
      store.clientActivities.push(activity);
    });

    return core.sendJson(res, 201, { activity });
  }

  const tenant = core.db().tenants.find((row) => row.id === String(b.tenantId || ''));
  if (!tenant || !APPROACH_CHANNELS.has(channel) || !summary) return core.sendJson(res, 422, { error: 'valid client, channel, and summary required', code: 'bad_activity' });
  let activity;
  await core.mutate((store) => {
    const now = new Date().toISOString();
    activity = { id: core.genId('act_'), tenantId: tenant.id, type: 'approach', channel, visibility: 'internal', summary, actorUserId: ctx.user.id, createdAt: now };
    store.clientActivities.push(activity);
    const target = store.tenants.find((row) => row.id === tenant.id); target.lastApproachedAt = now;
    addAudit(store, ctx, 'client.approached', 'tenant', tenant.id, { channel });
  });
  core.sendJson(res, 201, { activity });
}

async function apiIntegrations(req, res, ctx) {
  let requests;
  if (db.isPostgres) {
    const { rows } = await db.query(
      'SELECT * FROM integration_requests WHERE tenant_id = $1 ORDER BY created_at DESC',
      [ctx.tenant.id]
    );
    requests = rows.map((r) => ({
      id: r.id,
      tenantId: r.tenantId || r.tenant_id,
      integrationId: r.integrationId || r.integration_id,
      status: r.status,
      createdBy: r.createdBy || r.created_by,
      createdAt: toIso(r.createdAt || r.created_at),
    }));
  } else {
    requests = core.db().integrationRequests.filter((row) => row.tenantId === ctx.tenant.id);
  }
  const integrations = INTEGRATION_CATALOG.map((item) => {
    const request = requests.filter((row) => row.integrationId === item.id).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
    return { ...item, status: request ? request.status : 'setup_required', requestedAt: request ? request.createdAt : null };
  });
  core.sendJson(res, 200, { integrations, note: 'Setup requests do not connect external services.' });
}

async function apiIntegrationRequest(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const integrationId = String((ctx.body || {}).integrationId || '');
  const item = INTEGRATION_CATALOG.find((row) => row.id === integrationId);
  if (!item) return core.sendJson(res, 422, { error: 'unknown integration', code: 'bad_integration' });

  if (db.isPostgres) {
    let request;
    const existing = await db.query(
      'SELECT * FROM integration_requests WHERE tenant_id = $1 AND integration_id = $2 AND status = $3',
      [ctx.tenant.id, integrationId, 'requested']
    );
    if (existing.rowCount > 0) {
      const r = existing.rows[0];
      request = { id: r.id, tenantId: r.tenantId || r.tenant_id, integrationId: r.integrationId || r.integration_id, status: r.status, createdBy: r.createdBy || r.created_by, createdAt: toIso(r.createdAt || r.created_at) };
    } else {
      const now = new Date().toISOString();
      const id = core.genId('int_');
      await db.transaction(async (client) => {
        await client.query(
          `INSERT INTO integration_requests (id, tenant_id, integration_id, status, created_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, ctx.tenant.id, integrationId, 'requested', ctx.user.id, now]
        );
        await db.addAuditSql(client, ctx, 'integration.setup_requested', 'integration', integrationId);
      });
      request = { id, tenantId: ctx.tenant.id, integrationId, status: 'requested', createdBy: ctx.user.id, createdAt: now };
    }
    await core.mutate((store) => {
      if (!store.integrationRequests.some((x) => x.id === request.id)) {
        store.integrationRequests.push(request);
      }
    });
    return core.sendJson(res, 201, { request, note: 'Request recorded. The integration is not connected.' });
  }

  let request;
  await core.mutate((store) => {
    const existing = store.integrationRequests.find((row) => row.tenantId === ctx.tenant.id && row.integrationId === integrationId && row.status === 'requested');
    if (existing) { request = existing; return; }
    request = { id: core.genId('int_'), tenantId: ctx.tenant.id, integrationId, status: 'requested', createdBy: ctx.user.id, createdAt: new Date().toISOString() };
    store.integrationRequests.push(request);
    addAudit(store, ctx, 'integration.setup_requested', 'integration', integrationId);
  });
  core.sendJson(res, 201, { request, note: 'Request recorded. The integration is not connected.' });
}

async function apiAgencyPromptGet(req, res, ctx) {
  if (db.isPostgres) {
    const { rows } = await db.query(
      `SELECT ap.tenant_id, ap.text, ap.version, ap.updated_by, ap.updated_at, u.name as editor_name, u.email as editor_email
       FROM agency_prompts ap
       LEFT JOIN users u ON u.id = ap.updated_by
       WHERE ap.tenant_id = $1`,
      [ctx.tenant.id]
    );
    const row = rows[0];
    return core.sendJson(res, 200, {
      prompt: row ? row.text : '',
      version: row ? row.version : 0,
      updatedAt: row ? toIso(row.updatedAt || row.updated_at) : null,
      updatedBy: row ? (row.editorName || row.editor_name || row.editorEmail || row.editor_email) : null,
    });
  }
  const row = core.db().agencyPrompts.find((item) => item.tenantId === ctx.tenant.id);
  const editor = row ? core.db().users.find((user) => user.id === row.updatedBy) : null;
  core.sendJson(res, 200, { prompt: row ? row.text : '', version: row ? row.version : 0, updatedAt: row ? row.updatedAt : null, updatedBy: editor ? editor.name || editor.email : null });
}

async function apiAgencyPromptSave(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const text = String((ctx.body || {}).prompt || '').trim();
  if (text.length < 20 || text.length > 12000) return core.sendJson(res, 422, { error: 'agency prompt must be between 20 and 12,000 characters', code: 'bad_prompt' });
  const now = new Date().toISOString();

  if (db.isPostgres) {
    let savedRow;
    await db.transaction(async (client) => {
      const res = await client.query(
        `INSERT INTO agency_prompts (tenant_id, text, version, updated_by, updated_at)
         VALUES ($1, $2, 1, $3, $4)
         ON CONFLICT (tenant_id)
         DO UPDATE SET text = EXCLUDED.text, version = agency_prompts.version + 1, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [ctx.tenant.id, text, ctx.user.id, now]
      );
      savedRow = res.rows[0];
      await db.addAuditSql(client, ctx, 'agency.prompt.updated', 'agency_prompt', ctx.tenant.id, { version: savedRow.version });
    });
    await core.mutate((store) => {
      const existing = store.agencyPrompts.find((item) => item.tenantId === ctx.tenant.id);
      if (!existing) {
        store.agencyPrompts.push({ tenantId: ctx.tenant.id, text, version: savedRow.version, updatedBy: ctx.user.id, updatedAt: now });
      } else {
        existing.text = text; existing.version = savedRow.version; existing.updatedBy = ctx.user.id; existing.updatedAt = now;
      }
    });
    return core.sendJson(res, 200, { prompt: savedRow.text, version: savedRow.version, updatedAt: toIso(savedRow.updated_at), updatedBy: ctx.user.name || ctx.user.email });
  }

  let row;
  await core.mutate((store) => {
    const now = new Date().toISOString();
    row = store.agencyPrompts.find((item) => item.tenantId === ctx.tenant.id);
    if (!row) {
      row = { tenantId: ctx.tenant.id, text, version: 1, updatedBy: ctx.user.id, updatedAt: now };
      store.agencyPrompts.push(row);
    } else {
      row.text = text; row.version += 1; row.updatedBy = ctx.user.id; row.updatedAt = now;
    }
    addAudit(store, ctx, 'agency.prompt.updated', 'agency_prompt', ctx.tenant.id, { version: row.version });
  });
  core.sendJson(res, 200, { prompt: row.text, version: row.version, updatedAt: row.updatedAt, updatedBy: ctx.user.name || ctx.user.email });
}

async function apiTenantUpdate(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  const name = String(b.name || '').trim().slice(0, 80);
  const color = String(b.color || '').trim();
  if (!name || !/^#[0-9a-fA-F]{6}$/.test(color)) return core.sendJson(res, 422, { error: 'valid tenant name and color required', code: 'bad_tenant' });

  if (db.isPostgres) {
    const tRes = await db.query('SELECT * FROM tenants WHERE id = $1', [ctx.tenant.id]);
    if (tRes.rowCount === 0) return core.sendJson(res, 404, { error: 'tenant not found', code: 'not_found' });
    const currentBranding = tRes.rows[0].branding || {};
    const updatedBranding = { ...currentBranding, color };
    await db.transaction(async (client) => {
      await client.query(
        'UPDATE tenants SET name = $1, branding = $2 WHERE id = $3',
        [name, JSON.stringify(updatedBranding), ctx.tenant.id]
      );
      await db.addAuditSql(client, ctx, 'tenant.settings.updated', 'tenant', ctx.tenant.id);
    });
    const updated = { ...tRes.rows[0], name, branding: updatedBranding };
    return core.sendJson(res, 200, { tenant: publicTenant(updated) });
  }

  let tenant;
  await core.mutate((store) => {
    tenant = store.tenants.find((row) => row.id === ctx.tenant.id);
    tenant.name = name; tenant.branding = { ...(tenant.branding || {}), color };
    addAudit(store, ctx, 'tenant.settings.updated', 'tenant', tenant.id);
  });
  core.sendJson(res, 200, { tenant: publicTenant(tenant) });
}

async function apiMemberRole(req, res, ctx) {
  const b = ctx.body || {};
  const role = String(b.role || '');
  if (!['owner', 'member'].includes(role)) return core.sendJson(res, 422, { error: 'tenant roles are owner or member', code: 'bad_role' });
  if (db.isPostgres) {
    const userId = String(b.userId || '');
    const found = await db.query('SELECT id, tenant_id, email, name, role, status, created_at FROM users WHERE id = $1 AND tenant_id = $2', [userId, ctx.tenant.id]);
    if (found.rowCount === 0) return core.sendJson(res, 404, { error: 'user not found', code: 'not_found' });
    const target = found.rows[0];
    await db.transaction(async (client) => {
      await client.query('UPDATE users SET role = $1 WHERE id = $2 AND tenant_id = $3', [role, target.id, ctx.tenant.id]);
      await db.addAuditSql(client, ctx, 'member.role.updated', 'user', target.id, { role });
    });
    return core.sendJson(res, 200, { user: publicUser({ ...target, role }) });
  }
  const target = core.db().users.find((u) => u.id === String(b.userId || '') && u.tenantId === ctx.tenant.id);
  if (!target) return core.sendJson(res, 404, { error: 'user not found', code: 'not_found' });
  await core.mutate((d) => { const u = d.users.find((x) => x.id === target.id); u.role = role; addAudit(d, ctx, 'member.role.updated', 'user', u.id, { role }); });
  core.sendJson(res, 200, { user: publicUser({ ...target, role }) });
}

async function apiAdminOverview(req, res) {
  if (db.isPostgres) {
    const [tenantsRes, usersRes, ticketsRes, walletsRes, usageRes, invoicesRes] = await Promise.all([
      db.query('SELECT status FROM tenants'),
      db.query('SELECT id FROM users'),
      db.query('SELECT status FROM support_tickets'),
      db.query('SELECT balance_paise FROM wallets'),
      db.query('SELECT calls FROM usage'),
      db.query('SELECT amount_paise, status FROM invoices'),
    ]);

    const tenants = tenantsRes.rows;
    const issued = invoicesRes.rows.filter((row) => row.status === 'issued' || row.status === 'paid');

    return core.sendJson(res, 200, { totals: {
      tenants: tenants.length,
      activeTenants: tenants.filter((t) => (t.status || 'active') === 'active').length,
      closedTenants: tenants.filter((t) => t.status === 'closed').length,
      users: usersRes.rows.length,
      openTickets: ticketsRes.rows.filter((t) => t.status !== 'closed').length,
      walletPaise: walletsRes.rows.reduce((n, w) => n + Number(w.balancePaise || 0), 0),
      calls: usageRes.rows.reduce((n, u) => n + Number(u.calls || 0), 0),
      invoicedPaise: issued.reduce((n, row) => n + Number(row.amountPaise || 0), 0),
      outstandingPaise: invoicesRes.rows.filter((row) => row.status === 'issued').reduce((n, row) => n + Number(row.amountPaise || 0), 0),
    } });
  }

  const d = core.db();
  const issued = d.invoices.filter((row) => row.status === 'issued' || row.status === 'paid');
  core.sendJson(res, 200, { totals: {
    tenants: d.tenants.length,
    activeTenants: d.tenants.filter((t) => (t.status || 'active') === 'active').length,
    closedTenants: d.tenants.filter((t) => t.status === 'closed').length,
    users: d.users.length,
    openTickets: d.supportTickets.filter((t) => t.status !== 'closed').length,
    walletPaise: d.wallets.reduce((n, w) => n + w.balancePaise, 0),
    calls: d.usage.reduce((n, u) => n + (u.calls || 0), 0),
    invoicedPaise: issued.reduce((n, row) => n + row.amountPaise, 0),
    outstandingPaise: d.invoices.filter((row) => row.status === 'issued').reduce((n, row) => n + row.amountPaise, 0),
  } });
}

async function apiAdminTenants(req, res) {
  if (db.isPostgres) {
    const tenantsRes = await db.query('SELECT * FROM tenants ORDER BY created_at ASC');
    const [usersRes, agentsRes, usageRes, invoicesRes, walletsRes] = await Promise.all([
      db.query('SELECT tenant_id FROM users'),
      db.query('SELECT tenant_id FROM agents'),
      db.query('SELECT tenant_id, calls FROM usage'),
      db.query('SELECT tenant_id, amount_paise, status FROM invoices'),
      db.query('SELECT * FROM wallets'),
    ]);

    const usersCount = {};
    for (const u of usersRes.rows) usersCount[u.tenantId] = (usersCount[u.tenantId] || 0) + 1;
    const agentsCount = {};
    for (const a of agentsRes.rows) agentsCount[a.tenantId] = (agentsCount[a.tenantId] || 0) + 1;
    const callsCount = {};
    for (const u of usageRes.rows) callsCount[u.tenantId] = (callsCount[u.tenantId] || 0) + Number(u.calls || 0);
    const outstandingMap = {};
    for (const inv of invoicesRes.rows) {
      if (inv.status === 'issued') outstandingMap[inv.tenantId] = (outstandingMap[inv.tenantId] || 0) + Number(inv.amountPaise || 0);
    }
    const walletMap = {};
    for (const w of walletsRes.rows) walletMap[w.tenantId] = w;

    return core.sendJson(res, 200, { tenants: tenantsRes.rows.map((t) => ({
      ...publicTenant(t),
      users: usersCount[t.id] || 0,
      agents: agentsCount[t.id] || 0,
      calls: callsCount[t.id] || 0,
      lastApproachedAt: t.lastApproachedAt || null,
      outstandingPaise: outstandingMap[t.id] || 0,
      wallet: publicWallet(walletMap[t.id] || { id: null, tenantId: t.id, currency: 'INR', balancePaise: 0 }),
    })) });
  }

  const d = core.db();
  core.sendJson(res, 200, { tenants: d.tenants.map((t) => ({
    ...publicTenant(t),
    users: d.users.filter((u) => u.tenantId === t.id).length,
    agents: d.agents.filter((a) => a.tenantId === t.id).length,
    calls: d.usage.filter((u) => u.tenantId === t.id).reduce((n, row) => n + Number(row.calls || 0), 0),
    lastApproachedAt: t.lastApproachedAt || null,
    outstandingPaise: d.invoices.filter((row) => row.tenantId === t.id && row.status === 'issued').reduce((n, row) => n + row.amountPaise, 0),
    wallet: publicWallet(d.wallets.find((w) => w.tenantId === t.id) || { id: null, tenantId: t.id, currency: 'INR', balancePaise: 0 }),
  })) });
}

/* ==========================================================================
   Industry Templates & Tenant Provisioning
   ========================================================================== */

const INDUSTRY_TEMPLATES = Object.freeze({
  dental: Object.freeze({
    presetId: 'preset_dental_v1',
    defaultGreeting: 'Thank you for calling {business_name}. How can I help you today?',
    defaultPersona: 'You are a friendly dental receptionist for {business_name}. Assist callers with booking appointments, insurance questions, and general clinic info. Stay polite, empathetic, and professional.',
    defaultHours: Object.freeze({ mon: '09:00-17:00', tue: '09:00-17:00', wed: '09:00-17:00', thu: '09:00-17:00', fri: '09:00-14:00' }),
  }),
  legal: Object.freeze({
    presetId: 'preset_legal_v1',
    defaultGreeting: 'Thank you for calling {business_name}. How may I assist you?',
    defaultPersona: 'You are a professional legal intake specialist for {business_name}. Gather key incident details and schedule consultations. Never provide legal advice.',
    defaultHours: Object.freeze({ mon: '09:00-18:00', tue: '09:00-18:00', wed: '09:00-18:00', thu: '09:00-18:00', fri: '09:00-17:00' }),
  }),
  hvac: Object.freeze({
    presetId: 'preset_hvac_v1',
    defaultGreeting: 'Thanks for calling {business_name}. What HVAC issue can I help with?',
    defaultPersona: 'You are an HVAC scheduling assistant for {business_name}. Ask about their AC or heating problem, urgency, address, and schedule an appointment.',
    defaultHours: Object.freeze({ mon: '08:00-18:00', tue: '08:00-18:00', wed: '08:00-18:00', thu: '08:00-18:00', fri: '08:00-17:00', sat: '09:00-14:00' }),
  }),
  real_estate: Object.freeze({
    presetId: 'preset_realestate_v1',
    defaultGreeting: 'Hello, thank you for calling {business_name}!',
    defaultPersona: 'You are a real estate assistant for {business_name}. Qualify buyers and sellers on budget, location, and timeline, and offer property viewings.',
    defaultHours: Object.freeze({ mon: '09:00-19:00', tue: '09:00-19:00', wed: '09:00-19:00', thu: '09:00-19:00', fri: '09:00-18:00', sat: '10:00-16:00' }),
  }),
  restaurant: Object.freeze({
    presetId: 'preset_restaurant_v1',
    defaultGreeting: 'Welcome to {business_name}! How can I help you today?',
    defaultPersona: 'You are a friendly host for {business_name}. Help guests with reservations, opening hours, party sizes, and general menu questions.',
    defaultHours: Object.freeze({ mon: '11:00-22:00', tue: '11:00-22:00', wed: '11:00-22:00', thu: '11:00-22:00', fri: '11:00-23:00', sat: '10:00-23:00', sun: '10:00-21:00' }),
  }),
  med_spa: Object.freeze({
    presetId: 'preset_medspa_v1',
    defaultGreeting: 'Thank you for calling {business_name}. How can I assist you?',
    defaultPersona: 'You are a welcoming spa receptionist for {business_name}. Explain popular treatments and assist clients with booking aesthetic consultations.',
    defaultHours: Object.freeze({ mon: '10:00-18:00', tue: '10:00-18:00', wed: '10:00-18:00', thu: '10:00-19:00', fri: '10:00-18:00', sat: '10:00-16:00' }),
  }),
});

function publicClientSettings(s) {
  if (!s) return null;
  return {
    tenantId: s.tenantId || s.tenant_id,
    industry: s.industry || '',
    timezone: s.timezone || 'Asia/Kolkata',
    businessHours: s.businessHours || s.business_hours || {},
    knowledgeBase: s.knowledgeBase || s.knowledge_base || '',
    customFields: s.customFields || s.custom_fields || {},
    calendarProvider: s.calendarProvider || s.calendar_provider || null,
    updatedAt: toIso(s.updatedAt || s.updated_at),
  };
}

async function apiAdminTenantProvision(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  const name = String(b.name || '').trim().slice(0, 80);
  const ownerEmail = String(b.ownerEmail || '').trim().toLowerCase().slice(0, 160);
  const password = String(b.password || '');
  const industry = String(b.industry || '').trim().toLowerCase();

  if (!name) return core.sendJson(res, 422, { error: 'client workspace name required', code: 'bad_tenant' });
  if (!industry || !INDUSTRY_TEMPLATES[industry]) {
    return core.sendJson(res, 422, { error: 'unknown or unsupported industry template', code: 'invalid_industry' });
  }
  if (!ownerEmail || !EMAIL_RE.test(ownerEmail) || password.length < 8) {
    return core.sendJson(res, 422, { error: 'valid owner email and password (minimum 8 characters) required', code: 'bad_owner' });
  }

  if (db.isPostgres) {
    const emailCheck = await db.query('SELECT 1 FROM users WHERE email = $1', [ownerEmail]);
    if (emailCheck.rowCount > 0) return core.sendJson(res, 409, { error: 'owner email is already registered', code: 'email_taken' });
  } else {
    if (core.db().users.some((user) => user.email === ownerEmail)) {
      return core.sendJson(res, 409, { error: 'owner email is already registered', code: 'email_taken' });
    }
  }

  const template = INDUSTRY_TEMPLATES[industry];
  const greeting = template.defaultGreeting.replace(/\{business_name\}/g, name);
  const persona = template.defaultPersona.replace(/\{business_name\}/g, name);
  const timezone = String(b.timezone || 'Asia/Kolkata').trim();
  const businessHours = b.businessHours || template.defaultHours;
  const knowledgeBase = String(b.knowledgeBase || '').trim();
  const customFields = b.customFields || {};
  const now = new Date().toISOString();

  let tenant;
  let user;
  let agent;
  let demoLinkRecord;
  let demoToken;

  if (db.isPostgres) {
    await db.transaction(async (client) => {
      const slugRows = await client.query('SELECT slug FROM tenants');
      const taken = new Set(slugRows.rows.map((r) => r.slug));
      const slug = makeSlug(name, taken);
      const tenantId = core.genId('t_');

      tenant = {
        id: tenantId, name, slug,
        createdAt: now, branding: { color: '#B88A2D' }, providers: { ...DEFAULT_PROVIDERS },
        plan: 'studio', status: 'active', privacyMode: 'standard',
      };

      await client.query(
        `INSERT INTO tenants (id, name, slug, branding, providers, plan, status, privacy_mode, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [tenantId, name, slug, JSON.stringify(tenant.branding), JSON.stringify(tenant.providers), tenant.plan, tenant.status, tenant.privacyMode, now]
      );

      await client.query(
        `INSERT INTO wallets (id, tenant_id, currency, balance_paise, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [core.genId('wal_'), tenantId, 'INR', 0, now, now]
      );

      const userId = core.genId('u_');
      const passHash = core.hashPassword(password);
      const ownerName = String(b.ownerName || `${name} Owner`).trim().slice(0, 80);
      user = { id: userId, tenantId, email: ownerEmail, name: ownerName, passHash, role: 'owner', status: 'active', createdAt: now };

      await client.query(
        `INSERT INTO users (id, tenant_id, email, name, pass_hash, role, status, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [userId, tenantId, ownerEmail, ownerName, passHash, user.role, user.status, now]
      );

      const agentId = core.genId('ag_');
      const agentName = `${name} Receptionist`;
      agent = {
        id: agentId,
        tenantId,
        name: agentName,
        persona,
        tts: {},
        greeting,
        telephony: {},
        presetId: template.presetId,
        createdAt: now,
      };

      await client.query(
        `INSERT INTO agents (id, tenant_id, name, persona, tts, greeting, telephony, preset_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [agentId, tenantId, agentName, persona, JSON.stringify(agent.tts), greeting, JSON.stringify(agent.telephony), template.presetId, now]
      );

      await client.query(
        `INSERT INTO client_settings (tenant_id, industry, timezone, business_hours, knowledge_base, custom_fields, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [tenantId, industry, timezone, JSON.stringify(businessHours), knowledgeBase, JSON.stringify(customFields), now]
      );

      const generated = demoLinks.createDemoToken();
      demoToken = generated.token;
      const limits = demoLinks.normalizeDemoLimits({});
      demoLinkRecord = {
        id: generated.id,
        tokenHash: generated.tokenHash,
        tenantId,
        agentId,
        label: `${agentName} demo`,
        status: 'active',
        starts: 0,
        createdBy: userId,
        createdAt: now,
        ...limits,
      };

      await client.query(
        `INSERT INTO demo_links (id, token_hash, tenant_id, agent_id, label, status, starts, max_starts, max_session_seconds, expires_at, revoked_at, revoked_by, created_by, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [demoLinkRecord.id, demoLinkRecord.tokenHash, demoLinkRecord.tenantId, demoLinkRecord.agentId, demoLinkRecord.label, demoLinkRecord.status, demoLinkRecord.starts, demoLinkRecord.maxStarts, demoLinkRecord.maxSessionSeconds, demoLinkRecord.expiresAt, demoLinkRecord.revokedAt, demoLinkRecord.revokedBy, demoLinkRecord.createdBy, demoLinkRecord.createdAt]
      );

      await client.query(
        `INSERT INTO client_activities (id, tenant_id, type, channel, visibility, summary, actor_user_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [core.genId('act_'), tenantId, 'workspace_provisioned', 'internal', 'internal', `Client workspace provisioned for industry ${industry}.`, ctx.user.id, now]
      );

      await db.addAuditSql(client, ctx, 'admin.tenant.provisioned', 'tenant', tenantId, { industry, agentId });
    });
  } else {
    await core.mutate((store) => {
      const slug = makeSlug(name, new Set(store.tenants.map((t) => t.slug)));
      const tenantId = core.genId('t_');
      tenant = {
        id: tenantId, name, slug,
        createdAt: now, branding: { color: '#B88A2D' }, providers: { ...DEFAULT_PROVIDERS },
        plan: 'studio', status: 'active', privacyMode: 'standard',
      };
      store.tenants.push(tenant);

      store.wallets.push({ id: core.genId('wal_'), tenantId, currency: 'INR', balancePaise: 0, createdAt: now, updatedAt: now });

      const userId = core.genId('u_');
      const passHash = core.hashPassword(password);
      const ownerName = String(b.ownerName || `${name} Owner`).trim().slice(0, 80);
      user = { id: userId, tenantId, email: ownerEmail, name: ownerName, passHash, role: 'owner', status: 'active', createdAt: now };
      store.users.push(user);

      const agentId = core.genId('ag_');
      const agentName = `${name} Receptionist`;
      agent = {
        id: agentId,
        tenantId,
        name: agentName,
        persona,
        tts: {},
        greeting,
        telephony: {},
        presetId: template.presetId,
        createdAt: now,
      };
      store.agents.push(agent);

      store.clientSettings.push({
        tenantId,
        industry,
        timezone,
        businessHours,
        knowledgeBase,
        customFields,
        updatedAt: now,
      });

      const generated = demoLinks.createDemoToken();
      demoToken = generated.token;
      const limits = demoLinks.normalizeDemoLimits({});
      demoLinkRecord = {
        id: generated.id,
        tokenHash: generated.tokenHash,
        tenantId,
        agentId,
        label: `${agentName} demo`,
        status: 'active',
        starts: 0,
        createdBy: userId,
        createdAt: now,
        ...limits,
      };
      store.demoLinks.push(demoLinkRecord);

      store.clientActivities.push({
        id: core.genId('act_'),
        tenantId,
        type: 'workspace_provisioned',
        channel: 'internal',
        visibility: 'internal',
        summary: `Client workspace provisioned for industry ${industry}.`,
        actorUserId: ctx.user.id,
        createdAt: now,
      });

      addAudit(store, ctx, 'admin.tenant.provisioned', 'tenant', tenantId, { industry, agentId });
    });
  }

  core.sendJson(res, 201, {
    tenant: publicTenant(tenant),
    owner: publicUser(user),
    agent: publicAgent(agent),
    demoLink: demoLinks.publicDemoLink(demoLinkRecord),
    sharePath: `/demo/${demoToken}`,
  });
}

async function apiAdminTenantSettingsGet(req, res, ctx, tenantId) {
  if (db.isPostgres) {
    const tRes = await db.query('SELECT id FROM tenants WHERE id = $1', [tenantId]);
    if (tRes.rowCount === 0) return core.sendJson(res, 404, { error: 'tenant not found', code: 'not_found' });
    const sRes = await db.query('SELECT * FROM client_settings WHERE tenant_id = $1', [tenantId]);
    const settings = sRes.rowCount > 0 ? sRes.rows[0] : { tenantId, industry: '', timezone: 'Asia/Kolkata', businessHours: {}, knowledgeBase: '', customFields: {} };
    return core.sendJson(res, 200, { settings: publicClientSettings(settings) });
  }

  const t = core.db().tenants.find((item) => item.id === tenantId);
  if (!t) return core.sendJson(res, 404, { error: 'tenant not found', code: 'not_found' });
  const s = core.db().clientSettings.find((item) => item.tenantId === tenantId || item.tenant_id === tenantId);
  const settings = s || { tenantId, industry: '', timezone: 'Asia/Kolkata', businessHours: {}, knowledgeBase: '', customFields: {} };
  core.sendJson(res, 200, { settings: publicClientSettings(settings) });
}

async function apiAdminTenantSettingsPatch(req, res, ctx, tenantId) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  const now = new Date().toISOString();

  if (db.isPostgres) {
    const tRes = await db.query('SELECT id FROM tenants WHERE id = $1', [tenantId]);
    if (tRes.rowCount === 0) return core.sendJson(res, 404, { error: 'tenant not found', code: 'not_found' });

    const sRes = await db.query('SELECT * FROM client_settings WHERE tenant_id = $1', [tenantId]);
    const existing = sRes.rowCount > 0 ? sRes.rows[0] : null;

    const industry = b.industry !== undefined ? String(b.industry).trim() : (existing ? existing.industry : '');
    const timezone = b.timezone !== undefined ? String(b.timezone).trim() : (existing ? existing.timezone : 'Asia/Kolkata');
    const businessHours = b.businessHours !== undefined ? b.businessHours : (existing ? (existing.businessHours || existing.business_hours || {}) : {});
    const knowledgeBase = b.knowledgeBase !== undefined ? String(b.knowledgeBase).trim() : (existing ? existing.knowledgeBase : '');
    const customFields = b.customFields !== undefined ? b.customFields : (existing ? (existing.customFields || existing.custom_fields || {}) : {});

    const uRes = await db.query(
      `INSERT INTO client_settings (tenant_id, industry, timezone, business_hours, knowledge_base, custom_fields, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id) DO UPDATE SET
         industry = EXCLUDED.industry,
         timezone = EXCLUDED.timezone,
         business_hours = EXCLUDED.business_hours,
         knowledge_base = EXCLUDED.knowledge_base,
         custom_fields = EXCLUDED.custom_fields,
         updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [tenantId, industry, timezone, JSON.stringify(businessHours), knowledgeBase, JSON.stringify(customFields), now]
    );
    return core.sendJson(res, 200, { settings: publicClientSettings(uRes.rows[0]) });
  }

  let settings;
  await core.mutate((d) => {
    const t = d.tenants.find((item) => item.id === tenantId);
    if (!t) return;
    settings = d.clientSettings.find((item) => item.tenantId === tenantId || item.tenant_id === tenantId);
    if (!settings) {
      settings = {
        tenantId,
        industry: '',
        timezone: 'Asia/Kolkata',
        businessHours: {},
        knowledgeBase: '',
        customFields: {},
        updatedAt: now,
      };
      d.clientSettings.push(settings);
    }
    if (b.industry !== undefined) settings.industry = String(b.industry).trim();
    if (b.timezone !== undefined) settings.timezone = String(b.timezone).trim();
    if (b.businessHours !== undefined) settings.businessHours = b.businessHours;
    if (b.knowledgeBase !== undefined) settings.knowledgeBase = String(b.knowledgeBase).trim();
    if (b.customFields !== undefined) settings.customFields = b.customFields;
    settings.updatedAt = now;
  });

  if (!settings) return core.sendJson(res, 404, { error: 'tenant not found', code: 'not_found' });
  core.sendJson(res, 200, { settings: publicClientSettings(settings) });
}

async function apiAdminTenantCreate(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  const name = String(b.name || '').trim().slice(0, 80);
  const ownerEmail = String(b.ownerEmail || '').trim().toLowerCase().slice(0, 160);
  const password = String(b.password || '');
  if (!name) return core.sendJson(res, 422, { error: 'client workspace name required', code: 'bad_tenant' });
  if (ownerEmail && (!EMAIL_RE.test(ownerEmail) || password.length < 12)) return core.sendJson(res, 422, { error: 'a valid owner email and 12 character temporary password are required together', code: 'bad_owner' });
  if (!ownerEmail && password) return core.sendJson(res, 422, { error: 'owner email is required when a password is supplied', code: 'bad_owner' });
  if (ownerEmail) {
    if (db.isPostgres) {
      const emailCheck = await db.query('SELECT 1 FROM users WHERE email = $1', [ownerEmail]);
      if (emailCheck.rowCount > 0) return core.sendJson(res, 409, { error: 'owner email is already registered', code: 'email_taken' });
    } else {
      if (core.db().users.some((user) => user.email === ownerEmail)) return core.sendJson(res, 409, { error: 'owner email is already registered', code: 'email_taken' });
    }
  }

  let tenant; let user = null;
  const now = new Date().toISOString();

  if (db.isPostgres) {
    await db.transaction(async (client) => {
      const slugRows = await client.query('SELECT slug FROM tenants');
      const taken = new Set(slugRows.rows.map((r) => r.slug));
      const slug = makeSlug(name, taken);
      const tenantId = core.genId('t_');

      tenant = {
        id: tenantId, name, slug,
        createdAt: now, branding: { color: '#B88A2D' }, providers: { ...DEFAULT_PROVIDERS },
        plan: 'studio', status: ownerEmail ? 'active' : 'onboarding', privacyMode: 'standard',
      };

      try {
        await client.query(
          `INSERT INTO tenants (id, name, slug, branding, providers, plan, status, privacy_mode, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [tenantId, name, slug, JSON.stringify(tenant.branding), JSON.stringify(tenant.providers), tenant.plan, tenant.status, tenant.privacyMode, now]
        );
      } catch (err) {
        if (err.code === '23505') throw Object.assign(new Error('slug conflict on tenant insert'), { statusCode: 409, code: 'slug_conflict' });
        throw err;
      }

      await client.query(
        `INSERT INTO wallets (id, tenant_id, currency, balance_paise, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [core.genId('wal_'), tenantId, 'INR', 0, now, now]
      );

      if (ownerEmail) {
        const userId = core.genId('u_');
        const passHash = core.hashPassword(password);
        const ownerName = String(b.ownerName || 'Client Owner').trim().slice(0, 80);
        user = { id: userId, tenantId, email: ownerEmail, name: ownerName, passHash, role: 'owner', status: 'active', createdAt: now };
        
        try {
          await client.query(
            `INSERT INTO users (id, tenant_id, email, name, pass_hash, role, status, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [userId, tenantId, ownerEmail, ownerName, passHash, user.role, user.status, now]
          );
        } catch (err) {
          if (err.code === '23505') throw Object.assign(new Error('owner email is already registered'), { statusCode: 409, code: 'email_taken' });
          throw err;
        }
      }

      await client.query(
        `INSERT INTO client_activities (id, tenant_id, type, channel, visibility, summary, actor_user_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [core.genId('act_'), tenantId, 'workspace_created', 'internal', 'internal', 'Client workspace created in Agency OS.', ctx.user.id, now]
      );

      await db.addAuditSql(client, ctx, 'admin.tenant.created', 'tenant', tenantId, { ownerCreated: !!user });
    });
  } else {
    await core.mutate((store) => {
      tenant = {
        id: core.genId('t_'), name, slug: makeSlug(name, new Set(store.tenants.map((t) => t.slug))),
        createdAt: now, branding: { color: '#B88A2D' }, providers: { ...DEFAULT_PROVIDERS },
        plan: 'studio', status: ownerEmail ? 'active' : 'onboarding', privacyMode: 'standard',
      };
      store.tenants.push(tenant);
      store.wallets.push({ id: core.genId('wal_'), tenantId: tenant.id, currency: 'INR', balancePaise: 0, createdAt: now, updatedAt: now });
      if (ownerEmail) {
        user = { id: core.genId('u_'), tenantId: tenant.id, email: ownerEmail, name: String(b.ownerName || 'Client Owner').trim().slice(0, 80), passHash: core.hashPassword(password), role: 'owner', status: 'active', createdAt: now };
        store.users.push(user);
      }
      store.clientActivities.push({ id: core.genId('act_'), tenantId: tenant.id, type: 'workspace_created', channel: 'internal', visibility: 'internal', summary: 'Client workspace created in Agency OS.', actorUserId: ctx.user.id, createdAt: now });
      addAudit(store, ctx, 'admin.tenant.created', 'tenant', tenant.id, { ownerCreated: !!user });
    });
  }
  core.sendJson(res, 201, { tenant: publicTenant(tenant), owner: user ? publicUser(user) : null, note: 'No email was sent.' });
}

async function apiAdminUsers(req, res) {
  if (db.isPostgres) {
    const rows = await db.query('SELECT * FROM users ORDER BY created_at ASC');
    return core.sendJson(res, 200, { users: rows.rows.map(publicUser) });
  }
  core.sendJson(res, 200, { users: core.db().users.map(publicUser) });
}

async function apiAdminAudit(req, res) {
  if (db.isPostgres) {
    const rows = await db.query('SELECT * FROM audit_events ORDER BY created_at DESC LIMIT 500');
    return core.sendJson(res, 200, { auditEvents: rows.rows });
  }
  core.sendJson(res, 200, { auditEvents: core.db().auditEvents.slice(-500).reverse() });
}

async function apiAdminTickets(req, res) {
  if (db.isPostgres) {
    const ticketsRes = await db.query('SELECT * FROM support_tickets ORDER BY created_at DESC');
    const tickets = ticketsRes.rows;
    if (tickets.length > 0) {
      const ticketIds = tickets.map((t) => t.id);
      const msgsRes = await db.query(
        'SELECT * FROM support_messages WHERE ticket_id = ANY($1::text[]) ORDER BY created_at ASC',
        [ticketIds]
      );
      const messagesByTicket = {};
      for (const m of msgsRes.rows) {
        if (!messagesByTicket[m.ticketId]) messagesByTicket[m.ticketId] = [];
        messagesByTicket[m.ticketId].push({
          id: m.id,
          ticketId: m.ticketId,
          authorUserId: m.userId,
          body: m.body,
          createdAt: m.createdAt,
        });
      }
      for (const t of tickets) {
        t.messages = messagesByTicket[t.id] || [];
      }
    }
    return core.sendJson(res, 200, { tickets });
  }

  const d = core.db();
  core.sendJson(res, 200, { tickets: d.supportTickets.map((t) => ({ ...t, messages: d.supportMessages.filter((m) => m.ticketId === t.id) })) });
}

async function apiAdminPaymentEvents(req, res) {
  if (db.isPostgres) {
    const rows = await db.query('SELECT * FROM payment_events ORDER BY created_at DESC LIMIT 500');
    return core.sendJson(res, 200, { events: rows.rows });
  }
  core.sendJson(res, 200, { events: core.db().paymentEvents.slice(-500).reverse() });
}

async function apiAdminTenantDetail(req, res) {
  const url = new URL(req.url, 'http://localhost'); const tenantId = String(url.searchParams.get('tenantId') || '');

  if (db.isPostgres) {
    const tRes = await db.query('SELECT * FROM tenants WHERE id = $1', [tenantId]);
    if (tRes.rowCount === 0) return core.sendJson(res, 404, { error: 'tenant not found', code: 'not_found' });
    const tenant = tRes.rows[0];

    const [usersRes, agentsRes, byonRes, usageRes, ticketsRes, walletRes, ledgerRes, invoicesRes, activitiesRes, statusEventsRes] = await Promise.all([
      db.query('SELECT * FROM users WHERE tenant_id = $1', [tenantId]),
      db.query('SELECT * FROM agents WHERE tenant_id = $1', [tenantId]),
      db.query('SELECT * FROM byon_connections WHERE tenant_id = $1', [tenantId]),
      db.query('SELECT * FROM usage WHERE tenant_id = $1 ORDER BY day DESC LIMIT 100', [tenantId]),
      db.query('SELECT * FROM support_tickets WHERE tenant_id = $1', [tenantId]),
      db.query('SELECT * FROM wallets WHERE tenant_id = $1', [tenantId]),
      db.query('SELECT * FROM ledger WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 100', [tenantId]),
      db.query('SELECT * FROM invoices WHERE tenant_id = $1', [tenantId]),
      db.query('SELECT * FROM client_activities WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 100', [tenantId]),
      db.query('SELECT * FROM tenant_status_events WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 100', [tenantId]),
    ]);

    const jsonActivities = (core.db().clientActivities || []).filter((x) => x.tenantId === tenantId);
    const combinedActivities = [...activitiesRes.rows];
    for (const ja of jsonActivities) {
      if (!combinedActivities.some((a) => a.id === ja.id)) {
        combinedActivities.push(ja);
      }
    }
    combinedActivities.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return core.sendJson(res, 200, {
      tenant: publicTenant(tenant),
      users: usersRes.rows.map(publicUser),
      agents: agentsRes.rows.map(publicAgent),
      numbers: byonRes.rows.map((x) => ({ id: x.id, provider: x.provider, address: x.address, label: x.label, status: x.status, createdAt: toIso(x.createdAt) })),
      usage: usageRes.rows.reverse(),
      tickets: ticketsRes.rows.map((t) => ({ ...t, createdAt: toIso(t.createdAt), updatedAt: toIso(t.updatedAt) })),
      wallet: publicWallet(walletRes.rows[0] || { id: null, tenantId, currency: 'INR', balancePaise: 0 }),
      ledger: ledgerRes.rows.map((l) => ({ ...l, createdAt: toIso(l.createdAt) })),
      invoices: invoicesRes.rows.map(publicInvoice),
      activities: combinedActivities.map((a) => ({ ...a, createdAt: toIso(a.createdAt) })),
      statusEvents: statusEventsRes.rows.map((s) => ({ ...s, createdAt: toIso(s.createdAt) })),
    });
  }

  const d = core.db();
  const tenant = d.tenants.find((t) => t.id === tenantId);
  if (!tenant) return core.sendJson(res, 404, { error: 'tenant not found', code: 'not_found' });
  core.sendJson(res, 200, { tenant: publicTenant(tenant), users: d.users.filter((u) => u.tenantId === tenantId).map(publicUser), agents: d.agents.filter((a) => a.tenantId === tenantId).map(publicAgent), numbers: d.byonConnections.filter((x) => x.tenantId === tenantId).map((x) => ({ id: x.id, provider: x.provider, address: x.address, label: x.label, status: x.status, createdAt: x.createdAt })), usage: d.usage.filter((x) => x.tenantId === tenantId).slice(-100).reverse(), tickets: d.supportTickets.filter((x) => x.tenantId === tenantId), wallet: publicWallet(d.wallets.find((w) => w.tenantId === tenantId) || { id: null, tenantId, currency: 'INR', balancePaise: 0 }), ledger: d.ledger.filter((x) => x.tenantId === tenantId).slice(-100).reverse(), invoices: d.invoices.filter((x) => x.tenantId === tenantId).map(publicInvoice), activities: d.clientActivities.filter((x) => x.tenantId === tenantId).slice(-100).reverse(), statusEvents: d.tenantStatusEvents.filter((x) => x.tenantId === tenantId).slice(-100).reverse() });
}

async function apiAdminImpersonate(req, res, ctx) {
  if (ctx.impersonator) return core.sendJson(res, 409, { error: 'nested impersonation is not allowed', code: 'nested_impersonation' });
  const b = ctx.body || {}; const reason = String(b.reason || '').trim().slice(0, 240); const targetId = String(b.userId || '');
  if (!reason || !targetId) return core.sendJson(res, 422, { error: 'valid userId and reason required', code: 'bad_impersonation' });

  if (db.isPostgres) {
    const uRes = await db.query('SELECT * FROM users WHERE id = $1', [targetId]);
    if (uRes.rowCount === 0) return core.sendJson(res, 422, { error: 'valid userId and reason required', code: 'bad_impersonation' });
    const target = uRes.rows[0];
    if (!core.verifyPassword(String(b.password || ''), ctx.user.passHash)) return core.sendJson(res, 401, { error: 'password re-authentication failed', code: 'reauth_failed' });
    if (target.role === 'super_admin' || target.status !== 'active') return core.sendJson(res, 403, { error: 'that account cannot be impersonated', code: 'impersonation_forbidden' });
    const tRes = await db.query('SELECT * FROM tenants WHERE id = $1', [target.tenantId]);
    if (tRes.rowCount === 0 || tRes.rows[0].status !== 'active') return core.sendJson(res, 409, { error: 'target tenant is not active', code: 'target_inactive' });
    const tenant = tRes.rows[0];
    const token = await core.createImpersonationSession(ctx.user.id, target.id, tenant.id, reason);
    const csrfToken = core.generateCsrfToken();
    await db.transaction(async (client) => {
      await db.addAuditSql(client, ctx, 'admin.impersonation.started', 'user', target.id, { reason });
    });
    return core.send(res, 200, JSON.stringify({ ok: true, user: publicUser(target), tenant: publicTenant(tenant) }), { 'Content-Type': 'application/json', 'Set-Cookie': core.authCookies(token, csrfToken) });
  }

  const target = core.db().users.find((u) => u.id === targetId);
  if (!reason || !target) return core.sendJson(res, 422, { error: 'valid userId and reason required', code: 'bad_impersonation' });
  if (!core.verifyPassword(String(b.password || ''), ctx.user.passHash)) return core.sendJson(res, 401, { error: 'password re-authentication failed', code: 'reauth_failed' });
  if (target.role === 'super_admin' || target.status !== 'active') return core.sendJson(res, 403, { error: 'that account cannot be impersonated', code: 'impersonation_forbidden' });
  const tenant = core.db().tenants.find((t) => t.id === target.tenantId);
  if (!tenant || tenant.status !== 'active') return core.sendJson(res, 409, { error: 'target tenant is not active', code: 'target_inactive' });
  const token = await core.createImpersonationSession(ctx.user.id, target.id, tenant.id, reason);
  const csrfToken = core.generateCsrfToken();
  await core.mutate((d) => addAudit(d, ctx, 'admin.impersonation.started', 'user', target.id, { reason }));
  core.send(res, 200, JSON.stringify({ ok: true, user: publicUser(target), tenant: publicTenant(tenant) }), { 'Content-Type': 'application/json', 'Set-Cookie': core.authCookies(token, csrfToken) });
}

async function apiImpersonationExit(req, res, ctx) {
  if (!ctx.impersonator) return core.sendJson(res, 409, { error: 'not impersonating', code: 'not_impersonating' });
  const actor = ctx.impersonator;

  if (db.isPostgres) {
    const tRes = await db.query('SELECT * FROM tenants WHERE id = $1', [actor.tenantId]);
    const tenant = tRes.rows[0];
    const token = await core.createSession(actor.id, actor.tenantId);
    const csrfToken = core.generateCsrfToken();
    await db.transaction(async (client) => {
      await db.addAuditSql(client, ctx, 'admin.impersonation.ended', 'user', ctx.user.id);
    });
    return core.send(res, 200, JSON.stringify({ ok: true, user: publicUser(actor), tenant: publicTenant(tenant) }), { 'Content-Type': 'application/json', 'Set-Cookie': core.authCookies(token, csrfToken) });
  }

  const tenant = core.db().tenants.find((t) => t.id === actor.tenantId);
  const token = await core.createSession(actor.id, actor.tenantId);
  const csrfToken = core.generateCsrfToken();
  await core.mutate((d) => addAudit(d, ctx, 'admin.impersonation.ended', 'user', ctx.user.id));
  core.send(res, 200, JSON.stringify({ ok: true, user: publicUser(actor), tenant: publicTenant(tenant) }), { 'Content-Type': 'application/json', 'Set-Cookie': core.authCookies(token, csrfToken) });
}

async function apiAdminTenantStatus(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  const status = String(b.status || '');
  if (!['onboarding', 'active', 'suspended', 'closed'].includes(status)) return core.sendJson(res, 422, { error: 'invalid status', code: 'bad_status' });
  const tenantId = String(b.tenantId || '');

  if (db.isPostgres) {
    const tRes = await db.query('SELECT * FROM tenants WHERE id = $1', [tenantId]);
    if (tRes.rowCount === 0) return core.sendJson(res, 404, { error: 'tenant not found', code: 'not_found' });
    const tenant = tRes.rows[0];
    const now = new Date().toISOString();

    await db.transaction(async (client) => {
      await client.query('UPDATE tenants SET status = $1 WHERE id = $2', [status, tenantId]);
      if (status !== 'active') {
        await client.query('DELETE FROM sessions WHERE tenant_id = $1', [tenantId]);
      }
      await client.query(
        `INSERT INTO tenant_status_events (id, tenant_id, from_status, to_status, reason, actor_user_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [core.genId('tse_'), tenantId, tenant.status || 'active', status, String(b.reason || '').trim().slice(0, 240), ctx.user.id, now]
      );
      await client.query(
        `INSERT INTO client_activities (id, tenant_id, type, channel, visibility, summary, actor_user_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [core.genId('act_'), tenantId, status === 'closed' ? 'offboarded' : 'status_changed', 'internal', 'internal', `Client status changed from ${tenant.status || 'active'} to ${status}.`, ctx.user.id, now]
      );
      await db.addAuditSql(client, ctx, 'admin.tenant.status', 'tenant', tenantId, { status });
    });

    return core.sendJson(res, 200, { tenant: publicTenant({ ...tenant, status }) });
  }

  const tenant = core.db().tenants.find((t) => t.id === tenantId);
  if (!tenant) return core.sendJson(res, 404, { error: 'tenant not found', code: 'not_found' });
  await core.mutate((d) => {
    const now = new Date().toISOString();
    d.tenants.find((t) => t.id === tenant.id).status = status;
    if (status !== 'active') d.sessions = d.sessions.filter((s) => s.tenantId !== tenant.id);
    d.tenantStatusEvents.push({ id: core.genId('tse_'), tenantId: tenant.id, fromStatus: tenant.status || 'active', toStatus: status, reason: String(b.reason || '').trim().slice(0, 240), actorUserId: ctx.user.id, createdAt: now });
    d.clientActivities.push({ id: core.genId('act_'), tenantId: tenant.id, type: status === 'closed' ? 'offboarded' : 'status_changed', channel: 'internal', visibility: 'internal', summary: `Client status changed from ${tenant.status || 'active'} to ${status}.`, actorUserId: ctx.user.id, createdAt: now });
    addAudit(d, ctx, 'admin.tenant.status', 'tenant', tenant.id, { status });
  });
  core.sendJson(res, 200, { tenant: publicTenant({ ...tenant, status }) });
}

async function apiAdminUserStatus(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  const status = String(b.status || '');
  if (!['active', 'suspended', 'deleted'].includes(status)) return core.sendJson(res, 422, { error: 'invalid status', code: 'bad_status' });
  const userId = String(b.userId || '');

  if (db.isPostgres) {
    const uRes = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (uRes.rowCount === 0) return core.sendJson(res, 404, { error: 'user not found', code: 'not_found' });
    const user = uRes.rows[0];
    if (user.id === ctx.user.id) return core.sendJson(res, 409, { error: 'cannot change your own status', code: 'self_target' });

    await db.transaction(async (client) => {
      if (status === 'deleted') {
        await client.query(
          'UPDATE users SET status = $1, email = $2, name = $3, pass_hash = $4 WHERE id = $5',
          [status, `deleted-${user.id}@invalid.local`, 'Deleted user', '', user.id]
        );
      } else {
        await client.query('UPDATE users SET status = $1 WHERE id = $2', [status, user.id]);
      }
      await client.query('DELETE FROM sessions WHERE user_id = $1', [user.id]);
      await db.addAuditSql(client, ctx, 'admin.user.status', 'user', user.id, { status });
    });

    return core.sendJson(res, 200, { ok: true });
  }

  const user = core.db().users.find((u) => u.id === userId);
  if (!user) return core.sendJson(res, 404, { error: 'user not found', code: 'not_found' });
  if (user.id === ctx.user.id) return core.sendJson(res, 409, { error: 'cannot change your own status', code: 'self_target' });
  await core.mutate((d) => { const u = d.users.find((x) => x.id === user.id); u.status = status; if (status === 'deleted') { u.email = `deleted-${u.id}@invalid.local`; u.name = 'Deleted user'; u.passHash = ''; } d.sessions = d.sessions.filter((s) => s.userId !== user.id); addAudit(d, ctx, 'admin.user.status', 'user', user.id, { status }); });
  core.sendJson(res, 200, { ok: true });
}

async function apiAdminUserRole(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  const role = String(b.role || '');
  if (!['super_admin', 'admin', 'owner', 'member'].includes(role)) return core.sendJson(res, 422, { error: 'invalid role', code: 'bad_role' });
  const userId = String(b.userId || '');

  if (db.isPostgres) {
    const uRes = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (uRes.rowCount === 0) return core.sendJson(res, 404, { error: 'user not found', code: 'not_found' });
    const user = uRes.rows[0];
    if (user.id === ctx.user.id && role !== 'super_admin') return core.sendJson(res, 409, { error: 'cannot remove your own super admin role', code: 'self_target' });

    await db.transaction(async (client) => {
      await client.query('UPDATE users SET role = $1 WHERE id = $2', [role, user.id]);
      await db.addAuditSql(client, ctx, 'admin.user.role', 'user', user.id, { role });
    });

    return core.sendJson(res, 200, { user: publicUser({ ...user, role }) });
  }

  const user = core.db().users.find((u) => u.id === userId);
  if (!user) return core.sendJson(res, 404, { error: 'user not found', code: 'not_found' });
  if (user.id === ctx.user.id && role !== 'super_admin') return core.sendJson(res, 409, { error: 'cannot remove your own super admin role', code: 'self_target' });
  await core.mutate((d) => { d.users.find((u) => u.id === user.id).role = role; addAudit(d, ctx, 'admin.user.role', 'user', user.id, { role }); });
  core.sendJson(res, 200, { user: publicUser({ ...user, role }) });
}

async function apiAdminWalletAdjust(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  const amountPaise = Number(b.amountPaise);
  const tenantId = String(b.tenantId || '');
  const idempotencyKey = String(b.idempotencyKey || '').trim().slice(0, 120);

  if (db.isPostgres) {
    const tRes = await db.query('SELECT 1 FROM tenants WHERE id = $1', [tenantId]);
    if (tRes.rowCount === 0 || !Number.isInteger(amountPaise) || amountPaise === 0 || Math.abs(amountPaise) > 100000000) return core.sendJson(res, 422, { error: 'valid tenantId and amountPaise required', code: 'bad_adjustment' });
    if (!idempotencyKey) return core.sendJson(res, 422, { error: 'idempotencyKey required', code: 'idempotency_required' });
    let entry;
    try {
      await db.transaction(async (client) => {
        entry = await db.addLedgerEntrySql(client, tenantId, amountPaise, 'admin_adjustment', `admin:${idempotencyKey}`, ctx.user.id, { reason: String(b.reason || '').slice(0, 200) });
        if (entry) {
          await db.addAuditSql(client, ctx, 'admin.wallet.adjusted', 'tenant', tenantId, { amountPaise, ledgerId: entry.id });
        }
      });
    } catch (e) {
      return core.sendJson(res, 409, { error: e.message, code: 'wallet_rejected' });
    }
    if (!entry) return core.sendJson(res, 200, { duplicate: true });
    return core.sendJson(res, 201, { ledgerEntry: entry });
  }

  if (!core.db().tenants.some((t) => t.id === tenantId) || !Number.isInteger(amountPaise) || amountPaise === 0 || Math.abs(amountPaise) > 100000000) return core.sendJson(res, 422, { error: 'valid tenantId and amountPaise required', code: 'bad_adjustment' });
  if (!idempotencyKey) return core.sendJson(res, 422, { error: 'idempotencyKey required', code: 'idempotency_required' });
  let entry;
  try { await core.mutate((d) => { entry = addLedgerEntry(d, tenantId, amountPaise, 'admin_adjustment', `admin:${idempotencyKey}`, ctx.user.id, { reason: String(b.reason || '').slice(0, 200) }); if (entry) addAudit(d, ctx, 'admin.wallet.adjusted', 'tenant', tenantId, { amountPaise, ledgerId: entry.id }); }); }
  catch (e) { return core.sendJson(res, 409, { error: e.message, code: 'wallet_rejected' }); }
  if (!entry) return core.sendJson(res, 200, { duplicate: true });
  core.sendJson(res, 201, { ledgerEntry: entry });
}

async function apiAdminTicketReply(req, res, ctx) {
  const b = ctx.body || {};
  const ticketId = String(b.ticketId || '');
  const text = String(b.message || '').trim().slice(0, 5000);

  if (db.isPostgres) {
    const tRes = await db.query('SELECT * FROM support_tickets WHERE id = $1', [ticketId]);
    if (tRes.rowCount === 0 || !text) return core.sendJson(res, 422, { error: 'valid ticketId and message required', code: 'bad_reply' });
    const ticket = tRes.rows[0];
    const now = new Date().toISOString();
    const newStatus = b.status === 'closed' ? 'closed' : 'waiting_on_customer';
    const msg = { id: core.genId('msg_'), ticketId: ticket.id, tenantId: ticket.tenantId, authorUserId: ctx.user.id, body: text, internal: !!b.internal, createdAt: now };

    await db.transaction(async (client) => {
      await client.query('UPDATE support_tickets SET status = $1, updated_at = $2 WHERE id = $3', [newStatus, now, ticket.id]);
      await client.query(
        'INSERT INTO support_messages (id, ticket_id, user_id, body, created_at) VALUES ($1, $2, $3, $4, $5)',
        [msg.id, ticket.id, ctx.user.id, text, now]
      );
      await db.addAuditSql(client, ctx, 'admin.ticket.replied', 'ticket', ticket.id, { status: newStatus });
    });

    return core.sendJson(res, 201, { message: msg });
  }

  const ticket = core.db().supportTickets.find((t) => t.id === ticketId);
  if (!ticket || !text) return core.sendJson(res, 422, { error: 'valid ticketId and message required', code: 'bad_reply' });
  const msg = { id: core.genId('msg_'), ticketId: ticket.id, tenantId: ticket.tenantId, authorUserId: ctx.user.id, body: text, internal: !!b.internal, createdAt: new Date().toISOString() };
  await core.mutate((d) => { d.supportMessages.push(msg); const t = d.supportTickets.find((x) => x.id === ticket.id); t.status = b.status === 'closed' ? 'closed' : 'waiting_on_customer'; t.updatedAt = msg.createdAt; addAudit(d, ctx, 'admin.ticket.replied', 'ticket', ticket.id, { status: t.status }); });
  core.sendJson(res, 201, { message: msg });
}

async function apiAdminTicketUpdate(req, res, ctx) {
  const b = ctx.body || {}; const ticketId = String(b.ticketId || '');

  if (db.isPostgres) {
    const tRes = await db.query('SELECT * FROM support_tickets WHERE id = $1', [ticketId]);
    if (tRes.rowCount === 0) return core.sendJson(res, 404, { error: 'ticket not found', code: 'not_found' });
    const ticket = tRes.rows[0];
    const status = ['open', 'in_progress', 'waiting_on_customer', 'resolved', 'closed'].includes(String(b.status || '')) ? String(b.status) : ticket.status;
    const priority = ['low', 'normal', 'high', 'urgent'].includes(String(b.priority || '')) ? String(b.priority) : ticket.priority;
    const assignedTo = b.assignedTo ? String(b.assignedTo) : ticket.assignedTo || ctx.user.id;
    const now = new Date().toISOString();

    await db.transaction(async (client) => {
      await client.query(
        'UPDATE support_tickets SET status = $1, priority = $2, assigned_to = $3, updated_at = $4 WHERE id = $5',
        [status, priority, assignedTo, now, ticket.id]
      );
      await db.addAuditSql(client, ctx, 'admin.ticket.updated', 'ticket', ticket.id, { status, priority, assignedTo });
    });

    return core.sendJson(res, 200, { ok: true });
  }

  const ticket = core.db().supportTickets.find((t) => t.id === ticketId);
  if (!ticket) return core.sendJson(res, 404, { error: 'ticket not found', code: 'not_found' });
  const status = ['open', 'in_progress', 'waiting_on_customer', 'resolved', 'closed'].includes(String(b.status || '')) ? String(b.status) : ticket.status;
  const priority = ['low', 'normal', 'high', 'urgent'].includes(String(b.priority || '')) ? String(b.priority) : ticket.priority;
  await core.mutate((d) => { const t = d.supportTickets.find((x) => x.id === ticket.id); t.status = status; t.priority = priority; t.assignedTo = b.assignedTo ? String(b.assignedTo) : t.assignedTo || ctx.user.id; t.updatedAt = new Date().toISOString(); addAudit(d, ctx, 'admin.ticket.updated', 'ticket', ticket.id, { status, priority, assignedTo: t.assignedTo }); });
  core.sendJson(res, 200, { ok: true });
}

// GET /api/providers -> the registry so Settings can render active vs available.
function apiProviders(req, res) {
  core.sendJson(res, 200, providers.describeProviders());
}

/* ==========================================================================
   Phase 7: Razorpay Payment Webhook
   ========================================================================== */

async function apiWebhookRazorpay(req, res, body) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET || '';
  if (!secret) return core.sendJson(res, 503, { error: 'Razorpay webhook not configured', code: 'not_configured' });

  const sig = req.headers['x-razorpay-signature'] || '';
  const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
  const expectedSig = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  if (!sig || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
    return core.sendJson(res, 401, { error: 'invalid signature', code: 'bad_signature' });
  }

  const event = typeof body === 'string' ? JSON.parse(body) : body;
  if (event.event !== 'payment.captured') {
    return core.sendJson(res, 200, { ok: true, skipped: true });
  }

  const payment = event.payload?.payment?.entity;
  if (!payment) return core.sendJson(res, 400, { error: 'missing payment entity', code: 'bad_payload' });

  const amountPaise = parseInt(payment.amount, 10);
  const tenantId = payment.notes?.tenant_id || payment.description?.match(/tenant:(\S+)/)?.[1] || null;
  const txnid = String(payment.id || '');

  if (!tenantId || !amountPaise) {
    return core.sendJson(res, 400, { error: 'tenant_id or amount missing in payment.notes', code: 'bad_payload' });
  }

  if (db.isPostgres) {
    // Idempotency check
    const dup = await db.query('SELECT id FROM payment_events WHERE txnid=$1 AND provider=$2', [txnid, 'razorpay']);
    if (dup.rowCount > 0) return core.sendJson(res, 200, { ok: true, duplicate: true });

    const now = new Date().toISOString();
    const eventId = core.genId('pev_');
    const intentId = core.genId('pi_');
    const invoiceId = core.genId('inv_');

    await db.withTransaction(async (client) => {
      // Credit ledger
      await db.addLedgerEntrySql(client, tenantId, amountPaise, 'razorpay_payment', txnid, { payment_id: txnid });
      // Record event
      await client.query(
        `INSERT INTO payment_events (id, provider, tenant_id, payment_intent_id, txnid, status, payload, created_at)
         VALUES ($1, 'razorpay', $2, $3, $4, 'captured', $5, $6)`,
        [eventId, tenantId, intentId, txnid, JSON.stringify(payment), now]
      );
      // Auto-create invoice
      const invNum = `RZP-${txnid.slice(-6).toUpperCase()}`;
      await client.query(
        `INSERT INTO invoices (id, tenant_id, invoice_number, amount_paise, currency, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'INR', 'paid', $5, $5)
         ON CONFLICT DO NOTHING`,
        [invoiceId, tenantId, invNum, amountPaise, now]
      );
    });
    // Dispatch outbound webhooks
    await dispatchTenantWebhooks(tenantId, 'payment.captured', { txnid, amountPaise, provider: 'razorpay' });
    return core.sendJson(res, 200, { ok: true });
  }

  // JSON driver fallback
  return core.sendJson(res, 200, { ok: true, note: 'wallet credit requires postgres driver' });
}

/* ==========================================================================
   Phase 7: WhatsApp Business Cloud API
   ========================================================================== */

function apiWhatsappWebhookVerify(req, res) {
  const challenge = whatsapp.verifyChallenge(req);
  if (!challenge) return core.sendJson(res, 403, { error: 'invalid verify token', code: 'bad_token' });
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(challenge);
}

function apiWhatsappWebhookInbound(req, res, body) {
  // Delivery receipts — acknowledge and no-op for now
  core.sendJson(res, 200, { ok: true });
}

async function apiWhatsappNotify(req, res, ctx) {
  const b = ctx.body || {};
  const { to, templateName, languageCode, components } = b;
  if (!to || !templateName) return core.sendJson(res, 422, { error: 'to and templateName are required', code: 'missing_fields' });
  const result = await whatsapp.sendTemplateMessage(to, templateName, languageCode || 'en_US', components || []);
  core.sendJson(res, 200, { ok: true, result });
}

/* ==========================================================================
   Phase 7: BullMQ Outbound Call Queue (with offline fallback)
   ========================================================================== */

function initOutboundQueue() {
  queue.init({ providers, db });
}

async function apiOutboundSchedule(req, res, ctx) {
  const b = ctx.body || {};
  const phoneNumber = String(b.phoneNumber || b.phone_number || '').trim();
  const agentId = String(b.agentId || b.agent_id || '').trim();
  if (!phoneNumber || !agentId) return core.sendJson(res, 422, { error: 'phoneNumber and agentId are required', code: 'missing_fields' });
  const scheduledAt = b.scheduledAt ? new Date(b.scheduledAt) : new Date();
  const delay = Math.max(0, scheduledAt.getTime() - Date.now());
  const now = new Date().toISOString();
  const jobId = core.genId('ojob_');

  if (db.isPostgres) {
    await db.query(
      `INSERT INTO outbound_jobs (id, tenant_id, agent_id, phone_number, scheduled_at, status, created_at) VALUES ($1,$2,$3,$4,$5,'queued',$6)`,
      [jobId, ctx.tenant.id, agentId, phoneNumber, scheduledAt.toISOString(), now]
    );
  }

  if (!queue.isReady) {
    return core.sendJson(res, 202, { queued: false, reason: 'redis_not_configured', jobId, note: 'REDIS_URL not set, job recorded but not scheduled' });
  }

  const qRes = await queue.scheduleCall({ agentId, tenantId: ctx.tenant.id, phoneNumber, jobDbId: jobId, delay });
  return core.sendJson(res, 202, { queued: qRes.queued, jobId, scheduledAt: scheduledAt.toISOString() });
}

async function apiOutboundQueue(req, res, ctx) {
  if (db.isPostgres) {
    const { rows } = await db.query(
      'SELECT * FROM outbound_jobs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100',
      [ctx.tenant.id]
    );
    return core.sendJson(res, 200, { jobs: rows });
  }
  return core.sendJson(res, 200, { jobs: [], note: 'requires postgres driver' });
}

/* ==========================================================================
   Phase 7: Zapier / n8n Outbound Webhook System
   ========================================================================== */

async function dispatchTenantWebhooks(tenantId, event, data) {
  if (!db.isPostgres) return;
  try {
    const { rows } = await db.query(
      `SELECT * FROM webhook_endpoints WHERE tenant_id=$1 AND status='active' AND (events='{}' OR $2=ANY(events))`,
      [tenantId, event]
    );
    for (const ep of rows) {
      const payload = JSON.stringify({ event, data, tenantId, timestamp: new Date().toISOString() });
      const sig = crypto.createHmac('sha256', ep.secret).update(payload).digest('hex');
      // Fire-and-forget with failure tracking
      (async () => {
        try {
          const url = new URL(ep.url);
          await new Promise((resolve, reject) => {
            const opts = {
              hostname: url.hostname,
              port: url.port || (url.protocol === 'https:' ? 443 : 80),
              path: url.pathname + url.search,
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-GetQualify-Signature': sig, 'Content-Length': Buffer.byteLength(payload) },
            };
            const mod = url.protocol === 'https:' ? require('https') : require('http');
            const req = mod.request(opts, (resp) => { resp.resume(); resolve(resp.statusCode); });
            req.on('error', reject);
            req.setTimeout(5000, () => req.destroy());
            req.write(payload);
            req.end();
          });
          // Reset failure count on success
          await db.query('UPDATE webhook_endpoints SET failure_count=0 WHERE id=$1', [ep.id]);
        } catch (_) {
          // Increment failure count; disable after 10 consecutive failures
          await db.query(
            `UPDATE webhook_endpoints SET failure_count=failure_count+1, status=CASE WHEN failure_count+1>=10 THEN 'failing' ELSE status END WHERE id=$1`,
            [ep.id]
          );
        }
      })().catch(() => {});
    }
  } catch (_) {}
}

async function apiWebhookEndpointsList(req, res, ctx) {
  if (db.isPostgres) {
    const { rows } = await db.query('SELECT id,url,events,status,failure_count,created_at FROM webhook_endpoints WHERE tenant_id=$1 ORDER BY created_at DESC', [ctx.tenant.id]);
    return core.sendJson(res, 200, { endpoints: rows });
  }
  core.sendJson(res, 200, { endpoints: [] });
}

async function apiWebhookEndpointsCreate(req, res, ctx) {
  const b = ctx.body || {};
  const url = String(b.url || '').trim();
  if (!url || !/^https?:\/\//.test(url)) return core.sendJson(res, 422, { error: 'valid url is required', code: 'missing_url' });
  const events = Array.isArray(b.events) ? b.events.map(String).filter(Boolean) : [];
  const secret = crypto.randomBytes(32).toString('hex');
  const now = new Date().toISOString();
  const id = core.genId('wep_');

  if (db.isPostgres) {
    const { rows } = await db.query(
      `INSERT INTO webhook_endpoints (id, tenant_id, url, events, secret, status, created_at) VALUES ($1,$2,$3,$4,$5,'active',$6) RETURNING id,url,events,status,failure_count,created_at`,
      [id, ctx.tenant.id, url, events, secret, now]
    );
    return core.sendJson(res, 201, { endpoint: rows[0], secret });
  }
  core.sendJson(res, 201, { endpoint: { id, url, events, status: 'active' }, secret, note: 'requires postgres driver to persist' });
}

async function apiWebhookEndpointsDelete(req, res, ctx, id) {
  if (db.isPostgres) {
    const { rowCount } = await db.query('DELETE FROM webhook_endpoints WHERE id=$1 AND tenant_id=$2', [id, ctx.tenant.id]);
    if (rowCount === 0) return core.sendJson(res, 404, { error: 'endpoint not found', code: 'not_found' });
    return core.sendJson(res, 200, { ok: true });
  }
  core.sendJson(res, 200, { ok: true });
}

/* ==========================================================================
   Phase 7: Twilio SMS international fallback (injected into lib/sms.js style)
   ========================================================================== */
// The actual extension lives in lib/sms.js. This stub is here for completeness.

// GET /api/health -> readiness + which provider keys are present + db status.
async function apiHealth(req, res) {
  let isDeep = false;
  try {
    const urlObj = new URL(req.url || '/', 'http://localhost');
    isDeep = urlObj.searchParams.get('deep') === 'true';
  } catch (_) {}
  const dbStatus = await db.health(isDeep);

  const described = providers.describeProviders();
  const providerHealth = (layer) => Object.fromEntries((described[layer] || []).map((item) => [item.id, item.live]));
  const selected = (layer) => (described[layer] || []).find((item) => item.selected) || (described[layer] || [])[0] || {};
  const selectedStt = selected('stt'); const selectedTts = selected('tts'); const selectedLlm = selected('llm'); const selectedTelephony = selected('telephony');

  const isOk = dbStatus.ok !== false;
  core.sendJson(res, isOk ? 200 : 503, {
    ok: isOk,
    database: dbStatus,
    providers: {
      stt: providerHealth('stt'),
      tts: providerHealth('tts'),
      llm: providerHealth('llm'),
      telephony: providerHealth('telephony'),
    },
    models: { stt: selectedStt.model, llm: selectedLlm.model, tts: selectedTts.model },
    selected: {
      stt: { provider: selectedStt.id, model: selectedStt.model },
      tts: { provider: selectedTts.id, model: selectedTts.model },
      llm: { provider: selectedLlm.id, model: selectedLlm.model },
      telephony: { provider: selectedTelephony.id },
    },
  });
}

/* ==========================================================================
   Map a ProviderError (or anything) to a clean JSON HTTP response.
   ========================================================================== */
function handleProviderError(res, e) {
  if (e instanceof providers.ProviderError) {
    return core.sendJson(res, e.status || 502, {
      error: e.message,
      code: e.code || 'provider_error',
      detail: e.detail,
    });
  }
  core.sendJson(res, 502, { error: String((e && e.message) || e), code: 'upstream' });
}

/* ==========================================================================
   Router
   ========================================================================== */

const server = http.createServer(async (req, res) => {
  const requestId = req.headers['x-request-id'] || crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  if (Sentry && typeof Sentry.setTag === 'function') {
    Sentry.setTag('requestId', requestId);
  }

  const ip = requestRateKey(req);
  const route = (req.url || '/').split('?')[0];

  try {
    if (route.startsWith('/api/')) {
      if (!core.rateOk(ip)) return core.sendJson(res, 429, { error: 'rate limited', code: 'rate' });

      const payuInbound = route === '/api/payu/callback' || route === '/api/payu/webhook' || route === '/api/payu/return';
      const dograhWebhook = route === '/api/webhooks/dograh/call-completed';
      const razorpayWebhook = route === '/api/webhooks/razorpay';
      const whatsappWebhook = route === '/api/webhooks/whatsapp';
      const webhookInbound = payuInbound || dograhWebhook || razorpayWebhook || whatsappWebhook;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method || '') && !webhookInbound && !requestOriginAllowed(req)) {
        return core.sendJson(res, 403, { error: 'cross-origin request blocked', code: 'bad_origin' });
      }
      const requestContentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method || '') && !payuInbound && requestContentType && requestContentType !== 'application/json') {
        return core.sendJson(res, 415, { error: 'application/json required', code: 'bad_content_type' });
      }

      // CSRF validation for mutating endpoints (Double-Submit Cookie)
      const isMutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method || '');
      const isPublicAuth = route === '/api/auth/login' || route === '/api/auth/signup' || route === '/api/verify-otp' || route === '/api/auth/verify-otp' || route === '/api/resend-otp' || route === '/api/auth/resend-otp';
      const isPublicDemo = route.startsWith('/api/public/demo/');
      const isCsrfExempt = webhookInbound || isPublicAuth || isPublicDemo;

      if (isMutating && !isCsrfExempt) {
        if (!core.verifyCsrf(req)) {
          return core.sendJson(res, 403, { error: 'invalid or missing CSRF token', code: 'bad_csrf' });
        }
      }

      if ((route === '/api/payu/callback' || route === '/api/payu/webhook' || route === '/api/payu/return') && req.method === 'POST') {
        let form;
        try { form = await readForm(req); }
        catch (e) { return core.sendJson(res, 400, { error: e.message, code: 'bad_form' }); }
        return (route.endsWith('/callback') || route.endsWith('/webhook')) ? apiPayuCallback(req, res, form) : apiPayuReturn(req, res, form);
      }

      // ---- Public GET routes ----
      if (route === '/api/health' && req.method === 'GET') return apiHealth(req, res);
      if (route === '/api/providers' && req.method === 'GET') return apiProviders(req, res);
      if (route.startsWith('/api/public/demo/') && req.method === 'GET') {
        const token = decodeURIComponent(route.slice('/api/public/demo/'.length));
        if (token.includes('/')) return core.sendJson(res, 404, { error: 'demo link not found', code: 'not_found' });
        return apiPublicDemoMeta(req, res, token);
      }
      if (route === '/api/integrations/calendar/callback' && req.method === 'GET') return apiCalendarCallback(req, res);

      // ---- Authed GET routes ----
      if (req.method === 'GET') {
        if (route === '/api/leads') return core.requireAuth(req, res, apiLeadsList);
        if (route === '/api/leads/bulk') return core.sendJson(res, 405, { error: 'use POST /api/leads/bulk', code: 'method' });
        if (route.startsWith('/api/leads/')) {
          const leadSub = decodeURIComponent(route.slice('/api/leads/'.length));
          // /api/leads/:id/activities
          if (leadSub.endsWith('/activities') && !leadSub.slice(0, -'/activities'.length).includes('/')) {
            const leadId = leadSub.slice(0, -'/activities'.length);
            return core.requireAuth(req, res, (rq, rs, ctx) => apiLeadActivitiesList(rq, rs, ctx, leadId));
          }
          if (!leadSub || leadSub.includes('/')) return core.sendJson(res, 404, { error: 'lead not found', code: 'not_found' });
          return core.requireAuth(req, res, (rq, rs, ctx) => apiLeadsGet(rq, rs, ctx, leadSub));
        }
        // Phase 7: CRM routes
        if (route === '/api/crm/pipeline') return core.requireAuth(req, res, apiCrmPipeline);
        if (route === '/api/crm/analytics') return core.requireAuth(req, res, apiCrmAnalytics);
        // Phase 7: Outbound telephony queue
        if (route === '/api/telephony/outbound/queue') return core.requireRole(req, res, 'owner', apiOutboundQueue);
        // Phase 7: Webhook endpoints management
        if (route === '/api/webhooks/endpoints') return core.requireRole(req, res, 'owner', apiWebhookEndpointsList);
        // Phase 7: WhatsApp webhook verification
        if (route === '/api/webhooks/whatsapp') return apiWhatsappWebhookVerify(req, res);
        if (route === '/api/me') return core.requireAuth(req, res, apiMe);
        if (route === '/api/agents') return core.requireAuth(req, res, apiAgentsList);
        if (route === '/api/usage') return core.requireAuth(req, res, apiUsage);
        if (route === '/api/telephony/status') return core.requireAuth(req, res, apiTelephonyStatus);
        if (route === '/api/presets') return core.requireAuth(req, res, apiPresets);
        if (route === '/api/wallet') return core.requireAuth(req, res, apiWallet);
        if (route === '/api/payment-intents') return core.requireAuth(req, res, apiPaymentIntents);
        if (route === '/api/support/tickets') return core.requireAuth(req, res, apiSupportList);
        if (route === '/api/byon') return core.requireAuth(req, res, apiByonList);
        if (route === '/api/privacy') return core.requireAuth(req, res, apiPrivacyGet);
        if (route === '/api/members') return core.requireRole(req, res, 'owner', apiMembers);
        if (route === '/api/audit') return core.requireRole(req, res, 'owner', apiAudit);
        if (route === '/api/agency/overview') return core.requireRole(req, res, 'owner', apiAgencyOverview);
        if (route === '/api/agency/prompt') return core.requireRole(req, res, 'owner', apiAgencyPromptGet);
        if (route === '/api/invoices') return core.requireRole(req, res, 'owner', apiInvoices);
        if (route === '/api/integrations') return core.requireRole(req, res, 'owner', apiIntegrations);
        if (route === '/api/demo-links') return core.requireRole(req, res, 'owner', apiDemoLinksList);
        if (route === '/api/admin/overview') return core.requireRole(req, res, 'super_admin', apiAdminOverview);
        if (route === '/api/admin/tenants') return core.requireRole(req, res, 'super_admin', apiAdminTenants);
        if (route === '/api/admin/users') return core.requireRole(req, res, 'super_admin', apiAdminUsers);
        if (route === '/api/admin/audit') return core.requireRole(req, res, 'admin', apiAdminAudit);
        if (route === '/api/admin/tickets') return core.requireRole(req, res, 'admin', apiAdminTickets);
        if (route === '/api/admin/tenant-detail') return core.requireRole(req, res, 'super_admin', apiAdminTenantDetail);
        if (route === '/api/admin/payment-events') return core.requireRole(req, res, 'admin', apiAdminPaymentEvents);
        if (route.startsWith('/api/admin/tenants/') && route.endsWith('/settings')) {
          const tenantId = decodeURIComponent(route.slice('/api/admin/tenants/'.length, -'/settings'.length));
          if (!tenantId || tenantId.includes('/')) return core.sendJson(res, 404, { error: 'tenant not found', code: 'not_found' });
          return core.requireRole(req, res, 'super_admin', (rq, rs, ctx) => apiAdminTenantSettingsGet(rq, rs, ctx, tenantId));
        }
        if (route === '/api/hvac/desk') return core.requireAuth(req, res, apiHvacDesk);
        if (route === '/api/hvac/event-types') return core.requireAuth(req, res, apiHvacEventTypes);
        if (route === '/api/hvac/slots') return core.requireAuth(req, res, apiHvacSlots);
        if (route === '/api/integrations/calendar/auth-url') return core.requireRole(req, res, 'owner', apiCalendarAuthUrl);
        if (route === '/api/integrations/calendar/status') return core.requireAuth(req, res, apiCalendarStatus);
        if (route === '/api/integrations/calendar/availability') return core.requireAuth(req, res, apiCalendarAvailability);
        if (route.startsWith('/api/calls/') && route.endsWith('/recording')) {
          const callId = decodeURIComponent(route.slice('/api/calls/'.length, -'/recording'.length));
          if (!callId || callId.includes('/')) return core.sendJson(res, 404, { error: 'call not found', code: 'not_found' });
          return core.requireAuth(req, res, (rq, rs, ctx) => apiCallRecordingGet(rq, rs, ctx, callId));
        }
        return core.sendJson(res, 404, { error: 'no such endpoint', code: 'not_found' });
      }

      if (req.method === 'PATCH') {
        let body;
        try {
          body = await core.readBody(req, 64 * 1024);
        } catch (e) {
          const tooBig = /too large/.test(String(e.message));
          return core.sendJson(res, tooBig ? 413 : 400, {
            error: e.message, code: tooBig ? 'too_large' : 'bad_body',
          });
        }
        if (route.startsWith('/api/leads/')) {
          const leadSub = decodeURIComponent(route.slice('/api/leads/'.length));
          if (leadSub.endsWith('/activities') && !leadSub.slice(0, -'/activities'.length).includes('/')) {
            const leadId = leadSub.slice(0, -'/activities'.length);
            return core.requireAuth(req, res, (rq, rs, ctx) => apiLeadActivitiesCreate(rq, rs, ctx, leadId), body);
          }
          if (!leadSub || leadSub.includes('/')) return core.sendJson(res, 404, { error: 'lead not found', code: 'not_found' });
          return core.requireAuth(req, res, (rq, rs, ctx) => apiLeadsPatch(rq, rs, ctx, leadSub), body);
        }
        if (route.startsWith('/api/admin/tenants/') && route.endsWith('/settings')) {
          const tenantId = decodeURIComponent(route.slice('/api/admin/tenants/'.length, -'/settings'.length));
          if (!tenantId || tenantId.includes('/')) return core.sendJson(res, 404, { error: 'tenant not found', code: 'not_found' });
          return core.requireRole(req, res, 'super_admin', (rq, rs, ctx) => apiAdminTenantSettingsPatch(rq, rs, ctx, tenantId), body);
        }
        return core.sendJson(res, 404, { error: 'no such endpoint', code: 'not_found' });
      }

      if (req.method === 'DELETE') {
        if (route.startsWith('/api/leads/')) {
          const leadId = decodeURIComponent(route.slice('/api/leads/'.length));
          if (!leadId || leadId.includes('/')) return core.sendJson(res, 404, { error: 'lead not found', code: 'not_found' });
          return core.requireAuth(req, res, (rq, rs, ctx) => apiLeadsDelete(rq, rs, ctx, leadId));
        }
        // Phase 7: webhook endpoint management DELETE
        if (route.startsWith('/api/webhooks/endpoints/')) {
          const epId = decodeURIComponent(route.slice('/api/webhooks/endpoints/'.length));
          if (!epId || epId.includes('/')) return core.sendJson(res, 404, { error: 'endpoint not found', code: 'not_found' });
          return core.requireRole(req, res, 'owner', (rq, rs, ctx) => apiWebhookEndpointsDelete(rq, rs, ctx, epId));
        }
        if (route === '/api/integrations/calendar/disconnect') {
          return core.requireRole(req, res, 'owner', apiCalendarDisconnect);
        }
        return core.sendJson(res, 404, { error: 'no such endpoint', code: 'not_found' });
      }

      if (req.method !== 'POST') {
        return core.sendJson(res, 405, { error: 'method not allowed', code: 'method' });
      }

      // ---- POST routes: read the body once, with a bigger cap for STT audio ----
      let body;
      try {
        body = await core.readBody(req, route === '/api/stt' ? 12 * 1024 * 1024 : 64 * 1024);
      } catch (e) {
        const tooBig = /too large/.test(String(e.message));
        return core.sendJson(res, tooBig ? 413 : 400, {
          error: e.message, code: tooBig ? 'too_large' : 'bad_body',
        });
      }

      // Public POST (auth) routes.
      if (route === '/api/auth/signup') return apiSignup(req, res, body);
      if (route === '/api/auth/login') return apiLogin(req, res, body);
      if (route === '/api/verify-otp' || route === '/api/auth/verify-otp') return apiVerifyOtp(req, res, body);
      if (route === '/api/resend-otp' || route === '/api/auth/resend-otp') return apiResendOtp(req, res, body);
      if (route === '/api/auth/logout') return apiLogout(req, res);
      if (route === '/api/auth/impersonation/exit') return core.requireAuth(req, res, apiImpersonationExit, body);
      if (route === '/api/webhooks/dograh/call-completed') return apiWebhookDograhCallCompleted(req, res, body);
      if (route.startsWith('/api/public/demo/') && route.endsWith('/session')) {
        const token = decodeURIComponent(route.slice('/api/public/demo/'.length, -'/session'.length));
        if (token.includes('/') || !core.rateOk(`demo-start:${ip}`, 5, 5)) return core.sendJson(res, token.includes('/') ? 404 : 429, { error: token.includes('/') ? 'demo link not found' : 'too many demo starts, try again shortly', code: token.includes('/') ? 'not_found' : 'demo_rate' });
        return apiPublicDemoSession(req, res, token);
      }

      // Authed POST routes (tenant scoped through requireAuth).
      if (route === '/api/agents') return core.requireAuth(req, res, apiAgentsCreate, body);
      if (route === '/api/agents/update') return core.requireAuth(req, res, apiAgentsUpdate, body);
      if (route === '/api/agents/delete') return core.requireAuth(req, res, apiAgentsDelete, body);
      if (route === '/api/tts') return core.requireAuth(req, res, apiTts, body);
      if (route === '/api/ws-connect') return core.requireAuth(req, res, apiWsConnect, body);
      if (route === '/api/chat') return core.requireAuth(req, res, apiChat, body);
      if (route === '/api/stt') return core.requireAuth(req, res, apiStt, body);
      if (route === '/api/voice/session') return core.requireAuth(req, res, apiVoiceSession, body);
      if (route === '/api/demo-links') return core.requireRole(req, res, 'owner', apiDemoLinksCreate, body);
      if (route === '/api/demo-links/revoke') return core.requireRole(req, res, 'owner', apiDemoLinksRevoke, body);
      if (route === '/api/telephony/dial') return core.requireAuth(req, res, apiTelephonyDial, body);
      if (route === '/api/payment-intents') return core.requireAuth(req, res, apiPaymentIntentCreate, body);
      if (route === '/api/support/tickets') return core.requireAuth(req, res, apiSupportCreate, body);
      if (route === '/api/support/tickets/reply') return core.requireAuth(req, res, apiSupportReply, body);
      if (route === '/api/byon') return core.requireRole(req, res, 'owner', apiByonSave, body);
      if (route === '/api/privacy') return core.requireRole(req, res, 'owner', apiPrivacyMode, body);
      if (route === '/api/tenant/update') return core.requireRole(req, res, 'owner', apiTenantUpdate, body);
      if (route === '/api/members/role') return core.requireRole(req, res, 'owner', apiMemberRole, body);
      if (route === '/api/invoices') return core.requireRole(req, res, 'admin', apiInvoiceCreate, body);
      if (route === '/api/invoices/status') return core.requireRole(req, res, 'admin', apiInvoiceStatus, body);
      if (route === '/api/integrations/request') return core.requireRole(req, res, 'owner', apiIntegrationRequest, body);
      if (route === '/api/agency/prompt') return core.requireRole(req, res, 'owner', apiAgencyPromptSave, body);
      if (route === '/api/admin/client-approach') return core.requireRole(req, res, 'admin', apiClientApproach, body);
      if (route === '/api/admin/tenants/provision') return core.requireRole(req, res, 'super_admin', apiAdminTenantProvision, body);
      if (route === '/api/admin/tenants') return core.requireRole(req, res, 'super_admin', apiAdminTenantCreate, body);
      if (route === '/api/admin/tenants/status') return core.requireRole(req, res, 'super_admin', apiAdminTenantStatus, body);
      if (route === '/api/admin/users/status') return core.requireRole(req, res, 'super_admin', apiAdminUserStatus, body);
      if (route === '/api/admin/users/role') return core.requireRole(req, res, 'super_admin', apiAdminUserRole, body);
      if (route === '/api/admin/wallet/adjust') return core.requireRole(req, res, 'admin', apiAdminWalletAdjust, body);
      if (route === '/api/admin/tickets/reply') return core.requireRole(req, res, 'admin', apiAdminTicketReply, body);
      if (route === '/api/admin/tickets/update') return core.requireRole(req, res, 'admin', apiAdminTicketUpdate, body);
      if (route === '/api/admin/impersonations') return core.requireRole(req, res, 'super_admin', apiAdminImpersonate, body);
      if (route === '/api/hvac/jobs') return core.requireAuth(req, res, apiHvacJobSave, body);
      if (route === '/api/hvac/book') return core.requireAuth(req, res, apiHvacBook, body);
      if (route === '/api/leads') return core.requireAuth(req, res, apiLeadsCreate, body);
      if (route === '/api/leads/bulk') return core.requireRole(req, res, 'owner', apiLeadsBulkUpdate, body);
      // Phase 7: Lead activity timeline
      // (handled in PATCH block above for /api/leads/:id/activities)
      // Phase 7: Razorpay webhook (public, HMAC-verified)
      if (route === '/api/webhooks/razorpay') return apiWebhookRazorpay(req, res, body);
      // Phase 7: WhatsApp webhook receipts
      if (route === '/api/webhooks/whatsapp') return apiWhatsappWebhookInbound(req, res, body);
      // Phase 7: Manual WhatsApp template dispatch
      if (route === '/api/notifications/whatsapp') return core.requireRole(req, res, 'owner', apiWhatsappNotify, body);
      // Phase 7: Outbound call schedule
      if (route === '/api/telephony/outbound/schedule') return core.requireRole(req, res, 'owner', apiOutboundSchedule, body);
      // Phase 7: Webhook endpoint registration
      if (route === '/api/webhooks/endpoints') return core.requireRole(req, res, 'owner', apiWebhookEndpointsCreate, body);
      if (route === '/api/integrations/calendar/book') return core.requireAuth(req, res, apiCalendarBook, body);

      return core.sendJson(res, 404, { error: 'no such endpoint', code: 'not_found' });
    }

    if (req.method === 'GET' && route.startsWith('/demo/')) {
      req.url = '/demo.html';
    }
    if (['GET', 'HEAD'].includes(req.method || '') && route === '/console.html') {
      res.writeHead(302, { Location: '/app.html', 'Cache-Control': 'no-store' });
      return res.end();
    }
    // Everything else is a static file from public/.
    core.serveStatic(req, res);
  } catch (e) {
    if (Sentry && typeof Sentry.captureException === 'function') {
      Sentry.captureException(e, {
        tags: { requestId: req.requestId, route, method: req.method },
        extra: { ip },
      });
    }
    console.error(`[${req.requestId || 'unknown'}] route dispatch crashed`, {
      method: req.method,
      route,
      error: (e && e.stack) || String(e),
    });
    core.sendJson(res, 500, { error: String((e && e.message) || e), code: 'server' });
  }
});

/* ==========================================================================
   Authenticated Deepgram live transcription proxy.

   The browser sends MediaRecorder chunks to this same-origin socket. The
   permanent Deepgram API key remains server side, while Deepgram's interim and
   final Results events are relayed unchanged for word-by-word UI updates.
   ========================================================================== */

const sttWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

function rejectUpgrade(socket, status, label) {
  if (!socket.writable) return socket.destroy();
  socket.write(`HTTP/1.1 ${status} ${label}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

server.on('upgrade', async (req, socket, head) => {
  const route = (req.url || '').split('?')[0];
  if (route !== '/api/stt/stream') return rejectUpgrade(socket, 404, 'Not Found');
  if (!requestOriginAllowed(req)) return rejectUpgrade(socket, 403, 'Forbidden');

  const ip = requestRateKey(req);
  if (!core.rateOk(ip)) return rejectUpgrade(socket, 429, 'Too Many Requests');

  try {
    const ctx = await core.getSession(req);
    if (!ctx) return rejectUpgrade(socket, 401, 'Unauthorized');
    sttWss.handleUpgrade(req, socket, head, (client) => {
      sttWss.emit('connection', client, req, ctx);
    });
  } catch (_) {
    rejectUpgrade(socket, 500, 'Internal Server Error');
  }
});

sttWss.on('connection', (client) => {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) {
    client.send(JSON.stringify({ type: 'ProxyError', message: 'Deepgram is not configured.' }));
    return client.close(1011, 'Deepgram unavailable');
  }

  const query = new URLSearchParams({
    model: providers.stt.model,
    language: 'multi',
    smart_format: 'true',
    punctuate: 'true',
    interim_results: 'true',
    endpointing: '300',
    utterance_end_ms: '1000',
    vad_events: 'true',
  });
  const upstream = new WebSocket(`wss://api.deepgram.com/v1/listen?${query}`, {
    headers: { Authorization: `Token ${key}` },
    maxPayload: 1024 * 1024,
  });
  let upstreamReady = false;
  let closed = false;

  const closeBoth = () => {
    if (closed) return;
    closed = true;
    clearInterval(keepAlive);
    if (client.readyState === WebSocket.OPEN) client.close();
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close();
  };

  const keepAlive = setInterval(() => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify({ type: 'KeepAlive' }));
  }, 4000);

  upstream.on('open', () => {
    upstreamReady = true;
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'ProxyReady', provider: 'deepgram', model: providers.stt.model }));
    }
  });
  upstream.on('message', (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });
  upstream.on('error', () => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'ProxyError', message: 'Deepgram live stream failed.' }));
    }
    closeBoth();
  });
  upstream.on('close', () => closeBoth());

  client.on('message', (data, isBinary) => {
    if (!upstreamReady || upstream.readyState !== WebSocket.OPEN) return;
    if (isBinary) upstream.send(data, { binary: true });
    else upstream.send(data.toString());
  });
  client.on('error', () => closeBoth());
  client.on('close', () => closeBoth());
});

server.on('error', (e) => {
  if (Sentry) Sentry.captureException(e);
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  PORT ${PORT} is already in use. Stop the other process or set PORT to a free port, for example: PORT=8788 node server.js\n`);
    process.exit(1);
  }
  console.error('  server error:', e.message);
  process.exit(1);
});

// Boot then listen.
boot().then(() => {
  // Phase 7: initialise BullMQ outbound queue (no-op if REDIS_URL absent)
  initOutboundQueue();
  server.listen(PORT, () => {
    const live = providers.describeProviders();
    const flag = (layer, id) => (live[layer].find((p) => p.id === id) || {}).live ? 'ok' : 'MISSING';
    console.log('\n  GetQualify  ready');
    console.log(`  Marketing : http://localhost:${PORT}/`);
    console.log(`  Console   : http://localhost:${PORT}/app.html`);
    if (DEMO_EMAIL) console.log(`  Test login: ${DEMO_EMAIL}`);
    console.log(`  Providers : deepgram ${flag('stt', 'deepgram')}  groq ${flag('llm', 'groq')}  rumik ${flag('tts', 'rumik')}  vobiz ${flag('telephony', 'vobiz')}\n`);
  });

  const shutdown = async (sig) => {
    console.log(`\n  Received ${sig}, shutting down gracefully...`);
    try { await queue.close(); } catch (_) {}
    server.close(() => {
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}).catch((e) => {
  if (Sentry) Sentry.captureException(e);
  console.error('  boot failed:', e.message);
  process.exit(1);
});
