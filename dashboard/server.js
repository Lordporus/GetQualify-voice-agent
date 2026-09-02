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
const { WebSocketServer, WebSocket } = require('ws');

const core = require('./lib/core');
core.loadEnv();
const providers = require('./lib/providers');
const payu = require('./lib/payu');
const demoLinks = require('./lib/demo-links');
const db = require('./lib/db');

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
  return { id: u.id, tenantId: u.tenantId, email: u.email, name: u.name, role: u.role, status: u.status, createdAt: u.createdAt };
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
        `INSERT INTO users (id, tenant_id, email, name, pass_hash, role, status, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [userId, tenantId, email, name, passHash, 'owner', 'active', nowIso]
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
  });

  // Session creation stays on core.js path (not migrated in this group).
  const token = await core.createSession(userId, tenantId);
  core.send(res, 200, JSON.stringify({ user: publicUser(user), tenant: publicTenant(tenant) }), {
    'Content-Type': 'application/json',
    'Set-Cookie': core.sessionCookie(token),
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
  core.send(res, 200, JSON.stringify({ user: publicUser(user), tenant: publicTenant(tenant) }), {
    'Content-Type': 'application/json',
    'Set-Cookie': core.sessionCookie(token),
  });
}

async function apiLogout(req, res) {
  await core.destroySession(req);
  core.send(res, 200, JSON.stringify({ ok: true }), {
    'Content-Type': 'application/json',
    'Set-Cookie': core.clearCookie(),
  });
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
  const b = ctx.body || {}; const callerName = String(b.callerName || '').trim().slice(0, 100); const phone = String(b.phone || '').trim().slice(0, 32);
  if (!callerName || !phone) return core.sendJson(res, 422, { error: 'caller name and phone are required', code: 'missing_contact' });
  const outcome = HVAC_OUTCOMES.has(b.outcome) ? b.outcome : 'new'; const now = new Date().toISOString(); let job;

  if (db.isPostgres) {
    const jobId = b.id ? String(b.id) : core.genId('hvac_');
    const existing = b.id ? await db.query('SELECT * FROM hvac_jobs WHERE id = $1 AND tenant_id = $2', [jobId, ctx.tenant.id]) : { rowCount: 0 };
    const email = String(b.email || '').trim().slice(0, 180);
    const service = String(b.service || 'General HVAC').trim().slice(0, 80);
    const urgency = String(b.urgency || 'normal').trim().slice(0, 30);
    const assignedTo = String(b.assignedTo || '').trim().slice(0, 80);
    const notes = String(b.notes || '').trim().slice(0, 2000);

    await db.transaction(async (client) => {
      if (existing.rowCount > 0) {
        const uRes = await client.query(
          `UPDATE hvac_jobs
           SET caller_name = $1, phone = $2, email = $3, service = $4, urgency = $5, outcome = $6, assigned_to = $7, notes = $8, updated_at = $9
           WHERE id = $10 AND tenant_id = $11
           RETURNING *`,
          [callerName, phone, email, service, urgency, outcome, assignedTo, notes, now, jobId, ctx.tenant.id]
        );
        job = uRes.rows[0];
      } else {
        const iRes = await client.query(
          `INSERT INTO hvac_jobs (id, tenant_id, caller_name, phone, email, service, urgency, outcome, assigned_to, notes, appointment, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           RETURNING *`,
          [jobId, ctx.tenant.id, callerName, phone, email, service, urgency, outcome, assignedTo, notes, null, now, now]
        );
        job = iRes.rows[0];
      }
      await db.addAuditSql(client, ctx, 'hvac.job.saved', 'hvac_job', job.id, { outcome: job.outcome });
    });

    return core.sendJson(res, 200, { job: publicHvacJob(job) });
  }

  await core.mutate((d) => {
    job = b.id ? d.hvacJobs.find((item) => item.id === String(b.id) && item.tenantId === ctx.tenant.id) : null;
    if (!job) { job = { id: core.genId('hvac_'), tenantId: ctx.tenant.id, createdAt: now, appointment: null }; d.hvacJobs.push(job); }
    Object.assign(job, { callerName, phone, email: String(b.email || '').trim().slice(0, 180), service: String(b.service || 'General HVAC').trim().slice(0, 80), urgency: String(b.urgency || 'normal').trim().slice(0, 30), outcome, assignedTo: String(b.assignedTo || '').trim().slice(0, 80), notes: String(b.notes || '').trim().slice(0, 2000), updatedAt: now });
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
        if (existing.rowCount > 0) {
          const uRes = await client.query(
            `UPDATE hvac_jobs
             SET outcome = 'booked', updated_at = $1, appointment = $2
             WHERE id = $3 AND tenant_id = $4
             RETURNING *`,
            [now, JSON.stringify(appointment), jobId, ctx.tenant.id]
          );
          job = uRes.rows[0];
        } else {
          const iRes = await client.query(
            `INSERT INTO hvac_jobs (id, tenant_id, caller_name, phone, email, service, urgency, assigned_to, notes, outcome, appointment, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'booked', $10, $11, $12)
             RETURNING *`,
            [jobId, ctx.tenant.id, name, phone, email, String(b.service || 'General HVAC').slice(0, 80), String(b.urgency || 'normal').slice(0, 30), '', '', JSON.stringify(appointment), now, now]
          );
          job = iRes.rows[0];
        }
        await db.addAuditSql(client, ctx, 'hvac.booking.created', 'hvac_job', job.id, { eventTypeId, bookingUid: appointment.calBookingUid || '' });
      });
      return core.sendJson(res, 201, { booking: booking.data, job: publicHvacJob(job) });
    }

    await core.mutate((d) => {
      job = b.jobId ? d.hvacJobs.find((item) => item.id === String(b.jobId) && item.tenantId === ctx.tenant.id) : null;
      if (!job) { job = { id: core.genId('hvac_'), tenantId: ctx.tenant.id, callerName: name, phone, email, service: String(b.service || 'General HVAC').slice(0, 80), urgency: String(b.urgency || 'normal').slice(0, 30), assignedTo: '', notes: '', createdAt: now }; d.hvacJobs.push(job); }
      job.outcome = 'booked'; job.updatedAt = now; job.appointment = appointment;
      addAudit(d, ctx, 'hvac.booking.created', 'hvac_job', job.id, { eventTypeId, bookingUid: job.appointment.calBookingUid || '' });
    });
    core.sendJson(res, 201, { booking: booking.data, job: publicHvacJob(job) });
  } catch (e) { handleProviderError(res, e); }
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
      await client.query(
        'INSERT INTO audit_events (id, tenant_id, user_id, action, resource_type, resource_id, metadata, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [core.genId('au_'), ctx.tenant.id, ctx.user.id, 'demo_link.created', 'demo_link', link.id, { agentId: agent.id, expiresAt: link.expiresAt, maxStarts: link.maxStarts }, new Date().toISOString()]
      );
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
      await client.query(
        'INSERT INTO audit_events (id, tenant_id, user_id, action, resource_type, resource_id, metadata, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [core.genId('au_'), ctx.tenant.id, ctx.user.id, 'demo_link.revoked', 'demo_link', id, { agentId: lRes.rows[0].agent_id }, new Date().toISOString()]
      );
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
    await db.transaction(async (client) => {
      await db.addAuditSql(client, ctx, 'admin.impersonation.started', 'user', target.id, { reason });
    });
    return core.send(res, 200, JSON.stringify({ ok: true, user: publicUser(target), tenant: publicTenant(tenant) }), { 'Content-Type': 'application/json', 'Set-Cookie': core.sessionCookie(token) });
  }

  const target = core.db().users.find((u) => u.id === targetId);
  if (!reason || !target) return core.sendJson(res, 422, { error: 'valid userId and reason required', code: 'bad_impersonation' });
  if (!core.verifyPassword(String(b.password || ''), ctx.user.passHash)) return core.sendJson(res, 401, { error: 'password re-authentication failed', code: 'reauth_failed' });
  if (target.role === 'super_admin' || target.status !== 'active') return core.sendJson(res, 403, { error: 'that account cannot be impersonated', code: 'impersonation_forbidden' });
  const tenant = core.db().tenants.find((t) => t.id === target.tenantId);
  if (!tenant || tenant.status !== 'active') return core.sendJson(res, 409, { error: 'target tenant is not active', code: 'target_inactive' });
  const token = await core.createImpersonationSession(ctx.user.id, target.id, tenant.id, reason);
  await core.mutate((d) => addAudit(d, ctx, 'admin.impersonation.started', 'user', target.id, { reason }));
  core.send(res, 200, JSON.stringify({ ok: true, user: publicUser(target), tenant: publicTenant(tenant) }), { 'Content-Type': 'application/json', 'Set-Cookie': core.sessionCookie(token) });
}

async function apiImpersonationExit(req, res, ctx) {
  if (!ctx.impersonator) return core.sendJson(res, 409, { error: 'not impersonating', code: 'not_impersonating' });
  const actor = ctx.impersonator;

  if (db.isPostgres) {
    const tRes = await db.query('SELECT * FROM tenants WHERE id = $1', [actor.tenantId]);
    const tenant = tRes.rows[0];
    const token = await core.createSession(actor.id, actor.tenantId);
    await db.transaction(async (client) => {
      await db.addAuditSql(client, ctx, 'admin.impersonation.ended', 'user', ctx.user.id);
    });
    return core.send(res, 200, JSON.stringify({ ok: true, user: publicUser(actor), tenant: publicTenant(tenant) }), { 'Content-Type': 'application/json', 'Set-Cookie': core.sessionCookie(token) });
  }

  const tenant = core.db().tenants.find((t) => t.id === actor.tenantId);
  const token = await core.createSession(actor.id, actor.tenantId);
  await core.mutate((d) => addAudit(d, ctx, 'admin.impersonation.ended', 'user', ctx.user.id));
  core.send(res, 200, JSON.stringify({ ok: true, user: publicUser(actor), tenant: publicTenant(tenant) }), { 'Content-Type': 'application/json', 'Set-Cookie': core.sessionCookie(token) });
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

// GET /api/health -> readiness + which provider keys are present.
function apiHealth(req, res) {
  const described = providers.describeProviders();
  const providerHealth = (layer) => Object.fromEntries((described[layer] || []).map((item) => [item.id, item.live]));
  const selected = (layer) => (described[layer] || []).find((item) => item.selected) || (described[layer] || [])[0] || {};
  const selectedStt = selected('stt'); const selectedTts = selected('tts'); const selectedLlm = selected('llm'); const selectedTelephony = selected('telephony');
  core.sendJson(res, 200, {
    ok: true,
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
  const ip = requestRateKey(req);
  const route = (req.url || '/').split('?')[0];

  try {
    if (route.startsWith('/api/')) {
      if (!core.rateOk(ip)) return core.sendJson(res, 429, { error: 'rate limited', code: 'rate' });

      const payuInbound = route === '/api/payu/callback' || route === '/api/payu/webhook' || route === '/api/payu/return';
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method || '') && !payuInbound && !requestOriginAllowed(req)) {
        return core.sendJson(res, 403, { error: 'cross-origin request blocked', code: 'bad_origin' });
      }
      const requestContentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method || '') && !payuInbound && requestContentType && requestContentType !== 'application/json') {
        return core.sendJson(res, 415, { error: 'application/json required', code: 'bad_content_type' });
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

      // ---- Authed GET routes ----
      if (req.method === 'GET') {
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
        if (route === '/api/hvac/desk') return core.requireAuth(req, res, apiHvacDesk);
        if (route === '/api/hvac/event-types') return core.requireAuth(req, res, apiHvacEventTypes);
        if (route === '/api/hvac/slots') return core.requireAuth(req, res, apiHvacSlots);
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
      if (route === '/api/auth/logout') return apiLogout(req, res);
      if (route === '/api/auth/impersonation/exit') return core.requireAuth(req, res, apiImpersonationExit, body);
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
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  PORT ${PORT} is already in use. Stop the other process or set PORT to a free port, for example: PORT=8788 node server.js\n`);
    process.exit(1);
  }
  console.error('  server error:', e.message);
  process.exit(1);
});

// Boot then listen.
boot().then(() => {
  server.listen(PORT, () => {
    const live = providers.describeProviders();
    const flag = (layer, id) => (live[layer].find((p) => p.id === id) || {}).live ? 'ok' : 'MISSING';
    console.log('\n  GetQualify  ready');
    console.log(`  Marketing : http://localhost:${PORT}/`);
    console.log(`  Console   : http://localhost:${PORT}/app.html`);
    if (DEMO_EMAIL) console.log(`  Test login: ${DEMO_EMAIL}`);
    console.log(`  Providers : deepgram ${flag('stt', 'deepgram')}  groq ${flag('llm', 'groq')}  rumik ${flag('tts', 'rumik')}  vobiz ${flag('telephony', 'vobiz')}\n`);
  });
}).catch((e) => {
  console.error('  boot failed:', e.message);
  process.exit(1);
});
