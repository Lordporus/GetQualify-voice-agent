'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/postgres';

const pool = new Pool({ connectionString });
const dbPath = path.join(__dirname, '../data/db.json');

async function run() {
  try {
    if (!fs.existsSync(dbPath)) {
      console.log('No db.json found, skipping agents/demoLinks migration.');
      return;
    }
    
    const data = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    const agents = data.agents || [];
    const demoLinks = data.demoLinks || data.demo_links || [];
    
    if (agents.length === 0 && demoLinks.length === 0) {
      console.log('No agents or demoLinks to migrate.');
      return;
    }

    let migratedAgents = 0;
    for (const a of agents) {
      try {
        await pool.query(
          `INSERT INTO agents (id, tenant_id, name, persona, tts, greeting, telephony, preset_id, created_at) 
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
           ON CONFLICT (id) DO NOTHING`,
          [
            a.id, 
            a.tenantId || a.tenant_id, 
            a.name, 
            a.persona || null, 
            JSON.stringify(a.tts || {}), 
            a.greeting || null, 
            JSON.stringify(a.telephony || {}), 
            a.presetId || a.preset_id || null,
            a.createdAt || new Date().toISOString()
          ]
        );
        migratedAgents++;
      } catch (err) {
        console.error(`Failed to migrate agent ${a.id}:`, err.message);
      }
    }

    let migratedDemoLinks = 0;
    for (const d of demoLinks) {
      try {
        await pool.query(
          `INSERT INTO demo_links (id, token_hash, tenant_id, agent_id, label, status, starts, max_starts, max_session_seconds, expires_at, revoked_at, revoked_by, created_by, created_at) 
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) 
           ON CONFLICT (id) DO NOTHING`,
          [
            d.id,
            d.tokenHash || d.token_hash || d.id, // Fallback if somehow missing
            d.tenantId || d.tenant_id,
            d.agentId || d.agent_id,
            d.label || 'Demo Link',
            d.status || 'active',
            d.starts || 0,
            d.maxStarts || d.max_starts || 25,
            d.maxSessionSeconds || d.max_session_seconds || 300,
            d.expiresAt || d.expires_at || null,
            d.revokedAt || d.revoked_at || null,
            d.revokedBy || d.revoked_by || null,
            d.createdBy || d.created_by || null,
            d.createdAt || new Date().toISOString()
          ]
        );
        migratedDemoLinks++;
      } catch (err) {
        console.error(`Failed to migrate demo link ${d.id}:`, err.message);
      }
    }

    console.log(`Successfully migrated ${migratedAgents}/${agents.length} agents to PostgreSQL.`);
    console.log(`Successfully migrated ${migratedDemoLinks}/${demoLinks.length} demo links to PostgreSQL.`);
  } finally {
    await pool.end();
  }
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
