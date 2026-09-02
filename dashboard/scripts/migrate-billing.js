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
      console.log('No db.json found, skipping billing migration.');
      return;
    }

    const data = JSON.parse(fs.readFileSync(dbPath, 'utf8'));

    const wallets = data.wallets || [];
    const ledger = data.ledger || [];
    const paymentIntents = data.paymentIntents || data.payment_intents || [];
    const paymentEvents = data.paymentEvents || data.payment_events || [];

    console.log(`Found ${wallets.length} wallets, ${ledger.length} ledger entries, ${paymentIntents.length} payment intents, ${paymentEvents.length} payment events`);

    if (wallets.length === 0 && ledger.length === 0 && paymentIntents.length === 0 && paymentEvents.length === 0) {
      console.log('No billing data to migrate.');
      return;
    }

    let migratedWallets = 0;
    let migratedLedger = 0;
    let migratedIntents = 0;
    let migratedEvents = 0;

    // Migrate wallets first (referenced by other tables)
    for (const w of wallets) {
      try {
        await pool.query(
          `INSERT INTO wallets (id, tenant_id, currency, balance_paise, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (id) DO NOTHING`,
          [
            w.id,
            w.tenantId || w.tenant_id,
            w.currency || 'INR',
            w.balancePaise || w.balance_paise || 0,
            w.createdAt || new Date().toISOString(),
            w.updatedAt || new Date().toISOString()
          ]
        );
        migratedWallets++;
      } catch (err) {
        console.error(`Failed to migrate wallet ${w.id}:`, err.message);
      }
    }

    // Migrate ledger entries
    for (const l of ledger) {
      try {
        await pool.query(
          `INSERT INTO ledger (id, tenant_id, type, amount_paise, balance_after_paise, idempotency_key, actor_user_id, metadata, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (id) DO NOTHING`,
          [
            l.id,
            l.tenantId || l.tenant_id,
            l.type,
            l.amountPaise || l.amount_paise,
            l.balanceAfterPaise || l.balance_after_paise,
            l.idempotencyKey || l.idempotency_key || null,
            l.actorUserId || l.actor_user_id || null,
            JSON.stringify(l.metadata || {}),
            l.createdAt || new Date().toISOString()
          ]
        );
        migratedLedger++;
      } catch (err) {
        console.error(`Failed to migrate ledger entry ${l.id}:`, err.message);
      }
    }

    // Migrate payment intents
    for (const p of paymentIntents) {
      try {
        await pool.query(
          `INSERT INTO payment_intents (id, tenant_id, amount_paise, currency, pack_id, status, txnid, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (id) DO NOTHING`,
          [
            p.id,
            p.tenantId || p.tenant_id,
            p.amountPaise || p.amount_paise || 0,
            p.currency || 'INR',
            p.packId || p.pack_id || null,
            p.status || 'created',
            p.txnid || null,
            p.createdAt || new Date().toISOString()
          ]
        );
        migratedIntents++;
      } catch (err) {
        console.error(`Failed to migrate payment intent ${p.id}:`, err.message);
      }
    }

    // Migrate payment events
    for (const e of paymentEvents) {
      try {
        await pool.query(
          `INSERT INTO payment_events (id, provider, tenant_id, payment_intent_id, txnid, status, reason, payload, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (id) DO NOTHING`,
          [
            e.id,
            e.provider || null,
            e.tenantId || e.tenant_id,
            e.paymentIntentId || e.payment_intent_id || null,
            e.txnid || null,
            e.status || null,
            e.reason || null,
            JSON.stringify(e.payload || {}),
            e.createdAt || new Date().toISOString()
          ]
        );
        migratedEvents++;
      } catch (err) {
        console.error(`Failed to migrate payment event ${e.id}:`, err.message);
      }
    }

    console.log(`Successfully migrated ${migratedWallets}/${wallets.length} wallets to PostgreSQL.`);
    console.log(`Successfully migrated ${migratedLedger}/${ledger.length} ledger entries to PostgreSQL.`);
    console.log(`Successfully migrated ${migratedIntents}/${paymentIntents.length} payment intents to PostgreSQL.`);
    console.log(`Successfully migrated ${migratedEvents}/${paymentEvents.length} payment events to PostgreSQL.`);
  } finally {
    await pool.end();
  }
}

run().catch(err => {
  console.error('Billing migration failed:', err);
  process.exit(1);
});
