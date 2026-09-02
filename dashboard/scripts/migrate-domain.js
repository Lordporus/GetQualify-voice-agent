'use strict';

/**
 * Migration Script: Domain-specific entities (Task 5)
 * Migrates presets, byon_connections, hvac_jobs, hvac_settings,
 * integration_requests, agency_prompts, and usage from data/db.json
 * into PostgreSQL tables.
 *
 * Requirements:
 * - Safe & idempotent: ON CONFLICT DO NOTHING for all entities
 * - Strict FK ordering: validates parent tenant_id exists before inserting child records
 * - Transactional per entity type: Rollback on error per batch
 * - Graceful logging of progress and errors
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/postgres';
const pool = new Pool({ connectionString });
const dbPath = path.join(__dirname, '../data/db.json');

async function run() {
  if (!fs.existsSync(dbPath)) {
    console.log('No data/db.json found, skipping domain migration.');
    await pool.end();
    return;
  }

  const raw = fs.readFileSync(dbPath, 'utf8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.error('Failed to parse db.json:', err.message);
    await pool.end();
    process.exit(1);
  }

  const presets = data.presets || [];
  const byonConnections = data.byonConnections || data.byon_connections || [];
  const hvacJobs = data.hvacJobs || data.hvac_jobs || [];
  const hvacSettings = data.hvacSettings || data.hvac_settings || [];
  const integrationRequests = data.integrationRequests || data.integration_requests || [];
  const agencyPrompts = data.agencyPrompts || data.agency_prompts || [];
  const usage = data.usage || [];

  console.log('Starting Domain-Specific migration:');
  console.log(`  Found ${presets.length} presets in db.json`);
  console.log(`  Found ${byonConnections.length} BYON connections in db.json`);
  console.log(`  Found ${hvacJobs.length} HVAC jobs in db.json`);
  console.log(`  Found ${hvacSettings.length} HVAC settings in db.json`);
  console.log(`  Found ${integrationRequests.length} integration requests in db.json`);
  console.log(`  Found ${agencyPrompts.length} agency prompts in db.json`);
  console.log(`  Found ${usage.length} usage records in db.json`);

  const client = await pool.connect();

  try {
    // Cache valid tenant IDs
    const tenantsRes = await client.query('SELECT id FROM tenants');
    const validTenantIds = new Set(tenantsRes.rows.map((r) => r.id));

    // Cache valid user IDs
    const usersRes = await client.query('SELECT id FROM users');
    const validUserIds = new Set(usersRes.rows.map((r) => r.id));

    // -------------------------------------------------------------------------
    // 1. Presets
    // -------------------------------------------------------------------------
    let migratedPresets = 0;
    let skippedPresets = 0;

    await client.query('BEGIN');
    for (const p of presets) {
      if (!p.id || !p.name) {
        skippedPresets++;
        continue;
      }
      const isSystem = Boolean(p.isSystem || p.is_system);
      const tenantId = p.tenantId || p.tenant_id || null;

      if (tenantId && !validTenantIds.has(tenantId)) {
        skippedPresets++;
        continue;
      }

      const res = await client.query(
        `INSERT INTO presets (id, tenant_id, slug, name, category, version, is_system, greeting, persona, fields, guardrails, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (id) DO NOTHING`,
        [
          p.id,
          tenantId,
          p.slug || null,
          p.name,
          p.category || null,
          p.version || 1,
          isSystem,
          p.greeting || null,
          p.persona || null,
          JSON.stringify(p.fields || []),
          JSON.stringify(p.guardrails || []),
          p.createdAt || new Date().toISOString(),
        ]
      );
      if (res.rowCount > 0) migratedPresets++;
      else skippedPresets++;
    }
    await client.query('COMMIT');
    console.log(`✓ Presets: migrated ${migratedPresets}, skipped ${skippedPresets}`);

    // -------------------------------------------------------------------------
    // 2. BYON Connections
    // -------------------------------------------------------------------------
    let migratedByon = 0;
    let skippedByon = 0;

    await client.query('BEGIN');
    for (const b of byonConnections) {
      const tenantId = b.tenantId || b.tenant_id;
      if (!b.id || !tenantId || !b.provider || !b.address) {
        skippedByon++;
        continue;
      }
      if (!validTenantIds.has(tenantId)) {
        skippedByon++;
        continue;
      }
      const createdBy = b.createdBy || b.created_by;
      const validCreatedBy = createdBy && validUserIds.has(createdBy) ? createdBy : null;

      const res = await client.query(
        `INSERT INTO byon_connections (id, tenant_id, provider, address, label, status, credentials, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO NOTHING`,
        [
          b.id,
          tenantId,
          b.provider,
          b.address,
          b.label || null,
          b.status || 'pending_verification',
          JSON.stringify(b.credentials || {}),
          validCreatedBy,
          b.createdAt || new Date().toISOString(),
        ]
      );
      if (res.rowCount > 0) migratedByon++;
      else skippedByon++;
    }
    await client.query('COMMIT');
    console.log(`✓ BYON Connections: migrated ${migratedByon}, skipped ${skippedByon}`);

    // -------------------------------------------------------------------------
    // 3. HVAC Jobs
    // -------------------------------------------------------------------------
    let migratedHvacJobs = 0;
    let skippedHvacJobs = 0;

    await client.query('BEGIN');
    for (const j of hvacJobs) {
      const tenantId = j.tenantId || j.tenant_id;
      if (!j.id || !tenantId) {
        skippedHvacJobs++;
        continue;
      }
      if (!validTenantIds.has(tenantId)) {
        skippedHvacJobs++;
        continue;
      }

      const res = await client.query(
        `INSERT INTO hvac_jobs (id, tenant_id, caller_name, phone, email, service, urgency, outcome, assigned_to, notes, appointment, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (id) DO NOTHING`,
        [
          j.id,
          tenantId,
          j.callerName || j.caller_name || null,
          j.phone || null,
          j.email || null,
          j.service || 'General HVAC',
          j.urgency || 'normal',
          j.outcome || 'new',
          j.assignedTo || j.assigned_to || null,
          j.notes || null,
          j.appointment ? JSON.stringify(j.appointment) : null,
          j.createdAt || new Date().toISOString(),
          j.updatedAt || j.createdAt || new Date().toISOString(),
        ]
      );
      if (res.rowCount > 0) migratedHvacJobs++;
      else skippedHvacJobs++;
    }
    await client.query('COMMIT');
    console.log(`✓ HVAC Jobs: migrated ${migratedHvacJobs}, skipped ${skippedHvacJobs}`);

    // -------------------------------------------------------------------------
    // 4. HVAC Settings
    // -------------------------------------------------------------------------
    let migratedHvacSettings = 0;
    let skippedHvacSettings = 0;

    await client.query('BEGIN');
    for (const s of hvacSettings) {
      const tenantId = s.tenantId || s.tenant_id;
      if (!tenantId || !validTenantIds.has(tenantId)) {
        skippedHvacSettings++;
        continue;
      }

      const res = await client.query(
        `INSERT INTO hvac_settings (tenant_id, settings, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id) DO NOTHING`,
        [
          tenantId,
          JSON.stringify(s.settings || {}),
          s.updatedAt || new Date().toISOString(),
        ]
      );
      if (res.rowCount > 0) migratedHvacSettings++;
      else skippedHvacSettings++;
    }
    await client.query('COMMIT');
    console.log(`✓ HVAC Settings: migrated ${migratedHvacSettings}, skipped ${skippedHvacSettings}`);

    // -------------------------------------------------------------------------
    // 5. Integration Requests
    // -------------------------------------------------------------------------
    let migratedIntReq = 0;
    let skippedIntReq = 0;

    await client.query('BEGIN');
    for (const r of integrationRequests) {
      const tenantId = r.tenantId || r.tenant_id;
      if (!r.id || !tenantId || (!r.integrationId && !r.integration_id)) {
        skippedIntReq++;
        continue;
      }
      if (!validTenantIds.has(tenantId)) {
        skippedIntReq++;
        continue;
      }
      const createdBy = r.createdBy || r.created_by;
      const validCreatedBy = createdBy && validUserIds.has(createdBy) ? createdBy : null;

      const res = await client.query(
        `INSERT INTO integration_requests (id, tenant_id, integration_id, status, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING`,
        [
          r.id,
          tenantId,
          r.integrationId || r.integration_id,
          r.status || 'requested',
          validCreatedBy,
          r.createdAt || new Date().toISOString(),
        ]
      );
      if (res.rowCount > 0) migratedIntReq++;
      else skippedIntReq++;
    }
    await client.query('COMMIT');
    console.log(`✓ Integration Requests: migrated ${migratedIntReq}, skipped ${skippedIntReq}`);

    // -------------------------------------------------------------------------
    // 6. Agency Prompts
    // -------------------------------------------------------------------------
    let migratedPrompts = 0;
    let skippedPrompts = 0;

    await client.query('BEGIN');
    for (const ap of agencyPrompts) {
      const tenantId = ap.tenantId || ap.tenant_id;
      if (!tenantId || !ap.text) {
        skippedPrompts++;
        continue;
      }
      if (!validTenantIds.has(tenantId)) {
        skippedPrompts++;
        continue;
      }
      const updatedBy = ap.updatedBy || ap.updated_by;
      const validUpdatedBy = updatedBy && validUserIds.has(updatedBy) ? updatedBy : null;

      const res = await client.query(
        `INSERT INTO agency_prompts (tenant_id, text, version, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id) DO NOTHING`,
        [
          tenantId,
          ap.text,
          ap.version || 1,
          validUpdatedBy,
          ap.updatedAt || new Date().toISOString(),
        ]
      );
      if (res.rowCount > 0) migratedPrompts++;
      else skippedPrompts++;
    }
    await client.query('COMMIT');
    console.log(`✓ Agency Prompts: migrated ${migratedPrompts}, skipped ${skippedPrompts}`);

    // -------------------------------------------------------------------------
    // 7. Usage
    // -------------------------------------------------------------------------
    let migratedUsage = 0;
    let skippedUsage = 0;

    await client.query('BEGIN');
    for (const u of usage) {
      const tenantId = u.tenantId || u.tenant_id;
      if (!tenantId || !u.day) {
        skippedUsage++;
        continue;
      }
      if (!validTenantIds.has(tenantId)) {
        skippedUsage++;
        continue;
      }

      const res = await client.query(
        `INSERT INTO usage (tenant_id, day, chars, calls, llm_tokens)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, day) DO NOTHING`,
        [
          tenantId,
          u.day,
          Number(u.chars || 0),
          Number(u.calls || 0),
          Number(u.llmTokens || u.llm_tokens || 0),
        ]
      );
      if (res.rowCount > 0) migratedUsage++;
      else skippedUsage++;
    }
    await client.query('COMMIT');
    console.log(`✓ Usage: migrated ${migratedUsage}, skipped ${skippedUsage}`);

    console.log('Domain-Specific migration completed successfully.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  run().catch((err) => {
    console.error('Fatal error during migration:', err);
    process.exit(1);
  });
}

module.exports = { run };
