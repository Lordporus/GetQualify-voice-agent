'use strict';

/**
 * Migration Script: Admin & Support entities (Task 4)
 * Migrates tenants, users, support_tickets, support_messages, and audit_events
 * from data/db.json into PostgreSQL tables.
 *
 * Requirements:
 * - Safe & idempotent: Avoids duplicate id, slug, and email collisions
 * - Strict FK ordering: tenants -> users -> support_tickets -> support_messages -> audit_events
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
    console.log('No data/db.json found, skipping admin & support migration.');
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

  const tenants = data.tenants || [];
  const users = data.users || [];
  const supportTickets = data.supportTickets || data.support_tickets || [];
  const supportMessages = data.supportMessages || data.support_messages || [];
  const auditEvents = data.auditEvents || data.audit_events || [];

  console.log(`Starting Admin & Support migration:`);
  console.log(`  Found ${tenants.length} tenants in db.json`);
  console.log(`  Found ${users.length} users in db.json`);
  console.log(`  Found ${supportTickets.length} support tickets in db.json`);
  console.log(`  Found ${supportMessages.length} support messages in db.json`);
  console.log(`  Found ${auditEvents.length} audit events in db.json`);

  const client = await pool.connect();

  try {
    // -------------------------------------------------------------------------
    // 1. Tenants (ensure neither id nor unique slug conflict)
    // -------------------------------------------------------------------------
    let migratedTenants = 0;
    let skippedTenants = 0;
    await client.query('BEGIN');
    try {
      for (const t of tenants) {
        if (!t.id || !t.name || !t.slug) continue;
        const res = await client.query(
          `INSERT INTO tenants (id, name, slug, branding, providers, plan, status, privacy_mode, last_approached_at, created_at)
           SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
           WHERE NOT EXISTS (SELECT 1 FROM tenants WHERE id = $1 OR slug = $3)`,
          [
            t.id,
            t.name,
            t.slug,
            JSON.stringify(t.branding || {}),
            JSON.stringify(t.providers || {}),
            t.plan || 'studio',
            t.status || 'active',
            t.privacyMode || 'standard',
            t.lastApproachedAt || null,
            t.createdAt || new Date().toISOString()
          ]
        );
        if (res.rowCount > 0) migratedTenants++;
        else skippedTenants++;
      }
      await client.query('COMMIT');
      console.log(`[tenants] Migrated ${migratedTenants} new record(s), ${skippedTenants} existing/skipped.`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[tenants] Batch failed, transaction rolled back:', err.message);
      throw err;
    }

    // -------------------------------------------------------------------------
    // 2. Users (ensure neither id nor unique email conflict, and tenant exists)
    // -------------------------------------------------------------------------
    let migratedUsers = 0;
    let skippedUsers = 0;
    await client.query('BEGIN');
    try {
      for (const u of users) {
        if (!u.id || !u.email || !u.passHash) continue;
        const res = await client.query(
          `INSERT INTO users (id, tenant_id, email, name, pass_hash, role, status, created_at)
           SELECT $1, $2, $3, $4, $5, $6, $7, $8
           WHERE NOT EXISTS (SELECT 1 FROM users WHERE id = $1 OR email = $3)
           AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM tenants WHERE id = $2))`,
          [
            u.id,
            u.tenantId || null,
            u.email,
            u.name || null,
            u.passHash,
            u.role || 'member',
            u.status || 'active',
            u.createdAt || new Date().toISOString()
          ]
        );
        if (res.rowCount > 0) migratedUsers++;
        else skippedUsers++;
      }
      await client.query('COMMIT');
      console.log(`[users] Migrated ${migratedUsers} new record(s), ${skippedUsers} existing/skipped.`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[users] Batch failed, transaction rolled back:', err.message);
      throw err;
    }

    // -------------------------------------------------------------------------
    // 3. Support Tickets (FK to tenant)
    // -------------------------------------------------------------------------
    let migratedTickets = 0;
    let skippedTickets = 0;
    await client.query('BEGIN');
    try {
      for (const tic of supportTickets) {
        if (!tic.id || !tic.tenantId || !tic.subject) continue;
        const res = await client.query(
          `INSERT INTO support_tickets (id, tenant_id, subject, status, priority, assigned_to, created_by, created_at, updated_at)
           SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9
           WHERE NOT EXISTS (SELECT 1 FROM support_tickets WHERE id = $1)
           AND EXISTS (SELECT 1 FROM tenants WHERE id = $2)`,
          [
            tic.id,
            tic.tenantId,
            tic.subject,
            tic.status || 'open',
            tic.priority || 'normal',
            tic.assignedTo || null,
            tic.createdBy || null,
            tic.createdAt || new Date().toISOString(),
            tic.updatedAt || new Date().toISOString()
          ]
        );
        if (res.rowCount > 0) migratedTickets++;
        else skippedTickets++;
      }
      await client.query('COMMIT');
      console.log(`[support_tickets] Migrated ${migratedTickets} new record(s), ${skippedTickets} existing/skipped.`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[support_tickets] Batch failed, transaction rolled back:', err.message);
      throw err;
    }

    // -------------------------------------------------------------------------
    // 4. Support Messages (FK to support_tickets)
    // -------------------------------------------------------------------------
    let migratedMessages = 0;
    let skippedMessages = 0;
    await client.query('BEGIN');
    try {
      for (const msg of supportMessages) {
        if (!msg.id || !msg.ticketId || !msg.body) continue;
        const res = await client.query(
          `INSERT INTO support_messages (id, ticket_id, user_id, body, created_at)
           SELECT $1, $2, $3, $4, $5
           WHERE NOT EXISTS (SELECT 1 FROM support_messages WHERE id = $1)
           AND EXISTS (SELECT 1 FROM support_tickets WHERE id = $2)`,
          [
            msg.id,
            msg.ticketId,
            msg.authorUserId || msg.userId || null,
            msg.body,
            msg.createdAt || new Date().toISOString()
          ]
        );
        if (res.rowCount > 0) migratedMessages++;
        else skippedMessages++;
      }
      await client.query('COMMIT');
      console.log(`[support_messages] Migrated ${migratedMessages} new record(s), ${skippedMessages} existing/skipped.`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[support_messages] Batch failed, transaction rolled back:', err.message);
      throw err;
    }

    // -------------------------------------------------------------------------
    // 5. Audit Events (FK to tenants)
    // -------------------------------------------------------------------------
    let migratedAudit = 0;
    let skippedAudit = 0;
    await client.query('BEGIN');
    try {
      for (const aud of auditEvents) {
        if (!aud.id || !aud.tenantId || !aud.action) continue;
        const res = await client.query(
          `INSERT INTO audit_events (id, tenant_id, actor_user_id, subject_user_id, action, target_type, target_id, metadata, created_at)
           SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9
           WHERE NOT EXISTS (SELECT 1 FROM audit_events WHERE id = $1)
           AND EXISTS (SELECT 1 FROM tenants WHERE id = $2)`,
          [
            aud.id,
            aud.tenantId,
            aud.actorUserId || null,
            aud.subjectUserId || null,
            aud.action,
            aud.targetType || null,
            aud.targetId || null,
            JSON.stringify(aud.metadata || {}),
            aud.createdAt || new Date().toISOString()
          ]
        );
        if (res.rowCount > 0) migratedAudit++;
        else skippedAudit++;
      }
      await client.query('COMMIT');
      console.log(`[audit_events] Migrated ${migratedAudit} new record(s), ${skippedAudit} existing/skipped.`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[audit_events] Batch failed, transaction rolled back:', err.message);
      throw err;
    }

    console.log('Admin & Support migration completed successfully.');
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error('Fatal migration error:', err);
  process.exit(1);
});
