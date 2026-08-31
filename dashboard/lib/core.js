/**
 * GetQualify Voice. Core runtime primitives. ZERO npm dependencies.
 *
 * One file, pure Node. It gives the rest of the server everything that is not
 * provider specific:
 *   - a tiny .env loader (no dotenv)
 *   - http helpers (send, sendJson, readBody, httpsPost, httpsGet)
 *   - a multi-tenant JSON store over data/db.json with ATOMIC writes and a
 *     serial write queue (no torn files, no lost updates under concurrency)
 *   - auth: scrypt password hashing, opaque session tokens, the rxv_sess cookie,
 *     getSession + requireAuth (tenant scoped)
 *   - a per-IP token-bucket rate limiter
 *   - a static file server with MIME mapping and a path-traversal guard
 *   - htmlEscape for safe DOM injection
 *
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const http = require('http');   // referenced for typing clarity, server.js owns createServer
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Project root is one level up from lib/.
const ROOT = path.join(__dirname, '..');

/* ==========================================================================
   1. .env loader (no dotenv dependency)
   Reads ROOT/.env once. Existing process.env wins, so real shell vars override.
   ========================================================================== */
function loadEnv() {
  try {
    const txt = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch (_) {
    // .env is optional when the vars are already in the environment.
  }
}

/* ==========================================================================
   2. http helpers
   ========================================================================== */

// Security headers applied to every response.
const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
  'Strict-Transport-Security': 'max-age=31536000',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=(self), payment=()',
  'Content-Security-Policy-Report-Only': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' https: wss:; frame-src 'self' https:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self' https://secure.payu.in https://test.payu.in",
};

