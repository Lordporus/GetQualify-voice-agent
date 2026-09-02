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
      console.log('No db.json found, skipping session migration.');
      return;
    }
    
    const data = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    const sessions = data.sessions || [];
    
    if (sessions.length === 0) {
      console.log('No sessions to migrate.');
      return;
    }

    let migrated = 0;
    for (const s of sessions) {
      try {
        await pool.query(
          `INSERT INTO sessions (token_hash, user_id, tenant_id, exp, impersonator_user_id, impersonation_reason) 
           VALUES ($1, $2, $3, $4, $5, $6) 
           ON CONFLICT (token_hash) DO NOTHING`,
          [s.tokenHash, s.userId, s.tenantId, s.exp, s.impersonatorUserId || null, s.impersonationReason || null]
        );
        migrated++;
      } catch (err) {
        console.error(`Failed to migrate session ${s.tokenHash}:`, err.message);
      }
    }

    console.log(`Successfully migrated ${migrated}/${sessions.length} sessions to PostgreSQL.`);
  } finally {
    await pool.end();
  }
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
