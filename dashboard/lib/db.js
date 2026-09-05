'use strict';

const crypto = require('crypto');

// DB_DRIVER=postgres  -> uses pg, requires DATABASE_URL
// DB_DRIVER=json (or unset) -> isPostgres=false, pool is never created,
//   requiring this file never crashes. Calling query()/transaction() in json
//   mode throws explicitly so the caller knows it hit the wrong path.
function checkIsPostgres() {
  return process.env.DB_DRIVER === 'postgres';
}

let Pool = null;
let pool = null;

function init() {
  if (pool) return;
  if (!checkIsPostgres()) return; // json mode: do nothing

  if (!Pool) {
    Pool = require('pg').Pool;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required when DB_DRIVER=postgres');
  }

  pool = new Pool({
    connectionString,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });

  pool.on('error', (err) => {
    // Log but do not crash — let the next query surface the error naturally.
    console.error('pg pool idle client error:', err.message);
  });
}

// ---------------------------------------------------------------------------
// Private helper — used by the SQL helpers below only.
// ---------------------------------------------------------------------------
function _genId(prefix) {
  return `${prefix}${crypto.randomBytes(12).toString('hex')}`;
}

// Converts Postgres snake_case column names to JS camelCase.
// Applied automatically to every row returned by query().
// Exported so callers inside db.transaction() can use it manually on
// client.query() results if needed.
function camelize(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const dest = {};
  for (const key of Object.keys(obj)) {
    const camel = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    dest[camel] = obj[key];
  }
  return dest;
}

/**
 * Executes a parameterized SQL query.
 * Returns { rows: camelCased[], rowCount }.
 * Throws immediately if called in json mode.
 *
 * @param {string} text   - SQL string with $1, $2 ... placeholders
 * @param {any[]}  params - Bound parameter values (default: [])
 */
async function query(text, params = []) {
  if (!checkIsPostgres()) throw new Error('db.query() called but DB_DRIVER is not "postgres"');
  if (!pool) init();

  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    if (process.env.NODE_ENV !== 'production') {
      console.log('[db]', text.slice(0, 80), { ms: Date.now() - start, rows: res.rowCount });
    }
    res.rows = res.rows.map(camelize);
    return res;
  } catch (err) {
    console.error('[db] query error:', { text: text.slice(0, 120), err: err.message });
    throw err;
  }
}

/**
 * Wraps an async callback in a single Postgres transaction.
 * The callback receives a raw pg PoolClient. All queries on that client
 * share the transaction. Commits on success, rolls back on any throw.
 *
 * NOTE: client.query() results are NOT auto-camelCased. Use camelize()
 * manually inside the callback if you need it.
 *
 * @param {(client: import('pg').PoolClient) => Promise<any>} callback
 */
async function transaction(callback) {
  if (!checkIsPostgres()) throw new Error('db.transaction() called but DB_DRIVER is not "postgres"');
  if (!pool) init();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Inserts a ledger entry and updates the wallet balance inside an existing
 * pg transaction client.
 *
 * Order of operations:
 *  1. Idempotency check FIRST — return null immediately if key already used,
 *     skip the lock/insert entirely.
 *  2. Lock wallet row with FOR UPDATE (or create wallet if missing).
 *  3. Validate that the balance will not go negative.
 *  4. UPDATE wallet balance.
 *  5. INSERT ledger row.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} tenantId
 * @param {number} amountPaise   - positive = credit, negative = debit
 * @param {string} type          - e.g. 'trial_grant', 'payment_credit'
 * @param {string} reference     - idempotency key (e.g. 'trial:t_abc')
 * @param {string} actorUserId
 * @param {object} metadata      - arbitrary JSON stored in the ledger row
 * @returns {Promise<object|null>} - ledger row, or null on duplicate key
 */