function send(res, status, body, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { ...BASE_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json' });
}

/**
 * Read and JSON-parse a request body with a hard size cap. Resolves {} for an
 * empty body. Rejects on oversize payloads or invalid JSON so callers can map
 * to a clean 4xx instead of crashing.
 */
function readBody(req, cap = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let len = 0;
    const chunks = [];
    req.on('data', (c) => {
      len += c.length;
      if (len > cap) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

// Generic HTTPS POST. Resolves { status, headers, buffer }. Times out at 60s.
function httpsPost(host, pathname, headers, bodyBuf) {
  return new Promise((resolve, reject) => {
    const r = https.request({ host, path: pathname, method: 'POST', headers }, (resp) => {
      const parts = [];
      resp.on('data', (d) => parts.push(d));
      resp.on('end', () => resolve({
        status: resp.statusCode,
        headers: resp.headers,
        buffer: Buffer.concat(parts),
      }));
    });
    r.on('error', reject);
    r.setTimeout(60000, () => r.destroy(new Error('upstream timeout')));
    if (bodyBuf) r.write(bodyBuf);
    r.end();
  });
}

// Generic HTTPS GET. Resolves { status, headers, buffer }. Times out at 20s.
function httpsGet(host, pathname, headers) {
  return new Promise((resolve, reject) => {
    const r = https.request({ host, path: pathname, method: 'GET', headers }, (resp) => {
      const parts = [];
      resp.on('data', (d) => parts.push(d));
      resp.on('end', () => resolve({
        status: resp.statusCode,
        headers: resp.headers,
        buffer: Buffer.concat(parts),
      }));
    });
    r.on('error', reject);
    r.setTimeout(20000, () => r.destroy(new Error('upstream timeout')));
    r.end();
  });
}

/* ==========================================================================
   3. htmlEscape (XSS guard for any user string injected into the DOM)
   ========================================================================== */
function htmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ==========================================================================
   4. Multi-tenant JSON store over data/db.json
   - Lazy load once into memory, cached.
   - Corrupt or missing file falls back to a clean default (try/catch).
   - ATOMIC writes: serialize to data/db.json.tmp then fs.renameSync into place,
     so a crash mid-write never leaves a half file.
   - A serial write queue funnels every mutation through one promise chain so
     two concurrent requests cannot clobber each other (last-write-wins is the
     bug we are preventing: each write reads-modifies-writes under the lock).
   ========================================================================== */

const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = process.env.GETQUALIFY_DB_FILE ? path.resolve(process.env.GETQUALIFY_DB_FILE) : path.join(DATA_DIR, 'db.json');
const DB_TMP = `${DB_FILE}.tmp`;

function defaultDb() {
  return {
    schemaVersion: 4,
    tenants: [], users: [], agents: [], usage: [], sessions: [],
    wallets: [], ledger: [], paymentIntents: [], supportTickets: [],
    supportMessages: [], auditEvents: [], presets: [], byonConnections: [],
    hvacJobs: [], hvacSettings: [], paymentEvents: [], demoLinks: [],
    invoices: [], invoiceEvents: [], integrationRequests: [], agencyPrompts: [],
    clientActivities: [], tenantStatusEvents: [],
  };
}

const COLLECTIONS = [
  'tenants', 'users', 'agents', 'usage', 'sessions', 'wallets', 'ledger',
  'paymentIntents', 'supportTickets', 'supportMessages', 'auditEvents',
  'presets', 'byonConnections', 'hvacJobs', 'hvacSettings', 'paymentEvents', 'demoLinks',
  'invoices', 'invoiceEvents', 'integrationRequests', 'agencyPrompts',
  'clientActivities', 'tenantStatusEvents',
];

function migrateDb(parsed) {
  const out = Object.assign(defaultDb(), parsed || {});
  for (const k of COLLECTIONS) if (!Array.isArray(out[k])) out[k] = [];
  out.schemaVersion = 4;
  for (const tenant of out.tenants) {
    if (!tenant.status) tenant.status = 'active';
    if (!tenant.privacyMode) tenant.privacyMode = 'standard';
  }
  for (const user of out.users) {
    if (!['super_admin', 'admin', 'owner', 'member'].includes(user.role)) user.role = 'member';
    if (!user.status) user.status = 'active';
  }
  return out;
}

let _db = null;        // in-memory cache
let _writeChain = Promise.resolve(); // serial queue tail

function ensureDataDir() {
  try { fs.mkdirSync(path.dirname(DB_FILE), { recursive: true }); } catch (_) { }
}

// Load db.json into memory. On a missing or corrupt file, return a fresh default
// (the caller is expected to seed and persist).
function loadDb() {
  if (_db) return _db;
  ensureDataDir();
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    // Defensive: guarantee every collection exists even if the file is partial.
    _db = migrateDb(parsed);
  } catch (_) {
    _db = defaultDb();
  }
  return _db;
}

// Synchronous atomic flush of the current in-memory db to disk.
function flushSync() {
  ensureDataDir();
  const json = JSON.stringify(_db, null, 2);
  fs.writeFileSync(DB_TMP, json, { mode: 0o600 });
  fs.chmodSync(DB_TMP, 0o600);
  fs.renameSync(DB_TMP, DB_FILE);
  fs.chmodSync(DB_FILE, 0o600);
}

/**
 * Run a mutation against the db under the serial write lock.
 * `fn(db)` receives the live in-memory db, may mutate it, and may return a value
 * which becomes the resolved value of the returned promise. The db is flushed
 * atomically after fn runs. Errors inside fn reject without flushing a partial.
 */
function mutate(fn) {
  const run = () => new Promise((resolve, reject) => {
    try {
      const db = loadDb();
      const out = fn(db);
      flushSync();
      resolve(out);
    } catch (e) {
      reject(e);
    }
  });
  // Chain onto the tail so writes execute one at a time, in order. We swallow
  // the previous result/error for the chain itself but surface this run's own
  // result to the caller.
  const next = _writeChain.then(run, run);
  _writeChain = next.catch(() => { });
  return next;
}

// Read-only snapshot accessor (no lock needed, callers must not mutate it).
function db() {
  return loadDb();
}

/* ==========================================================================
   5. Auth: scrypt password hashing, sessions, cookie, requireAuth
   ========================================================================== */

// Password hash format: scrypt$<saltHex>$<hashHex>
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

// Constant-time verify against the stored scrypt$salt$hash string.
function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, hashHex] = String(stored).split('$');
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(password), salt, expected.length);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch (_) {
    return false;
  }
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const COOKIE_NAME = 'rxv_sess';

// Create a session row for a user, persist it, return the opaque token.
async function createSession(userId, tenantId) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const exp = Date.now() + SESSION_TTL_MS;
  await mutate((d) => {
    // Prune any already-expired sessions while we are here (cheap housekeeping).
    d.sessions = d.sessions.filter((s) => s.exp > Date.now());
    d.sessions.push({ tokenHash, userId, tenantId, exp });
  });
  return token;
}

const IMPERSONATION_TTL_MS = 30 * 60 * 1000;

async function createImpersonationSession(actorUserId, targetUserId, targetTenantId, reason) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const exp = Date.now() + IMPERSONATION_TTL_MS;
  await mutate((d) => {
    d.sessions = d.sessions.filter((s) => s.exp > Date.now());
    d.sessions.push({ tokenHash, userId: targetUserId, tenantId: targetTenantId, exp, impersonatorUserId: actorUserId, impersonationReason: String(reason || '').slice(0, 240) });
  });
  return token;
}

// Build the Set-Cookie header value for a fresh session.
function sessionCookie(token) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure}`;
}

// Build the Set-Cookie header value that clears the session.
function clearCookie() {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${secure}`;
}

