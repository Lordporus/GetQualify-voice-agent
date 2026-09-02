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
      console.log('No db.json found, skipping users/tenants backfill.');
      return;
    }
    
    const data = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    const tenants = data.tenants || [];
    const users = data.users || [];
    
    if (tenants.length === 0 && users.length === 0) {
      console.log('No users or tenants to migrate.');
      return;
    }

    let migratedTenants = 0;
    for (const t of tenants) {
      try {
        await pool.query(
          `INSERT INTO tenants (id, name, slug, branding, providers, plan, status, privacy_mode, created_at) 
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
           ON CONFLICT (id) DO NOTHING`,
          [
            t.id, 
            t.name, 
            t.slug, 
            JSON.stringify(t.branding || {}), 
            JSON.stringify(t.providers || {}), 
            t.plan || 'studio', 
            t.status || 'active', 
            t.privacyMode || t.privacy_mode || 'standard',
            t.createdAt || new Date().toISOString()
          ]
        );
        migratedTenants++;
      } catch (err) {
        console.error(`Failed to migrate tenant ${t.id}:`, err.message);
      }
    }

    let migratedUsers = 0;
    for (const u of users) {
      try {
        await pool.query(
          `INSERT INTO users (id, tenant_id, email, name, pass_hash, role, status, created_at) 
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
           ON CONFLICT (id) DO NOTHING`,
          [
            u.id, 
            u.tenantId || u.tenant_id, 
            u.email, 
            u.name || null, 
            u.passHash || u.pass_hash, 
            u.role || 'member', 
            u.status || 'active',
            u.createdAt || new Date().toISOString()
          ]
        );
        migratedUsers++;
      } catch (err) {
        console.error(`Failed to migrate user ${u.id}:`, err.message);
      }
    }

    console.log(`Successfully migrated ${migratedTenants}/${tenants.length} tenants to PostgreSQL.`);
    console.log(`Successfully migrated ${migratedUsers}/${users.length} users to PostgreSQL.`);
  } finally {
    await pool.end();
  }
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