async function addLedgerEntrySql(client, tenantId, amountPaise, type, reference, actorUserId, metadata = {}) {
  const key = String(reference || '');

  // 1. Idempotency check — skip everything if this key already exists.
  if (key) {
    const dupe = await client.query(
      'SELECT 1 FROM ledger WHERE tenant_id = $1 AND idempotency_key = $2',
      [tenantId, key]
    );
    if (dupe.rowCount > 0) {
      console.log('[ledger] Duplicate key skipped:', key);
      return null;
    }
  }

  // 2. Lock or create wallet.
  let wallet = (await client.query(
    'SELECT * FROM wallets WHERE tenant_id = $1 FOR UPDATE',
    [tenantId]
  )).rows[0];

  if (!wallet) {
    const wid = _genId('w_');
    const now = new Date().toISOString();
    await client.query(
      'INSERT INTO wallets (id, tenant_id, currency, balance_paise, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [wid, tenantId, 'INR', 0, now, now]
    );
    wallet = (await client.query(
      'SELECT * FROM wallets WHERE tenant_id = $1 FOR UPDATE',
      [tenantId]
    )).rows[0];
  }

  const currentPaise = Number(wallet.balance_paise);
  const newPaise     = currentPaise + amountPaise;

  // 3. Prevent negative balance.
  if (newPaise < 0) {
    throw Object.assign(
      new Error(`insufficient balance: have ${currentPaise}p, need ${Math.abs(amountPaise)}p`),
      { statusCode: 402, code: 'low_balance' }
    );
  }

  // 4. Update wallet.
  await client.query(
    'UPDATE wallets SET balance_paise = $1, updated_at = $2 WHERE id = $3',
    [newPaise, new Date().toISOString(), wallet.id]
  );

  // 5. Insert ledger row.
  const ledgerId = _genId('led_');
  const now      = new Date().toISOString();
  const res = await client.query(
    `INSERT INTO ledger
       (id, tenant_id, amount_paise, type, idempotency_key, balance_after_paise, actor_user_id, metadata, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [ledgerId, tenantId, amountPaise, type, key || null, newPaise, actorUserId, JSON.stringify(metadata), now]
  );
  return camelize(res.rows[0]);
}

/**
 * Inserts an audit event inside an existing pg transaction client.
 *
 * @param {import('pg').PoolClient} client
 * @param {object} ctx        - { tenant: { id }, user: { id }, impersonator?: { id } }
 * @param {string} action     - e.g. 'auth.signup', 'agent.create'
 * @param {string} targetType  - e.g. 'tenant'
 * @param {string} targetId
 * @param {object} metadata
 */
async function addAuditSql(client, ctx, action, targetType, targetId, metadata = {}) {
  const tenantId      = ctx.tenant.id;
  const actorUserId   = ctx.impersonator ? ctx.impersonator.id : ctx.user.id;
  const subjectUserId = ctx.impersonator ? ctx.user.id : null;
  const id  = _genId('aud_');
  const now = new Date().toISOString();
  await client.query(
    `INSERT INTO audit_events
       (id, tenant_id, actor_user_id, subject_user_id, action, target_type, target_id, metadata, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, tenantId, actorUserId, subjectUserId, action, targetType, targetId, JSON.stringify(metadata), now]
  );
}

async function health(deep = false) {
  if (!checkIsPostgres()) {
    return { driver: 'json', ok: true };
  }
  if (!pool) {
    try {
      init();
    } catch (err) {
      return { driver: 'postgres', ok: false, error: err.message };
    }
  }
  if (!pool) {
    return { driver: 'postgres', ok: false, error: 'Pool uninitialized' };
  }
  if (!deep) {
    return { driver: 'postgres', ok: true };
  }
  try {
    const res = await pool.query('SELECT 1 AS ok');
    return { driver: 'postgres', ok: res.rows[0].ok === 1 };
  } catch (err) {
    return { driver: 'postgres', ok: false, error: err.message };
  }
}

module.exports = {
  get isPostgres() {
    return checkIsPostgres();
  },
  camelize,
  query,
  transaction,
  addLedgerEntrySql,
  addAuditSql,
  health
};