// Parse the request cookie header for our session token.
function parseCookieToken(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (k === COOKIE_NAME) return part.slice(idx + 1).trim();
  }
  return '';
}

/**
 * Resolve the session for a request. Returns { session, user, tenant } when the
 * cookie maps to a live, unexpired session whose user and tenant still exist.
 * A tampered or expired cookie resolves to null (treated as no session).
 * Expired sessions are removed as a side effect.
 */
async function getSession(req) {
  const token = parseCookieToken(req);
  if (!token || token.length < 16) return null;
  const d = db();
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const session = d.sessions.find((s) => s.tokenHash === tokenHash || s.token === token);
  if (!session) return null;
  if (session.exp <= Date.now()) {
    // Expired: drop it so the next request is clean.
    await mutate((dd) => {
      dd.sessions = dd.sessions.filter((s) => s.token !== token && s.tokenHash !== tokenHash);
    });
    return null;
  }
  const user = d.users.find((u) => u.id === session.userId);
  const tenant = d.tenants.find((t) => t.id === session.tenantId);
  if (!user || !tenant || user.status !== 'active' || tenant.status !== 'active') return null;
  const impersonator = session.impersonatorUserId ? d.users.find((u) => u.id === session.impersonatorUserId && u.status === 'active') : null;
  if (session.impersonatorUserId && (!impersonator || impersonator.role !== 'super_admin')) return null;
  return { session, user, tenant, impersonator };
}

// Remove a session by token (logout).
async function destroySession(req) {
  const token = parseCookieToken(req);
  if (!token) return;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await mutate((d) => { d.sessions = d.sessions.filter((s) => s.token !== token && s.tokenHash !== tokenHash); });
}

const ROLE_LEVEL = { member: 1, owner: 2, admin: 3, super_admin: 4 };
function hasRole(user, minimum) {
  return (ROLE_LEVEL[user && user.role] || 0) >= (ROLE_LEVEL[minimum] || 99);
}

async function requireRole(req, res, minimum, handler, body) {
  return requireAuth(req, res, (r, s, ctx) => {
    if (!hasRole(ctx.user, minimum)) return sendJson(s, 403, { error: 'insufficient role', code: 'forbidden' });
    return handler(r, s, ctx);
  }, body);
}

/**
 * Gate a handler behind auth. Resolves the session; on success calls
 * handler(req, res, ctx) where ctx = { user, tenant, session, body }. On a
 * missing or invalid session, replies 401 and clears any stale cookie.
 * Every authed route is therefore tenant scoped via ctx.tenant.id.
 */
async function requireAuth(req, res, handler, body) {
  const ctx = await getSession(req);
  if (!ctx) {
    return send(res, 401, JSON.stringify({ error: 'authentication required', code: 'no_session' }), {
      'Content-Type': 'application/json',
      'Set-Cookie': clearCookie(),
    });
  }
  return handler(req, res, { ...ctx, body });
}

/* ==========================================================================
   6. Per-IP token-bucket rate limiter (90 req / 60s, refilling)
   ========================================================================== */
const _buckets = new Map();
function rateOk(ip, capacity = 90, perMinute = 90) {
  const now = Date.now();
  let b = _buckets.get(ip);
  if (!b) { b = { tokens: capacity, ts: now }; _buckets.set(ip, b); }
  b.tokens = Math.min(capacity, b.tokens + ((now - b.ts) / 60000) * perMinute);
  b.ts = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

/* ==========================================================================
   7. Static file server with MIME map + path-traversal guard
   ========================================================================== */
const PUBLIC_DIR = path.join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res) {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  // Resolve against PUBLIC_DIR and verify the result stays inside it. This
  // catches .., encoded traversal, and absolute escapes in one check.
  const resolved = path.normalize(path.join(PUBLIC_DIR, p));
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
    return send(res, 400, 'bad path');
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      // Single-page app and marketing both live as real files, so a 404 here is
      // a genuine missing asset. Keep it plain.
      return send(res, 404, 'not found');
    }
    send(res, 200, data, {
      'Content-Type': MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
  });
}

/* ==========================================================================
   8. id helper
   ========================================================================== */
function genId(prefix) {
  return prefix + crypto.randomBytes(8).toString('hex');
}

module.exports = {
  ROOT, DATA_DIR, DB_FILE, PUBLIC_DIR,
  loadEnv,
  send, sendJson, readBody, httpsPost, httpsGet,
  htmlEscape,
  db, mutate, loadDb, defaultDb, migrateDb,
  hashPassword, verifyPassword,
  createSession, createImpersonationSession, destroySession, getSession, requireAuth, requireRole, hasRole,
  sessionCookie, clearCookie, COOKIE_NAME,
  rateOk,
  serveStatic, MIME,
  genId,
};
